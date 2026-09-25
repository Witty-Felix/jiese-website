# 戒色打卡 · jiese-checkin

> **v1.0.0** · 2026-09-25 · 首个稳定版
> 线上地址：https://jiese-checkin.pages.dev

一个轻量打卡站点。成员用「昵称 + 邀请码」进入，每天提交**运动时长截图**和**阅读录音**，
内容自动沉淀到腾讯 ima 共享知识库「戒色」，打卡天数全员可见；管理员可删除站内的打卡统计记录。

技术上刻意保持极简：**无构建步骤、无数据库、无用户表、无会话** ——
纯静态前端 + Cloudflare Pages Functions + Cloudflare KV + ima OpenAPI，浏览器直传对象存储。

---

## 功能特性（v1.0 范围）

| 模块 | 能力 |
|------|------|
| 进入 | 昵称 + 共享邀请码校验（昵称即身份，无注册、无会话、无用户表） |
| 打卡 | 运动时长截图（PNG/JPG/WebP，≤30MB）+ 阅读录音（MP3/M4A/WAV/AAC，≤200MB）+ 可选「今日感悟」（≤2000 字） |
| 上传 | 浏览器**直传** COS，服务端只下发预签名凭证；两文件并行、合并进度条、真实百分比 |
| 落库 | 截图与录音 add_knowledge 入库 + 自动生成打卡笔记（Markdown）入库，按用户文件夹归档 |
| 打卡榜 | 全员累计天数 / 连续天数 / 最近打卡 / 今日是否已打卡，按累计天数排序；可手动刷新 |
| 管理 | 管理密码解锁 → 单条删除（某用户某天）或整户清空；单条二确认、整户需输入昵称确认；每次删除写 KV 审计 |
| 草稿 | 感悟内容本地暂存，刷新不丢；提交成功后自动清空表单与草稿 |
| 隐私边界 | **站内不提供任何删除 ima 内容的通道**——ima 知识库内容只能在 ima 客户端自行删除 |

---

## 架构总览

```
浏览器（纯静态前端：index.html / app.js / styles.css）
   │  ① POST  /api/verify          { nickname, invite_code }        —— 校验邀请码
   │  ② POST  /api/prepare         { nickname, invite_code, image, audio }
   │        └─ 返回预签名凭证；浏览器并行 PUT 两个文件直传 COS（不经本站服务器中转）
   │  ③ POST  /api/finalize        { nickname, invite_code, reflection, image, audio }
   │        └─ 入库 ima（截图 + 录音 + 笔记）并写 KV 打卡记录
   │  ④ GET   /api/stats                                            —— 全员打卡天数
   │  ⑤ POST  /api/admin/verify    { admin_password }               —— 解锁管理模式
   │  ⑥ DELETE /api/admin/checkin  { admin_password, operator, nickname, date | all }
   ▼
Cloudflare Pages Functions（functions/api/*.js，持 ima 与 KV 凭证）
   │  create_media(图片/9) / create_media(录音/15) → 预签名 → COS
   │  import_doc(笔记) → add_knowledge 到用户文件夹
   │  KV 读写打卡统计 + 删除标记 + 审计
   ▼
ima 共享知识库「戒色」/ <用户文件夹> / 按日期的笔记 · 图片 · 录音
```

请求流程要点：上传走 `prepare → 浏览器直传 COS → finalize` 三段式。这样既不让长期密钥进前端，
也绕开了原先把大文件经 Cloudflare 边缘转传的瓶颈（15MB 需 20~38s），详见 ADR-0005。

---

## 目录结构

```
.
├── index.html                 # 单页：登录视图 / 打卡视图（含打卡榜与管理模式）/ 成功视图
├── app.js                     # 前端全部逻辑：登录、选文件与预览、直传、打卡榜、管理模式
├── styles.css                 # 样式
├── _headers                   # 响应头规则：app.js / styles.css 强制回源校验（改动前端无需手工改版本号）
├── wrangler.toml              # Pages 项目配置 + KV 绑定（binding STATS）
├── functions/api/             # Pages Functions（ES 模块；下划线前缀文件不参与路由）
│   ├── _ima.js                #   ima OpenAPI 与 COS 签名封装、时区工具、用户文件夹映射
│   ├── _stats.js              #   榜单行计算 + 删除标记读写（stats 与 admin 共用口径）
│   ├── verify.js              #   POST   /api/verify
│   ├── prepare.js             #   POST   /api/prepare
│   ├── finalize.js            #   POST   /api/finalize
│   ├── stats.js               #   GET    /api/stats
│   └── admin/
│       ├── _auth.js           #   常量时间比对 + 统一 JSON 响应
│       ├── verify.js          #   POST   /api/admin/verify
│       └── checkin.js         #   DELETE /api/admin/checkin
├── CONTEXT.md                 # 领域词汇表 + 架构总览（术语改动的唯一来源）
├── AGENTS.md                  # AI/协作者约定（issue 追踪、triage 标签、域文档位置）
└── docs/
    ├── adr/                   # 架构决策记录 0001–0007
    └── agents/                # issue-tracker / triage-labels / domain 约定
```

---

## 快速开始

### 前置条件

- Node.js 18+（仅用于运行 `wrangler`，本项目本身没有构建步骤）
- 一个 Cloudflare 账号（Pages + KV）
- 一个 ima 共享知识库，以及在 ima.qq.com/agent-interface 生成的一对 OpenAPI 凭据

### 1. 创建 KV 命名空间

```bash
npx wrangler kv namespace create STATS
```

把输出里的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`。

### 2. 配置 Secrets

以下变量的值**都不入库**，只作为 Pages Secret 注入（本地则放 `.dev.vars`，该文件已被 gitignore）：

| 变量 | 必需 | 用途 |
|------|------|------|
| `INVITE_CODE` | 是 | 全员共用的进入口令 |
| `ADMIN_PASSWORD` | 是 | 管理模式与删除操作的唯一凭证（建议 24 位随机） |
| `IMA_OPENAPI_CLIENTID` | 是 | ima OpenAPI Client ID |
| `IMA_OPENAPI_APIKEY` | 是 | ima OpenAPI API Key |
| `IMA_KB_ID` | 是 | 目标知识库的 OpenAPI ID（base64 形式，与 ima 界面里的数字 ID 不同源） |
| `IMA_USER_FOLDERS` | 否 | `{"昵称":"folder_xxx"}` JSON 字符串；未配置则落知识库根目录 |

```bash
# 线上（生产）
npx wrangler pages secret put ADMIN_PASSWORD --project-name jiese-checkin

# 本地（在项目根目录创建 .dev.vars，键值对形式，每行一个）
# INVITE_CODE=...
# ADMIN_PASSWORD=...
```

### 3. 本地预览

```bash
npx wrangler pages dev .
```

### 4. 部署

```bash
npx wrangler pages deploy . --project-name jiese-checkin --commit-dirty=true
```

> 部署完成后会打印一个本次部署的专属域名（形如 `xxxx.jiese-checkin.pages.dev`）。
> **验证新代码请用这个专属域名**——主域名可能仍在传播旧版本 Function，会误判成「修复无效」。

---

## API 参考

所有响应均为 JSON，失败时形如 `{ "ok": false, "error": "…" }`。

| 方法 | 路径 | 请求体 | 成功响应 |
|------|------|--------|----------|
| POST | `/api/verify` | `{nickname, invite_code}` | `{ok:true, nickname}` |
| POST | `/api/prepare` | `{nickname, invite_code, image:{size,type}, audio:{size,type}}` | `{ok:true, date, image:{media_id, cos_key, cos_url, authorization, token}, audio:{…}}` |
| POST | `/api/finalize` | `{nickname, invite_code, reflection, image:{media_id, cos_key, size}, audio:{…}}` | `{ok:true, date, stats_updated}` |
| GET | `/api/stats` | — | `{ok:true, today, rows:[{nickname, total, streak, last_date, checked_today}]}` |
| POST | `/api/admin/verify` | `{admin_password}` | `{ok:true}` |
| DELETE | `/api/admin/checkin` | `{admin_password, operator, nickname, date}` 或 `{admin_password, operator, nickname, all:true}` | `{ok:true, scope, deleted, audit_written, marked, row}` |

错误码约定：`400` 参数不合法 · `401` 邀请码或管理密码错误 · `404` 待删记录不存在 ·
`413` 附件超限 · `500` 服务端未配置 · `502` ima 侧失败（响应带 `stage` 标明失败环节）。

`DELETE /api/admin/checkin` 的响应字段：

- `row` —— 该用户重算后的榜单行（口径与 `/api/stats` 完全一致），`null` 表示该用户已无记录。
  前端据此**本地即时更新**榜单，无需回源重拉。
- `marked` —— 删除标记是否写入成功；`false` 时前端提示「刷新后可能短暂复现」。
- `audit_written` —— 审计是否落盘。两个布尔位都只作提示，都不回滚已完成的删除。

---

## 数据模型（Cloudflare KV）

| 键 | 值 | 写入方 | 说明 |
|----|----|--------|------|
| `checkin:<yyyy-mm-dd>:<昵称>` | `{ts}` | `finalize` | 打卡统计的**唯一事实来源**；日期一律按 Asia/Shanghai |
| `deleted:<昵称>` | `{dates:[…], ts}` | 删除时写入、重新打卡时撤销 | 删除标记，最多保留 500 个日期 |
| `audit:del:<ISO时间戳>:<操作者>` | `{target, scope, date?, deleted, ts}` | 管理员删除 | 只写不读；追责时到 KV 控制台按前缀查看 |

「打卡天数」= 某用户日期集合的大小（同日多次提交不重复计）；「连续天数」= 从今天（或昨天）起
向前连续不断的日期数。统计与删除响应的重算都走同一个共享函数，保证两边口径永不漂移。

---

## 安全与隐私

- **凭据只在服务端**：邀请码、管理密码、ima 凭据全部是 Pages Secret，不进前端代码、不入仓库。
- **管理密码比对使用常量时间算法**，消除时序侧信道；删除不携带任何长期密钥。
- **上传凭证最小化**：`/api/prepare` 只回传该次上传的预签名 `Authorization` 与临时 `token`，不泄露长期密钥。
- **删除边界**：站内删除只作用于 KV `checkin:*` 统计记录；ima 内容必须在 ima 客户端自行删除。
- **审计留痕**：每次删除都写一条 `audit:del:*` 记录（时间、操作者、目标、范围、条数），只写不读。

---

## 已知限制与设计取舍

1. **KV `list()` 有最长约 60 秒的最终一致延迟**：删除与打卡对单个键是即时的，但基于列表枚举的读取
   可能读到旧数据。本站用 `deleted:<昵称>` 删除标记 + 删除响应回传重算行来规避（ADR-0007）。
   跨设备、跨边缘节点仍可能看到最长约 60 秒的残留 —— 这是 KV 的平台特性。
2. **管理密码无速率限制、无失败锁定**：可被暴力尝试。熟人小圈子风险可接受；风险上升时可加
   KV 失败计数，或直接更换为更长的随机密码。
3. **昵称即身份**：无用户表、无会话，知道邀请码的人可以冒用他人昵称打卡。这是 ADR-0002 的明确取舍。
4. **ima OpenAPI 没有删除接口**：站内删掉统计记录不会影响 ima 中的内容（预期行为，也符合需求）。
5. **附件规格受 ima 限制**：图片 ≤30MB、音频 ≤200MB；不支持视频，因此以运动 App 的时长截图代替。
6. **强一致升级路径**：若日后需要强一致（成员增多或跨地域抱怨延迟），把统计迁到 Cloudflare D1
   （`checkin(nickname, date)` 唯一索引）即可，删除就是真实删除、无需标记。本期不做。

---

## 验证方式

本站没有引入测试框架，验证采用三种手段（改动统计数据路径或打卡表单时应照做）：

| 手段 | 做法 | 适用 |
|------|------|------|
| 桩化 KV 回归测试 | 用内存 KV 模拟「list 缓存定格 60s」「get 抛错」，直接 import 真实 handler 调用 | 统计、删除、标记逻辑 |
| DOM 级端到端测试 | jsdom 加载真实 `index.html` + `app.js`，桩掉 fetch/XHR，跑完整提交流程 | 打卡表单、登录、管理模式 UI |
| 生产端场景复现 | 种数据 → 执行操作 → **毫秒级**立即拉 `/api/stats` 断言结果 | 一致性类问题 |

> 说明：上述测试脚本目前是临时脚本，尚未入库。若需要长期回归保护，可放入 `tests/` 并配 `npm script`。

前端资源缓存同样有两条约定：

- `_headers` 已对 `app.js` / `styles.css` 下发 `Cache-Control: no-cache`（ETag 回源校验），
  这是**持久保证**：以后改前端不需要手工递增任何版本号。`index.html` 里的 `?v=` 标识只是
  一次性冲掉规则生效前已存在于浏览器中的旧副本，**不是**必须维护的版本号。
- `/api/stats` 响应带 `Cache-Control: no-store`，避免在 KV 本身的一致性延迟之上再叠一层浏览器缓存。

操作 KV 时的两条铁律：

- 一律带 `--remote`（不带时是边缘视角，会给出「已删/空」的假象，中央存储才是权威）。
- 批量种数据用 `wrangler kv bulk put <json> --remote`，避免超长命令被终端中断。

---

## 版本

**v1.0.0**（2026-09-25）—— 首个稳定版，包含 0001–0007 全套架构决策：

| ADR | 决策 |
|-----|------|
| [0001](docs/adr/0001-reuse-survey-to-ima-architecture.md) | 复用 survey-to-ima 三层架构（静态前端 + Functions + ima OpenAPI） |
| [0002](docs/adr/0002-nickname-invite-code-auth.md) | 昵称 + 共享邀请码认证，不建用户表 |
| [0003](docs/adr/0003-per-user-ima-folders.md) | 内容按用户文件夹归档到 ima 知识库 |
| [0004](docs/adr/0004-kv-stats.md) | 打卡统计存 Cloudflare KV，全员可见 |
| [0005](docs/adr/0005-browser-direct-upload.md) | 浏览器直传 COS，跳过服务器中转 |
| [0006](docs/adr/0006-admin-managed-deletion.md) | 删除权限收敛到管理员：独立管理密码 + KV 审计 |
| [0007](docs/adr/0007-kv-list-consistency-deletion-marker.md) | 删除标记绕开 KV list 最终一致延迟 |

相关文档：[CONTEXT.md](CONTEXT.md)（词汇表与架构总览）、[AGENTS.md](AGENTS.md)（协作约定）。

---

## 许可

私人项目，未附开源许可证。
