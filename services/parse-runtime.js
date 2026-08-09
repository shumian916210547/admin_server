const path = require("path");
const Parse = require("parse/node");
const { ParseServer } = require("parse-server");
const { config } = require("../config/env");

let initialized = false;

function initializeParse() {
  if (initialized) return Parse;

  Parse.initialize(config.parse.appId);
  Parse.masterKey = config.parse.masterKey;
  Parse.serverURL = config.parse.serverUrl;

  // Legacy cloud code still resolves Parse through the global namespace. The
  // value is process-local and never reaches the browser.
  global.Parse = Parse;
  global._require = (filePath) => require(path.resolve(process.cwd(), filePath));
  initialized = true;
  return Parse;
}

function createParseServer() {
  initializeParse();

  return new ParseServer({
    databaseURI: config.parse.databaseUri,
    cloud: path.resolve(process.cwd(), "cloud.js"),
    appId: config.parse.appId,
    masterKey: config.parse.masterKey,
    masterKeyIps: ["127.0.0.1", "::1"],
    readOnlyMasterKeyIps: ["127.0.0.1", "::1"],
    serverURL: config.parse.serverUrl,
    directAccess: false,
    enforcePrivateUsers: true,
    allowClientClassCreation: false,
    maxUploadSize: `${Math.ceil(config.upload.maxBytes / 1024 / 1024)}mb`,
    fileUpload: { allowedFileUrlDomains: [] },
    pages: { encodePageParamHeaders: true },
    requestComplexity: {
      includeDepth: 5,
      includeCount: 20,
      subqueryDepth: 5,
      queryDepth: 5,
      graphQLDepth: 10,
      graphQLFields: 100,
      batchRequestLimit: 20,
    },
    protectedFieldsOwnerExempt: false,
    protectedFieldsTriggerExempt: true,
    protectedFieldsSaveResponseExempt: false,
    installation: { duplicateDeviceTokenActionEnforceAuth: true },
    allowAggregationForReadOnlyMasterKey: false,
    accountLockout: {
      duration: 15,
      threshold: 5,
      unlockOnPasswordReset: true,
    },
  });
}

module.exports = { initializeParse, createParseServer };
