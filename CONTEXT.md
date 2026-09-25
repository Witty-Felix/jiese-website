# CONTEXT.md — 戒色打卡站（jiese-checkin）

版本：**v1.0.0**（2026-09-25 首个稳定版，见 `README.md` 与 `docs/adr/0001`–`0007`）
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
   │  ① POST /api/verify   { nickname, inviteCode }   —— 校验邀请码
   │  ② POST /api/checkin  multipart（感悟 + 截图 + 录音）
   │  ③ GET  /api/stats                                —— 全员打卡天数
   │       list checkin:* → 逐用户 get deleted:*（ADR-0007，绕开 list 延迟）
   │  ④ DELETE /api/admin/checkin                      —— 管理员删 KV 统计（ADR-0006）
   │       { admin_password, operator, nickname, date | all: true }
   │       写 deleted:<昵称> 删除标记（ADR-0007）；响应回传重算行供前端即时更新
   │       仅删 KV 统计记录；ima 内容无站内删除通道，只能在 ima 自行删除
   ▼
Cloudflare Pages Functions（持 ima 凭证与 KV）
   │  create_media(图片/9) → COS 直传
   │  create_media(录音/15) → COS 直传
   │  import_doc(笔记) → add_knowledge 到用户文件夹
   │  KV 写入打卡记录（并撤销当日删除标记）
   ▼
ima 共享知识库「戒色」/ <用户文件夹> / 按日期的笔记·图片·录音
```
