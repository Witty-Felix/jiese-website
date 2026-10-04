# ADR 0011 — 自有服务器的数据模型与接口边界

日期：2026-10-02
状态：已接受

## 背景

迁移到自有服务器后，系统不再新增写入 ima；自有服务器成为新提交的唯一权威写入端。仍需保持既有产品语义：同一次提交可安全重交、同一天可多次打卡、打卡天数按 Asia/Shanghai 自然日去重、附件从成功登记起保留 168 小时、附件清理不删除长期打卡记录。

现有 Cloudflare KV、COS、ima Functions 的实现细节不能继续成为新系统的业务契约。需要将提交、统计、附件生命周期、临时上传、迁移来源和管理操作分离，并给 H5 与小程序保留兼容边界。

## 决策

### 1. 核心实体

新系统包含以下业务实体：

- `member`：稳定 `member_id`、大小写敏感且唯一的昵称；不代表完成个人身份认证。
- `submission`：一次 `prepare → finalize` 流程；`submission_id` 同时是长期主键和重交幂等键。
- `checkin_day`：`(member_id, local_date)` 唯一的统计聚合；同日多个成功提交只计一个自然日。
- `attachment`：正式登记后的截图/录音元信息、来源和生命周期。
- `upload_session`：与提交绑定的短期上传授权、上传完成状态和孤儿清理信息。
- `audit_event`：管理员、迁移和生命周期变更的追加式审计记录。
- `migration_record`：旧 KV/ima 来源的核验、关联和导入状态；不把不确定的旧内容伪装成新提交。

所有公开业务标识使用不可猜测的不透明 ID。唯一约束至少包括：

- `member.nickname`
- `submission.submission_id`
- `checkin_day(member_id, local_date)`
- `attachment(submission_id, kind)`
- `migration_record(source_type, source_record_id)`

并发创建以数据库唯一约束为最终事实；唯一冲突只重新读取既有实体，不创建重复资源。

### 2. 提交与时间

`submission` 的业务状态只有：

```text
prepared → finalizing → finalized
prepared → abandoned
finalizing → prepared   （可重试基础设施失败）
```

`finalized` 是终态；`abandoned` 不进入正式历史和统计。`prepared` 自 `prepared_at` 起 24 小时后放弃。`finalizing` 使用带过期时间的短期认领锁。

同一 `submission_id` 的业务字段不可变：成员、`local_date`、感悟和附件身份以第一次有效 `finalize` 为准；冲突重交返回 `409 submission_payload_mismatch`。需要修改内容必须重新 `prepare`。

绝对时间统一存 UTC 并以 ISO 8601 返回；`local_date` 在 `prepare` 时按 `Asia/Shanghai` 计算并永久绑定；`retained_until = finalized_at + 168 小时`，不接受客户端时间。

### 3. 附件与孤儿对象

正式 `attachment` 独立记录：类型、原始文件名、MIME、大小、校验和（可选）、存储来源、对象引用、`finalized_at`、`retained_until`、清理时间、错误和重试次数。

上传、留存/访问、清理和迁移使用正交状态：

```text
upload_status: pending | uploaded
retention_status: unavailable | available | expired | cleaned
cleanup_status: not_due | pending | failed | succeeded
migration_status: not_applicable | pending_verification | verified | migrated | blocked | unmatched
```

到达 `retained_until` 先禁止访问，再物理删除；清理失败不能恢复访问，只有实际删除成功才标记 `cleaned`。旧 ima 附件尚未迁入本站时不得伪报已清理。

未成功登记的上传对象是孤儿附件，不属于 168 小时正式留存。提交放弃后给予补偿窗口，最长在 `prepared_at + 48 小时` 后清理；失败可重试且不影响正式记录。清理任务通过过期租约条件认领，目标不存在按幂等成功处理。

`finalize` 成功事务必须原子完成：提交转为 `finalized`、写入感悟和时间、登记两个正式附件、创建/更新 `checkin_day`，并记录必要登记事件。对象存储不纳入数据库事务；事务失败的已上传对象转为孤儿对象。

### 4. 来源与迁移

提交、打卡日和附件分别记录来源，可取 `native`、`kv_import`、`legacy_ima`、`mixed` 等适当值，并保存 `source_record_id`、`legacy_ref`、核验状态、核验时间和 `migration_batch_id`。

KV 历史只能导入可核验的昵称、自然日、可用时间和统计结果；缺失字段保持 `null`，不使用导入时间、默认日期或占位附件猜测。旧 ima 内容只有在昵称、日期和内容对应关系可核验时才关联；无法匹配的内容进入 `legacy_unmatched`。

设定切换时刻后，自有服务器是唯一写入权威；KV 与 ima 变为只读迁移来源。导入以稳定来源键幂等，不重复创建。新系统不可用时不自动回退写入 ima/KV；回滚由独立切换流程处理。

### 5. 接口边界

核心 v1 保留以下路径和关键语义：

- `POST /api/verify`：校验共享邀请码，并按昵称幂等创建/读取成员；可增加非破坏性的 `member_ref`，但不代表个人身份认证。
- `POST /api/prepare`：绑定成员与 `local_date`，创建提交和上传会话，返回短期上传授权及 `submission_id`。
- 客户端上传：只依赖短期 `upload_url`/上传凭证、媒体类型和大小约束，不依赖 COS `media_id`、`cos_key` 等后端字段。
- `POST /api/finalize`：验证上传会话、服务端对象元信息和可选客户端 SHA-256；完整事务成功后登记提交。重交已完成提交返回 `status=already` 且零副作用。
- `GET /api/stats`：保持现有公开响应形状；`total`、`streak`、`last_date`、`checked_today` 只按有效 `checkin_day` 计算，不返回感悟、附件或隐藏历史。

错误响应保留用户可读的 `error`，新增稳定 `error_code`、`retryable`、`stage`。至少覆盖 `submission_not_found`、`submission_expired`、`submission_payload_mismatch`、`submission_in_progress`、`duplicate_day_confirmation_required`、`attachment_not_uploaded`、`attachment_mismatch`、`storage_unavailable`、`internal_error` 等。

管理能力使用短期 HttpOnly、Secure、SameSite=Lax 会话；默认空闲超时 30 分钟、绝对有效期不超过 12 小时。管理员历史默认包含正式的有效与隐藏记录，使用游标分页；临时提交不进入正式历史。

管理接口包括历史查询、提交详情、附件短期访问授权、隐藏/恢复和清理重试。附件授权每次检查会话、`retained_until` 和生命周期状态，不返回永久对象 URL；到期、清理中、清理失败和已清理均不可访问。

管理员隐藏只改变当前可见性，不物理删除提交或附件元数据；同日仍有其他有效提交时不隐藏 `checkin_day`。恢复不改变原始登记时间和附件期限。当前状态字段与追加式 `audit_event` 并存；写操作必须使用稳定操作键/条件更新保证幂等。

Cookie 管理会话保护的修改类请求必须检查 `Origin`/`Referer`，必要时增加短期 CSRF token；删除、恢复和清理重试不得使用 GET。新接口不接受把管理密码放在请求体中作为长期认证方式。

### 6. 诊断保留

正式提交、打卡日、附件元信息和审计事件长期保留。`submission_attempt` 至少保留 90 天；上传会话、孤儿对象和临时日志在清理完成后仅保留短期诊断信息。任何诊断记录不得保存管理密码、邀请码或完整附件字节。

## 后果

- 新系统可以替换数据库、对象存储和任务执行方式，而不改变 H5/小程序核心业务协议。
- 提交历史、每日统计和附件生命周期不会互相污染；附件清理失败不会减少打卡天数。
- 数据库事务无法覆盖对象存储，因此必须实现孤儿对象清理和补偿任务。
- 管理员会话、CSRF、审计和迁移来源增加实现工作，但避免共享密码、旧数据误合并和跨系统重复写入。
- 迁移、备份/清理一致性、部署验收仍分别由地图中的后续决策票确定。
