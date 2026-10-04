# ADR 0010 — 安全提交与 `submission_id` 幂等重交

日期：2026-10-04
状态：已接受
关联：GitHub issue #30

## 背景

`prepare → 浏览器直传 COS → finalize` 是一条跨多个网络边界的流程。COS 上传可能已经完成，但 `finalize` 的响应会因为网络中断、页面关闭或网关超时而丢失。客户端此时不能判断登记是否已经写入 ima；如果从头重新 `prepare`，会重新创建媒体并可能重复写入 ima。

同一天重复打卡仍是产品允许的行为，但网络重试不能被误当成一次新的打卡。因此必须把「重交同一次提交」和「今天再登记一条」分开。

## 决策

### 1. `prepare` 签发提交身份

- `POST /api/prepare` 在任何 `create_media` 之前生成服务端 `crypto.randomUUID()`，写入 `submission:<submission_id>`。
- 记录至少包含 `nickname`、Asia/Shanghai 业务 `date`、状态和时间戳，并从签发起保留 24 小时。
- 状态为：
  - `prepared`：凭证已签发，等待登记；
  - `inflight`：正在登记的 60 秒软锁；
  - `done`：三项内容已进入 ima，后续同一提交只返回 `already`。
- `inflight` 记录会保存已完成的子步骤（截图、录音、笔记导入/入库）；部分失败重交时跳过已经确认成功的子步骤。没有任何子步骤成功时才立即回到 `prepared`，部分成功则保留软锁直到过期。
- `channel`（若存在）也绑定到提交记录；H5 省略该字段，以 `null` 表示旧契约。

### 2. `finalize` 先做身份与状态闸门

在目录、ima 或统计写入之前，`finalize` 必须验证：

- 提交标识已由 `prepare` 签发且未过期；
- 记录中的昵称、业务日期和上传通道与本次请求一致；
- `done` 返回 `{ ok: true, status: "already" }`；
- 有效的 `inflight` 返回冲突，软锁过期后允许恢复；
- 未签发、过期或不匹配的提交返回冲突错误，不产生登记副作用。

附件大小与格式校验仍在状态读取之前执行，确保拒绝超限请求不会留下提交记录、媒体或 ima 写入。

### 3. 结果未知使用客户端检查点

H5 在两次 COS PUT 完成、调用 `finalize` 之前保存 `submission_id`、两份媒体回执和感悟到按昵称分隔的 `localStorage` 检查点。`finalize` 网络错误或不可解析响应被展示为「结果未知」，主按钮变为「重交本次登记」。

重交必须：

- 由用户显式触发；
- 复用原 `submission_id`、媒体回执和感悟；
- 不重新调用 `prepare`，不重新执行 COS PUT；
- 对 `new` 与 `already` 使用不同的用户提示。

换选任一材料会丢弃旧检查点，因为那代表用户开始了新的提交。跨 Asia/Shanghai 自然日的检查点作废。

### 4. 同日重复登记需要显式确认

`prepare` 用单键 `get checkin:<date>:<nickname>` 提前返回 `already_today`，避免用户先上传大文件再得知重复。`finalize` 再做一次权威检查：

- 没有 `allow_duplicate_day: true` 时返回 `409 duplicate_day`；
- 用户确认后带严格布尔值 `allow_duplicate_day: true` 重发同一 `submission_id`；
- 确认放行后仍按既有统计口径写入同一 `checkin:<date>:<nickname>` 键，自然日天数不重复增加。

## 后果

- 正常重交对 ima 零副作用；只在首次 ima 已成功、统计占位尚未补齐时，`already` 路径允许幂等补写统计。
- ima 落库按子步骤记录进度并在部分失败后保留软锁，缩小重复写入窗口；KV 本身仍没有 CAS，若进程恰好在副作用完成与进度写入之间崩溃，仍需按软锁和运维告警处理。
- KV 没有 CAS，`inflight` 是软锁而非严格互斥；进程在 ima 已写入但 `done` 状态尚未落盘的极端窗口仍需监控。
- 已上传但最终未登记的 COS 对象仍可能成为孤儿对象，沿用 ADR-0005 的生命周期取舍。
- H5 的旧请求不传 `channel`，保持现有 200 MiB 音频上限，不因其他客户端的更小限制而收紧。

## 验证

`tests/submission-contract.test.mjs` 覆盖提交签发、24 小时 TTL、H5/通道大小边界、冲突无副作用、`new`/`already`、统计补写、重复日期确认和软锁恢复。`tests/h5-flow.test.mjs` 覆盖结果未知后的显式重交、重复日期确认以及原提交和媒体回执复用。
