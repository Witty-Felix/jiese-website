# ADR 0014 — 微信小程序音频通道上限收紧为 100 MiB

日期：2026-10-04
状态：已接受

## 背景

现有上传链路使用 `prepare → 单次 COS 预签名 PUT → finalize`。H5 浏览器通过文件对象直传，当前音频上限是 200 MiB。微信小程序的真机基线已经证明小文件可以使用同一条链路，但小程序侧必须先用 `readFile` 得到一个 `ArrayBuffer`，再用单次 `wx.request` 完成 COS `PUT`。

因此，后端允许 200 MiB 不能直接等同于小程序能够可靠处理 200 MiB。继续让两个入口共享一个未区分通道的上限，会让小程序在选择或读取阶段才失败，或让客户端误以为 200 MiB 受到支持。

## 决策

选择方案 B：**不为小程序增加 COS 分片、断点续传、凭证续期或字节级上传进度协议；将小程序录音有效上限收紧为 100 MiB。**

- 小程序上限是 `100 * 1024 * 1024 = 104,857,600` 字节，边界值允许，超过 1 字节即拒绝。
- 小程序请求在 `prepare` 和 `finalize` 中携带精确通道标识 `channel: "wechat-miniprogram"`。
- 未携带 `channel` 的现有 H5 契约保持原行为：音频上限仍为 `200 * 1024 * 1024` 字节。
- 已携带但不在受支持枚举中的通道标识直接返回请求错误，不把拼写错误静默当成 H5。
- `prepare` 在创建 `submission_id` 或调用 ima `create_media` 之前完成大小校验；`finalize` 在读取提交状态和任何登记副作用之前完成同样的大小校验。
- 小程序在 `chooseMessageFile` 成功回调中立即检查 `tempFiles[].size`，超限时不调用 `prepare`。
- 小程序 `readFile` 成功后必须断言 `ArrayBuffer.byteLength === tempFiles[].size`，不一致就停止上传。
- 结果未知仍按 ADR-0010 复用原来的 `submission_id`、媒体回执和通道标识；收紧上限不改变 `new` / `already` 语义。

服务端超限错误的稳定文案为：**“微信小程序录音不得超过 100 MB”**。这里的“100 MB”是面向成员的产品文案；协议和测试使用精确的 100 MiB 字节阈值。

## 理由

1. 已验证的真机链路是单次 `ArrayBuffer` + 单次 COS `PUT`，不是分片协议。引入分片会新增初始化、分片凭证、完成/取消、失败重试、凭证过期和进度状态机，超出本票范围。
2. 在不增加协议复杂度的情况下，客户端可以在选择后给出立即、明确的反馈，服务端仍保留最终防线。
3. 通道标识只用于选择兼容性上限，不是身份认证。小程序把自己标识为更严格的通道不会扩大权限；H5 省略标识即可保持旧契约。
4. `submission_id` 仍代表一次 `prepare`，而不是某个文件大小策略。大小拒绝发生在 `prepare` 之前，结果未知重交也不应重新 `prepare`。

## API 契约

### `POST /api/prepare`

请求仍包含 `nickname`、`invite_code`、`image` 和 `audio`，新增可选字段：

```json
{
  "channel": "wechat-miniprogram"
}
```

- `channel` 省略：按 H5 200 MiB 音频契约处理。
- `channel` 为 `wechat-miniprogram`：按 100 MiB 音频契约处理，成功响应回传相同的 `channel`，并将它绑定到 `submission_id`。
- 小程序音频 `size > 104857600`：HTTP `413`，错误文案为“微信小程序录音不得超过 100 MB”；不创建 `submission_id`，不调用 `create_media`。

### `POST /api/finalize`

请求沿用 `submission_id`、两个媒体回执和 `allow_duplicate_day`，小程序重交时还要带回相同的 `channel`。

- 提交记录与请求通道不一致：HTTP `409`，不产生登记副作用。
- 小程序音频 `size > 104857600`：HTTP `413`，错误文案同上；不读取提交状态，不写 KV，不调用 ima。
- H5 省略 `channel` 时，200 MiB 边界仍允许；超过 H5 上限仍按 H5 错误文案拒绝。

## 客户端与测试矩阵

| 场景 | 预期 |
|---|---|
| 小程序选择 `100 MiB` 音频 | 选择回调通过，继续既有 `readFile → PUT` 链路 |
| 小程序选择 `100 MiB + 1` 字节音频 | 选择回调明确提示并停止，不调用 `prepare` |
| 小程序 `readFile` 字节数不一致 | 停止上传并保留错误，不调用 COS PUT |
| 小程序 `prepare` 超过上限 | HTTP 413，不创建 `submission_id` 或 ima 临时媒体 |
| 小程序 `finalize` 超过上限 | HTTP 413，不读取提交状态或产生登记副作用 |
| H5 `200 MiB` 音频 | 继续允许，旧链路不变 |
| H5 结果未知后重交 | 仍复用同一 `submission_id`，返回 `new` 或 `already`，不因通道字段改变幂等语义 |
| 小程序通道重交 | 复用同一 `submission_id` 与 `channel`；通道不一致时拒绝 |

真机基线沿用 MAA-AN00 / Android 16 / 微信 8.0.78 / 基础库 3.17.3 的既有验证；本决策不宣称已经完成 100 MiB 真实音频压测，只规定可执行上限和受控回归边界。

## 不在本 ADR 内

- COS 分片上传、断点续传、凭证续期和字节级上传进度。
- 修改 H5 文件选择器或 H5 200 MiB 上限。
- 支持微信语音消息。