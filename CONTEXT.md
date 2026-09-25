# CONTEXT.md — 戒色打卡站（jiese-checkin）

版本：**v1.1.0**（2026-09-25 新增 ima 两层目录，见 `README.md` 与 `docs/adr/0001`–`0008`）
线上地址：https://jiese-checkin.pages.dev

一句话：一个轻量打卡网站，成员用昵称+邀请码进入，每天上传运动截图与阅读录音，内容沉淀到 ima 共享知识库「戒色」，打卡天数全员可见。

## 词汇表（Glossary）

| 术语 | 定义 |
|------|------|
| 打卡（Check-in） | 一次完整的每日提交 = 1 条笔记 + 1 张运动时长截图 + 1 段阅读录音 |
| 运动截图 | 运动类 App 显示运动视频/锻炼时长的截图（图片文件，非视频本身） |
| 阅读录音 | 朗读戒色文章的音频文件（mp3/m4a/wav/aac） |
| 邀请码 | 共享口令，用于进入打卡界面；本身不标识身份，昵称才是身份 |
| 打卡天数 | 某用户累计打卡的自然日数量（去重） |
| 连续天数 | 当前连续未中断的打卡自然日数 |
| ima KB「戒色」 | 腾讯 ima 共享知识库，所有打卡内容落库于此，按用户建文件夹 |
| 用户文件夹 | ima KB「戒色」根目录下、以**成员昵称原文**（大小写敏感，不做归一化）命名的一层文件夹，承载该成员的全部打卡；成员登录时自动确保存在（ADR-0008） |
| 日期文件夹 | 用户文件夹下、以 `YYYY-MM-DD`（Asia/Shanghai）命名的一层文件夹，承载该成员当天的全部打卡内容（笔记·截图·录音）；成员提交打卡时自动确保存在（ADR-0008） |
| 目录降级（Folder Degradation） | 目录结构不可用时的分层退让：用户文件夹不可用 → 落知识库根目录且不建日期文件夹；日期文件夹建不出 → 落用户文件夹。打卡与登录永不因文件夹失败，降级事实在响应 `folder` 字段与日志中如实暴露（ADR-0008） |
| Pages Function | Cloudflare Pages 的后端函数层，持 ima 凭证并转发落库 |
| 管理密码（Admin Password） | Pages Secret `ADMIN_PASSWORD`，站内删除操作的唯一凭证；与邀请码相互独立（ADR-0006） |
| 管理模式（Admin Mode） | 打卡榜内嵌的解锁态：输入管理密码后榜单行出现删除按钮（ADR-0006） |
| 整户清空 | 删除某昵称全部打卡统计记录，该用户从打卡榜消失；ima 内容不受影响（ADR-0006） |
| 审计记录（Audit Record） | KV 键 `audit:del:<时间戳>:<操作者>`，记录每次删除的目标、范围与条数；只写不读（ADR-0006） |
| 删除标记（Deletion Marker） | KV 键 `deleted:<昵称>`，记录该用户被删掉的日期；`/api/stats` 用 get 读它把已删日期减掉，绕开 KV list 最长约 60s 的最终一致延迟；重新打卡会撤销该日标记（ADR-0007） |

## 相关文档

- `docs/adr/` — 架构决策记录
- 参考资料：WorkBuddy 空间《调查问卷网站实现机理总结》（survey-to-ima 同源架构）

## 架构总览

```
浏览器（纯静态前端 index.html / app.js / styles.css）
   │  ① POST /api/verify   { nickname, invite_code }   —— 校验邀请码
   │       └─ 顺带「确保用户文件夹存在」（ADR-0008）；失败不阻断登录（folder=degraded）
   │  ② POST /api/prepare  { nickname, invite_code, image, audio }
   │       └─ 下发预签名凭证；浏览器并行 PUT 两个文件直传 COS（ADR-0005）
   │  ③ POST /api/finalize { nickname, invite_code, reflection, image, audio }
   │       └─ 确保日期文件夹 → 入库三样内容 → 写 KV 打卡记录
   │  ④ GET  /api/stats                                —— 全员打卡天数
   │       list checkin:* → 逐用户 get deleted:*（ADR-0007，绕开 list 延迟）
   │  ⑤ POST /api/admin/verify                         —— 解锁管理模式（ADR-0006）
   │  ⑥ DELETE /api/admin/checkin                      —— 管理员删 KV 统计（ADR-0006）
   │       { admin_password, operator, nickname, date | all: true }
   │       写 deleted:<昵称> 删除标记（ADR-0007）；响应回传重算行供前端即时更新
   │       仅删 KV 统计记录；ima 内容无站内删除通道，只能在 ima 自行删除
   ▼
Cloudflare Pages Functions（持 ima 凭证与 KV）
   │  ensureUserFolder(nickname) → get_knowledge_list 查根目录 → 未命中才 create_folder（ADR-0008）
   │  ensureDayFolder(userFolderId, date) → 同上，父级必须是该成员的用户文件夹，否则不建
   │  create_media(图片/9) · create_media(录音/15) → 预签名 → 浏览器直传 COS
   │  import_doc(笔记) → add_knowledge ×3，三样内容用同一个 folder_id
   │  KV 写入打卡记录（并撤销当日删除标记）
   ▼
ima 共享知识库「戒色」/ <用户文件夹> / <YYYY-MM-DD> / 笔记 · 截图 · 录音
```
