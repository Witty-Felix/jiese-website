# ADR 0014 — 按上传通道区分音频体积契约

日期：2026-10-04
状态：已接受
关联：GitHub issue #30、issue #2

## 背景

同一套 `prepare` / `finalize` 接口会被既有 H5 和后续微信小程序客户端使用。H5 已经支持不超过 200 MiB 的录音；微信小程序路径读取单个临时文件并以一个 `ArrayBuffer` 直传，采用更小的 100 MiB 上限。为了兼容旧 H5，不能把所有客户端统一收紧到 100 MiB，也不能让拼写错误的通道悄悄走 H5 默认值。

## 决策

- H5 省略 `channel`，音频上限为 `200 * 1024 * 1024` 字节，边界包含在内。
- 微信小程序必须发送精确的 `channel: "wechat-miniprogram"`，音频上限为 `100 * 1024 * 1024` 字节，边界包含在内。
- 其他通道值一律返回 `400 上传通道标识无效`。
- `prepare` 和 `finalize` 使用同一份 `_upload-contract.js` 常量与错误文案。
- `prepare` 超限在创建 `submission_id` 和调用 `create_media` 之前拒绝；`finalize` 超限在读取提交状态和任何登记副作用之前拒绝。
- 通道标识绑定到 `submission_id`；重交必须继续使用原通道，通道不一致返回冲突。

## 后果

- H5 的现有 200 MiB 契约保持向后兼容。
- 协议检查使用精确字节数；产品文案可以用「100 MB / 200 MB」，但测试必须覆盖边界和边界加一字节。
- 本 ADR 不引入分片、断点续传、凭证续期或 COS multipart；这些能力需要新的架构决策。

## 验证

端点测试覆盖 H5 200 MiB、H5 超限、微信小程序 100 MiB 超限、未知通道和 finalize 无副作用拒绝；`miniprogram/upload-policy.js` 覆盖 `chooseMessageFile → readFile` 的选择器扩展名、大小闸门与字节长度断言。真实微信设备读取临时文件的字节长度仍属于客户端发布前验收，不由仓库测试代替。
