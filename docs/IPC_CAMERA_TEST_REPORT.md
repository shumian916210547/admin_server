# IPC 摄像头功能验证记录

本报告记录基础接入阶段的17组回归；当前独立模块的27组最终验收、并发额度和最新入口见 [最终验证记录](CAMERA_WORKSPACE_TEST_REPORT.md)。

验证日期：2026-10-23。使用真实 PostgreSQL、内部 Parse Server、两个临时隔离 Company 和随机临时账号；视频源为本机 FFmpeg 测试图案 + MediaMTX，ONVIF 与 Profile G 录像服务由测试 HTTP/RTSP 设备模拟。未使用真实摄像头账号或录像。

最终媒体回归使用经发行站 SHA-256 校验的 FFmpeg 9.0.2、MediaMTX 1.21.2 和本机 Edge，17 组全部通过。

## 已验证

`npm run test:camera`（配置本机 FFmpeg/MediaMTX），以及 `CAMERA_TEST_BROWSER=1` 的 Edge/Playwright 回归共覆盖以下 17 组：

1. 私网 CIDR、同设备 ONVIF 服务地址、RTSP 路径与编码控制字符边界。
2. AES-256-GCM 随机 IV、凭据往返解密与密文篡改拒绝。
3. 历史录像时间必须含时区、单次最多一小时。
4. RTSP 任意分包重组与 TCP interleaved RTP 二进制透传。
5. Profile G RTSP 桥注入 UTC `Range: clock`、`Require: onvif-replay` 并针对远端 URI 重算 Digest。
6. 真实 BFF 未登录拦截、CSRF 拦截、只读岗位写入拒绝、跨企业访问拒绝与伪造 `companyId` 无效。
7. 名称修改、编辑空密码保留、列表及详情不回传密码和密文。
8. 封面文件签名白名单、私有访问与清除封面。
9. 服务器录像列表与受权限保护的 HTTP Range 206 回放。
10. 异常退出残留的未完成段、闲置流目录与超过保留期的完整录像清理。
11. 真实 RTSP → FFmpeg → H.264 HLS 清单和 TS 片段产出，创建用户/其他用户/其他租户/匿名访问区分。
12. 关闭播放会话后释放进程、删除临时文件、旧 URL 不可用。
13. ONVIF WS-Security + HTTP Digest 媒体配置与 Profile G token 查询；保留 token 前导零并正确解码 RTSP 查询中的 `&amp;`。
14. 模拟 Profile G `GetReplayUri` → 本地 RTSP 回放桥 → FFmpeg → HLS 全链路。
15. 后台持续录像任务生成完整 H.264 MP4，并出现在回放列表。
16. 真实浏览器解码服务器生成的 MP4 录像。
17. 真实浏览器动态菜单装配、配置对话框密码不回显、390px 窄屏无横向溢出。

每轮 finally 关闭测试媒体、移除测试公司下创建的设备、会话与导航元数据，删除本轮临时目录。测试用 MediaMTX 在临时工作目录运行，避免在项目根目录生成证书或密钥。

## 质量检查

- 后端 `npm run check`、`npm run security:check` 通过。
- 前端 `npm run security:check`、`npm run build` 通过。构建保留项目既有包体积和 Browserslist 提示。
- 前后端 `git diff --check` 通过，未覆盖工作区已有主题、表单、协同表格及后端 Office 配置修改。
- `npm run audit:prod` 未通过：后端报告 26 项（11 moderate、14 high、1 critical），前端 6 项（1 moderate、5 high），涉及既有 Parse Server、Axios、Vue 等依赖链。新增 HLS.js 和直接升级的 fast-xml-parser 未出现在本轮漏洞条目中。未执行可能降级 Parse Server 的 `audit fix --force`。

## 验证限制

- 未完成真实萤石、大华、海康、小米具体型号/固件的硬件验收，不能将模拟通过解释为所有型号兼容。
- Profile G 测试验证协议、认证、时间范围传递和媒体封装；模拟录像源不验证真实 SD 卡录像时段的精确定位。
- 海康、大华厂商路径按公开本地 RTSP 回放格式实现，需目标 NVR/IPC 实测通道、时区与录像权限。
- WS-Discovery 的真实发现数量受网卡、多播、防火墙、VLAN 与设备发现开关影响；回归脚本不扫描真实局域网。
- 尚未验证多天磁盘压力、多实例分配、专业 NVR 连续无缺口录像或大规模摄像头 CPU 性能。当前运行约束为单 BFF、默认最多 8 个媒体任务。

## 当前开发环境

已执行 IPC 迁移，在本机 `.env` 生成独立设备密钥，并配置本地 FFmpeg；机密及可执行文件均位于忽略路径，不写入版本库。开发 BFF 已重启，实际管理员企业补齐了 `system.camera` Route。通过无接口拦截的真实浏览器确认 `/system/camera` 页面加载成功。实际调用设备列表与发现 API 均返回 200，目前已关联 0 台，WS-Discovery 收到 0 台设备回复；此结果不代表局域网不存在摄像头，仍需检查设备发现开关/网络或手动填写本地协议地址。

部署与操作步骤见 [IPC 摄像头接入指南](IPC_CAMERA_GUIDE.md)。
