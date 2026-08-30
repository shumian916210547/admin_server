"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { config } = require("../config/env");
const { HttpError } = require("../lib/http-error");

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME_TYPE = "text/csv";
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_HEADER = 0x06054b50;
const MAX_ZIP_ENTRIES = 500;
const MAX_UNCOMPRESSED_BYTES = Math.min(
  Math.max(config.collab.maxFileBytes * 8, 128 * 1024 * 1024),
  512 * 1024 * 1024
);
const storageRoot = path.resolve(config.collab.storageDir);
const temporaryRoot = path.join(storageRoot, ".tmp");

/**
 * 文档容量设置支持的二进制单位；数值最终统一按字节写入 PostgreSQL，避免前端单位换算绕过配额校验。
 * @type {Readonly<Record<"B" | "KB" | "MB" | "GB", number>>}
 */
const STORAGE_LIMIT_UNIT_MULTIPLIERS = Object.freeze({
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
});

/**
 * 限制单文档容量配置的最大值，既支持 GB 级文档，也避免客户端把 bigint 字段设置成无界资源额度。
 * @type {number}
 */
const MAX_DOCUMENT_STORAGE_LIMIT_BYTES = 1024 ** 4;

/**
 * 返回协同文件临时目录并确保目录存在；目录与普通用户附件存储隔离。
 * @returns {string} 协同文件临时目录的绝对路径。
 * @throws {Error} 目录创建失败时抛出。
 */
function getTemporaryDirectory() {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  return temporaryRoot;
}

/**
 * 将文档容量请求转换为安全的字节数；结构化输入使用 value/unit，数字输入仅作为内部字节数兼容格式。
 * @param {unknown} value 文档容量配置；可为 null（清除上限）、{ value: number, unit: "KB" | "MB" | "GB" } 或字节数。
 * @returns {number | null | undefined} 字节上限；请求未提供字段返回 undefined，显式清除返回 null。
 * @throws {import("../lib/http-error").HttpError} 单位、数值、最小值或最大值不符合要求时抛出 400。
 */
function normalizeStorageLimit(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  let amount = value;
  let unit = "B";
  if (typeof value === "object" && !Array.isArray(value)) {
    amount = value.value;
    unit = String(value.unit || "").trim().toUpperCase();
  }

  if (typeof amount === "string") {
    const normalizedAmount = amount.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalizedAmount)) {
      throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量必须是正数，最多保留两位小数");
    }
    amount = Number(normalizedAmount);
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量必须是正数");
  }
  if (Math.round(amount * 100) !== amount * 100) {
    throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量最多保留两位小数");
  }
  const multiplier = STORAGE_LIMIT_UNIT_MULTIPLIERS[unit];
  if (!multiplier) throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量单位只能是 KB、MB 或 GB");
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < STORAGE_LIMIT_UNIT_MULTIPLIERS.KB) {
    throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量不能小于 1 KB");
  }
  if (bytes > MAX_DOCUMENT_STORAGE_LIMIT_BYTES) {
    throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量不能超过 1 TB");
  }
  return bytes;
}

/**
 * 校验待保存的工作簿是否不超过文档级容量上限；未设置文档上限时仍由系统单文件上限保护。
 * @param {{storage_limit_bytes?: number | string | null} | number | string | null} documentOrLimit 文档行或已规范化的字节上限。
 * @param {number} fileSizeBytes 待保存文件大小，单位为字节。
 * @returns {void} 文件大小在文档容量范围内时正常返回。
 * @throws {import("../lib/http-error").HttpError} 文件大小非法或超过文档上限时抛出 400/413。
 */
function assertDocumentFileSizeWithinLimit(documentOrLimit, fileSizeBytes) {
  const limitValue = typeof documentOrLimit === "object" && documentOrLimit !== null
    ? documentOrLimit.storage_limit_bytes
    : documentOrLimit;
  const fileSize = Number(fileSizeBytes);
  const limit = limitValue === null || limitValue === undefined ? null : Number(limitValue);
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文件大小无效");
  }
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < STORAGE_LIMIT_UNIT_MULTIPLIERS.KB)) {
    throw new HttpError(400, "COLLAB_STORAGE_LIMIT_INVALID", "文档容量上限无效");
  }
  if (limit !== null && fileSize > limit) {
    throw new HttpError(413, "COLLAB_STORAGE_LIMIT_EXCEEDED", "文件大小超过当前文档容量上限，请调整上限或选择更小的文件");
  }
}

/**
 * 将对象键限制为服务端生成的 POSIX 相对路径，防止路径穿越和访问存储根目录之外的文件。
 * @param {unknown} objectKey 协同文件对象键。
 * @returns {string} 规范化后的对象键。
 * @throws {import("../lib/http-error").HttpError} 对象键为空、含回退片段或格式不安全时抛出 400。
 */
function normalizeObjectKey(objectKey) {
  if (typeof objectKey !== "string" || !objectKey || objectKey.length > 512) {
    throw new HttpError(400, "COLLAB_STORAGE_KEY_INVALID", "协同文件对象键无效");
  }
  const normalized = objectKey.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    !/^documents\/[a-f0-9-]+\/(?:sources|versions|exports)\/[a-f0-9-]+\.(?:xlsx|csv)$/i.test(normalized)
  ) {
    throw new HttpError(400, "COLLAB_STORAGE_KEY_INVALID", "协同文件对象键无效");
  }
  return normalized;
}

/**
 * 将受信任对象键解析为文件路径，并再次验证其位于协同存储根目录内。
 * @param {string} objectKey 已通过 normalizeObjectKey 的对象键。
 * @returns {string} 文件绝对路径。
 * @throws {import("../lib/http-error").HttpError} 解析结果越出存储根目录时抛出 403。
 */
function resolveObjectPath(objectKey) {
  const normalized = normalizeObjectKey(objectKey);
  const filePath = path.resolve(storageRoot, ...normalized.split("/"));
  const rootPrefix = `${storageRoot}${path.sep}`;
  if (!filePath.startsWith(rootPrefix)) {
    throw new HttpError(403, "COLLAB_STORAGE_PATH_DENIED", "协同文件路径无效");
  }
  return filePath;
}

/**
 * 为指定文档生成不包含原始文件名的随机对象键。
 * @param {string} documentId 已由服务端生成并校验的文档 UUID。
 * @param {string} extension 文件扩展名，仅允许 xlsx 或 csv。
 * @param {"sources" | "versions" | "exports"} [folder="sources"] 对象用途目录。
 * @returns {string} 可持久化到数据库的协同对象键。
 * @throws {import("../lib/http-error").HttpError} 扩展名或文档标识不符合服务端格式时抛出 400。
 */
function createObjectKey(documentId, extension, folder = "sources") {
  if (!/^[a-f0-9-]{36}$/i.test(documentId) || !["xlsx", "csv"].includes(extension)) {
    throw new HttpError(400, "COLLAB_STORAGE_KEY_INVALID", "协同文件对象键参数无效");
  }
  if (!["sources", "versions", "exports"].includes(folder)) {
    throw new HttpError(400, "COLLAB_STORAGE_KEY_INVALID", "协同文件目录无效");
  }
  return `documents/${documentId}/${folder}/${crypto.randomUUID()}.${extension}`;
}

/**
 * 计算文件内容 SHA-256，供版本幂等和恢复校验使用。
 * @param {Buffer} buffer 文件内容缓冲区。
 * @returns {string} 小写十六进制 SHA-256 摘要。
 */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * 计算 ZIP 条目名称对应的安全属性，拒绝宏、外部链接、可执行文件和路径穿越条目。
 * @param {string} entryName ZIP 中央目录记录的原始条目名。
 * @returns {void} 名称安全时正常返回。
 * @throws {import("../lib/http-error").HttpError} 条目名为空、越界或含高风险内容时抛出 400。
 */
function assertSafeZipEntryName(entryName) {
  const normalized = entryName.replace(/\\/g, "/");
  const lowerName = normalized.toLowerCase();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..") ||
    lowerName.includes("vbaproject") ||
    lowerName.includes("externallinks") ||
    /\.(?:exe|dll|com|bat|cmd|ps1|vbs|js|hta)$/i.test(lowerName)
  ) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "文件包含不允许的宏、外部链接或可执行内容");
  }
}

/**
 * 读取 ZIP 中央目录并检查条目数量、解压总大小和关键 Office 文件，防止 ZIP Bomb 与伪造压缩包进入存储。
 * @param {Buffer} buffer 上传文件的完整内容，大小已先受 COLLAB_MAX_FILE_BYTES 限制。
 * @returns {void} 文件通过 ZIP 结构与内容风险检查时正常返回。
 * @throws {import("../lib/http-error").HttpError} ZIP 结构损坏、条目过多、解压超限或内容不符合 xlsx 时抛出 400。
 */
function validateXlsxZip(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 文件头无效");
  }

  const minimumEndOffset = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (offset >= 0 && buffer.readUInt32LE(offset) === ZIP_END_HEADER) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > buffer.length) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 压缩包结构无效");
  }

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entryCount === 0 ||
    entryCount > MAX_ZIP_ENTRIES ||
    centralOffset + centralSize > buffer.length
  ) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 压缩包范围或条目数量无效");
  }

  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  const entryNames = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 中央目录结构无效");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const recordEnd = nameEnd + extraLength + commentLength;
    if (recordEnd > buffer.length) {
      throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 条目范围无效");
    }
    const entryName = buffer.toString("utf8", nameStart, nameEnd);
    assertSafeZipEntryName(entryName);
    if (entryNames.has(entryName)) {
      throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 包含重复文件条目");
    }
    entryNames.add(entryName);
    if (![0, 8].includes(compressionMethod)) {
      throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "xlsx 使用了不支持的压缩方式");
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES || compressedSize > buffer.length) {
      throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "文件解压后大小超过安全限制");
    }
    offset = recordEnd;
  }

  if (!entryNames.has("[Content_Types].xml") || !entryNames.has("xl/workbook.xml")) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "文件不是有效的 xlsx 工作簿");
  }
}

/**
 * 校验协同导入文件的扩展名、MIME、文件头、压缩结构和宏风险。
 * @param {string} filePath 临时上传文件的绝对路径。
 * @param {string} originalName 浏览器提交的原始文件名，仅用于判断格式，不会写入对象键。
 * @param {string} mimeType 浏览器声明的 MIME 类型，服务端仍以文件头为准。
 * @returns {Promise<{extension: "xlsx" | "csv", mimeType: string, sizeBytes: number}>} 文件格式与大小摘要。
 * @throws {import("../lib/http-error").HttpError} 文件过大、扩展名/MIME 不匹配或内容检查失败时抛出 400。
 */
async function validateSpreadsheetFile(filePath, originalName, mimeType) {
  if (typeof originalName !== "string" || originalName.length > 255 || /[\u0000-\u001f\u007f]/.test(originalName)) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "文件名包含不允许的字符");
  }
  const extension = path.extname(originalName).toLowerCase().slice(1);
  const normalizedMimeType = String(mimeType || "").toLowerCase().trim();
  if (!extension || !["xlsx", "csv"].includes(extension)) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "仅支持 xlsx 或 csv 文件");
  }
  if (
    (extension === "xlsx" && normalizedMimeType !== XLSX_MIME_TYPE) ||
    (extension === "csv" && ![CSV_MIME_TYPE, "application/csv", "text/plain"].includes(normalizedMimeType))
  ) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "文件类型与扩展名不匹配");
  }

  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > config.collab.maxFileBytes) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "文件大小超过协同表格限制");
  }
  const buffer = await fs.promises.readFile(filePath);
  if (extension === "xlsx") {
    validateXlsxZip(buffer);
  } else if (buffer.includes(0)) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "CSV 文件包含二进制内容");
  }
  return { extension, mimeType: extension === "xlsx" ? XLSX_MIME_TYPE : CSV_MIME_TYPE, sizeBytes: buffer.length };
}

/**
 * 将临时上传文件复制到随机协同对象键，并返回可用于版本记录的摘要。
 * @param {string} filePath 已通过 multer 写入的临时文件路径。
 * @param {string} originalName 客户端原始文件名，仅决定白名单扩展名。
 * @param {string} mimeType 客户端声明 MIME，必须与白名单扩展名匹配。
 * @param {string} documentId 目标文档 UUID。
 * @param {"sources" | "versions" | "exports"} [folder="sources"] 对象用途目录。
 * @returns {Promise<{objectKey: string, sha256: string, sizeBytes: number, extension: "xlsx" | "csv", mimeType: string}>} 新对象摘要。
 * @throws {import("../lib/http-error").HttpError} 文件不安全、目标路径无效或写入失败时抛出。
 */
async function storeUploadedFile(filePath, originalName, mimeType, documentId, folder = "sources") {
  const summary = await validateSpreadsheetFile(filePath, originalName, mimeType);
  const buffer = await fs.promises.readFile(filePath);
  const objectKey = createObjectKey(documentId, summary.extension, folder);
  await writeObject(objectKey, buffer);
  return { objectKey, sha256: sha256(buffer), sizeBytes: buffer.length, ...summary };
}

/**
 * 以临时文件加原子重命名方式写入协同对象，避免进程中断留下半个工作簿。
 * @param {string} objectKey 服务端生成的对象键。
 * @param {Buffer} buffer 文件内容，大小不得超过协同文件限制。
 * @returns {Promise<void>} 文件写入并原子替换完成后兑现。
 * @throws {import("../lib/http-error").HttpError} 内容超限或路径不安全时抛出；文件系统错误原样抛出。
 */
async function writeObject(objectKey, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > config.collab.maxFileBytes) {
    throw new HttpError(400, "COLLAB_IMPORT_REJECTED", "协同文件大小超过限制");
  }
  const destination = resolveObjectPath(objectKey);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = path.join(getTemporaryDirectory(), crypto.randomUUID());
  try {
    await fs.promises.writeFile(temporaryPath, buffer, { flag: "wx" });
    await fs.promises.rename(temporaryPath, destination);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

/**
 * 读取协同对象内容；调用方必须已完成文档 ACL 校验或 Office 签名校验。
 * @param {string} objectKey 服务端存储的对象键。
 * @returns {Promise<Buffer>} 对象内容。
 * @throws {import("../lib/http-error").HttpError} 对象不存在时抛出 404；路径错误时抛出 400/403。
 */
async function readObject(objectKey) {
  const filePath = resolveObjectPath(objectKey);
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "COLLAB_FILE_NOT_FOUND", "协同文件不存在");
    throw error;
  }
}

/**
 * 返回协同对象的文件路径，供 Express 受控发送文件；不暴露给浏览器或日志。
 * @param {string} objectKey 服务端存储的对象键。
 * @returns {Promise<string>} 已确认存在的绝对文件路径。
 * @throws {import("../lib/http-error").HttpError} 对象不存在或路径不安全时抛出。
 */
async function getExistingObjectPath(objectKey) {
  const filePath = resolveObjectPath(objectKey);
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    return filePath;
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "COLLAB_FILE_NOT_FOUND", "协同文件不存在");
    throw error;
  }
}

/**
 * 删除协同对象；删除不存在的文件视为幂等成功，便于数据库事务失败后的清理。
 * @param {string | undefined} objectKey 待删除对象键；为空时不执行操作。
 * @returns {Promise<void>} 删除完成后兑现。
 * @throws {Error} 文件系统删除失败且不是文件不存在时抛出。
 */
async function removeObject(objectKey) {
  if (!objectKey) return;
  const filePath = resolveObjectPath(objectKey);
  await fs.promises.unlink(filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * 生成最小合法 xlsx 工作簿，使新建空白文档即使尚未接入 Office 服务也有受控源文件。
 * @returns {Buffer} 包含一个空白 Sheet1 的 xlsx ZIP 内容。
 */
function createBlankWorkbookBuffer() {
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`],
  ].map(([name, content]) => ({ name, data: Buffer.from(content) }));
  return createZip(files);
}

/**
 * 计算 CRC-32，供内置 xlsx ZIP 生成器写入标准 ZIP 头。
 * @param {Buffer} buffer 待计算内容。
 * @returns {number} 无符号 CRC-32 数值。
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 使用 Node 内置压缩能力生成只包含受信 XML 的 ZIP 文件，不引入浏览器 XLSX 解析依赖。
 * @param {Array<{name: string, data: Buffer}>} files 待打包文件列表。
 * @returns {Buffer} 标准 ZIP 文件内容。
 */
function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = zlib.deflateRawSync(file.data, { level: 6 });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc32(file.data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += header.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_HEADER, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/**
 * 创建并保存一个空白 xlsx 源文件，供新建文档和初始版本使用。
 * @param {string} documentId 目标文档 UUID。
 * @returns {Promise<{objectKey: string, sha256: string, sizeBytes: number, extension: "xlsx", mimeType: string}>} 初始文件摘要。
 * @throws {Error} 文件生成或受控存储写入失败时抛出。
 */
async function createBlankWorkbook(documentId) {
  const buffer = createBlankWorkbookBuffer();
  const objectKey = createObjectKey(documentId, "xlsx");
  await writeObject(objectKey, buffer);
  return {
    objectKey,
    sha256: sha256(buffer),
    sizeBytes: buffer.length,
    extension: "xlsx",
    mimeType: XLSX_MIME_TYPE,
  };
}

/**
 * 根据对象键扩展名返回受控下载 MIME，不接受客户端传入的 Content-Type。
 * @param {string} objectKey 已验证的协同对象键。
 * @returns {string} xlsx 或 csv 的固定 MIME 类型。
 */
function mimeTypeForObjectKey(objectKey) {
  return objectKey.toLowerCase().endsWith(".csv") ? CSV_MIME_TYPE : XLSX_MIME_TYPE;
}

module.exports = {
  XLSX_MIME_TYPE,
  CSV_MIME_TYPE,
  STORAGE_LIMIT_UNIT_MULTIPLIERS,
  MAX_DOCUMENT_STORAGE_LIMIT_BYTES,
  getTemporaryDirectory,
  normalizeStorageLimit,
  assertDocumentFileSizeWithinLimit,
  normalizeObjectKey,
  createObjectKey,
  sha256,
  validateSpreadsheetFile,
  storeUploadedFile,
  writeObject,
  readObject,
  getExistingObjectPath,
  removeObject,
  createBlankWorkbook,
  mimeTypeForObjectKey,
};
