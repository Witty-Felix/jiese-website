# ADR 0005 — 附件改为浏览器直传 COS（prepare → 直传 → finalize）

日期：2026-09-25
状态：已接受（取代 ADR-0001 中的服务端转传路径）

## 背景

上线后用户反馈上传慢。实测（15MB 附件，本机 → 线上站）：

- 浏览器/客户端 → Cloudflare 边缘：约 1 秒（很快）
- 服务端转传 → COS（ap-shanghai）：20~38 秒（瓶颈，且波动大）

根因：双重转传。中国用户访问 `pages.dev` 常被调度到远端 PoP，Function 在该 PoP 再把大文件跨网推到上海 COS，单流长距离传输吞吐低。并行化三链路（已做）只能部分缓解，不能根治。

## 决策

把大文件字节从 Function 路径中拿掉，改为浏览器直传 COS 三步流：

1. **`POST /api/prepare`**：校验昵称/邀请码/类型/体积 → `create_media` ×2 → 服务端用临时凭证**预签名** PUT 的 Authorization 头 → 下发 `{media_id, cos_url, authorization, token}`（不泄露任何长期密钥，凭证 12h 自动过期）。
2. **浏览器直传**：XHR PUT 到 COS（并行两文件，合并进度条）。COS bucket 实测 CORS 开放：`Access-Control-Allow-Origin: *`，允许 `PUT` 与 `authorization / x-cos-security-token` 头。
3. **`POST /api/finalize`**：校验回执（media_id 前缀、cos_key 格式、体积）→ `add_knowledge` ×2 + 笔记链路（并行）→ KV 统计。

原 `checkin.js`（multipart 服务端转传）删除。

## 理由

- 字节路径变为「用户 → 上海 COS」国内直连，预期从 ~30s 降到数秒；
- 顺带解除 Cloudflare 免费版 ~100MB 请求体限制，录音上限放宽到 ima 上限 200MB；
- 前端可获得真实的字节级上传进度。

## 已知取舍与风险

- finalize 的回执只做格式校验（media_id 前缀 / cos_key 字符集 / 体积），不回查 COS——持邀请码者本就可任意打卡，威胁等级不变；如需加固，prepare 改发 HMAC 票据即可（升级路径）。
- 直传中途失败需整单重试，会在 COS 留下孤儿对象（由 ima 侧生命周期管理，量大再说）。
- 若 ima 未来收紧 bucket CORS，此架构失效——届时回退 ADR-0001 转传路径（保留在 `_ima.js` 的 `cosUpload`）。
