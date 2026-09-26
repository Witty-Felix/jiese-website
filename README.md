# 戒色打卡 · jiese-checkin

> **v1.1.0** · 2026-09-25 · 新增 ima 知识库内的两层目录（ADR-0008）
> 线上地址：https://jiese-checkin.pages.dev

一个轻量打卡站点。成员用「昵称 + 邀请码」进入，每天提交**运动时长截图**和**阅读录音**，
内容自动沉淀到腾讯 ima 共享知识库「戒色」，打卡天数全员可见；管理员可删除站内的打卡统计记录。

技术上刻意保持极简：**无构建步骤、无数据库、无用户表、无会话** ——
纯静态前端 + Cloudflare Pages Functions + Cloudflare KV + ima OpenAPI，浏览器直传对象存储。

---

## 功能特性（v1.1 范围）

| 模块 | 能力 |
|------|------|
| 进入 | 昵称 + 共享邀请码校验（昵称即身份，无注册、无会话、无用户表）；登录时**自动确保用户文件夹存在**，成员无需任何建档操作 |
| 打卡 | 运动时长截图（PNG/JPG/WebP，≤30MB）+ 阅读录音（MP3/M4A/WAV/AAC，≤200MB）+ 可选「今日感悟」（≤2000 字）；同一昵称同一天只对应一个日期文件夹 |
| 上传 | 浏览器**直传** COS，服务端只下发预签名凭证；两文件并行、合并进度条、真实百分比 |
| 落库 | 三样内容（截图 + 录音 + 自动生成的打卡笔记）全部入 **`<昵称>/<YYYY-MM-DD>/`** 两层文件夹；目录不可用时分层降级，打卡永不失败 |
| 打卡榜 | 全员累计天数 / 连续天数 / 最近打卡 / 今日是否已打卡，按累计天数排序；可手动刷新 |
| 管理 | 管理密码解锁 → 单条删除（某用户某天）或整户清空；单条二确认、整户需输入昵称确认；每次删除写 KV 审计 |
| 草稿 | 感悟内容本地暂存，刷新不丢；提交成功后自动清空表单与草稿 |
| 隐私边界 | **站内不提供任何删除 ima 内容的通道**——ima 知识库内容只能在 ima 客户端自行删除 |

---

## 架构总览

```
浏览器（纯静态前端：index.html / app.js / styles.css）
   │  ① POST  /api/verify          { nickname, invite_code }        —— 校验邀请码
   │        └─ 顺带「确保用户文件夹存在」（ADR-0008）；失败不阻断登录
   │  ② POST  /api/prepare         { nickname, invite_code, image, audio }
   │        └─ 返回预签名凭证；浏览器并行 PUT 两个文件直传 COS（不经本站服务器中转）
   │  ③ POST  /api/finalize        { nickname, invite_code, reflection, image, audio }
   │        └─ 确保日期文件夹 → 入库 ima（截图 + 录音 + 笔记）并写 KV 打卡记录
   │  ④ GET   /api/stats                                            —— 全员打卡天数
   │  ⑤ POST  /api/admin/verify    { admin_password }               —— 解锁管理模式
   │  ⑥ DELETE /api/admin/checkin  { admin_password, operator, nickname, date | all }
   ▼
Cloudflare Pages Functions（functions/api/*.js，持 ima 与 KV 凭证）
   │  ensureUserFolder / ensureDayFolder → get_knowledge_list 先查后建 + 回读校验（ADR-0008）
   │  create_media(图片/9) / create_media(录音/15) → 预签名 → COS
   │  import_doc(笔记) → add_knowledge ×3 到该成员该日的日期文件夹
   │  KV 读写打卡统计 + 删除标记 + 审计
   ▼
ima 共享知识库「戒色」/ <用户文件夹> / <YYYY-MM-DD> / 笔记 · 截图 · 录音
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
├── deploy.sh                  # 部署脚本：白名单拷贝到 .deploy/ 再发布（**不要**直接部署仓库根目录）
├── wrangler.toml              # Pages 项目配置 + KV 绑定（binding STATS）
├── functions/api/             # Pages Functions（ES 模块；下划线前缀文件不参与路由）
│   ├── _ima.js                #   ima OpenAPI 与 COS 签名封装、两层目录「确保存在」、时区工具
│   ├── _stats.js              #   榜单行计算 + 删除标记读写（stats 与 admin 共用口径）
│   ├── verify.js              #   POST   /api/verify   （校验 + 确保用户文件夹）
│   ├── prepare.js             #   POST   /api/prepare
│   ├── finalize.js            #   POST   /api/finalize （确保日期文件夹 + 入库）
│   ├── stats.js               #   GET    /api/stats
│   └── admin/
│       ├── _auth.js           #   常量时间比对 + 统一 JSON 响应
│       ├── verify.js          #   POST   /api/admin/verify
│       └── checkin.js         #   DELETE /api/admin/checkin
├── CONTEXT.md                 # 领域词汇表 + 架构总览（术语改动的唯一来源）
├── AGENTS.md                  # AI/协作者约定（issue 追踪、triage 标签、域文档位置）
└── docs/
    ├── adr/                   # 架构决策记录 0001–0008
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
sh deploy.sh
```

> **不要直接 `npx wrangler pages deploy .`。** `wrangler pages deploy <dir>` 会上传 `<dir>` 下的
> **全部**文件，只排除一份硬编码清单（`_worker.js` / `_redirects` / `_headers` / `_routes.json` /
> `.DS_Store` / `node_modules` / `.git`），并且**不读 `.gitignore`**（`.assetsignore` 对 Pages 也不生效，已实测）。
> 直接部署仓库根目录，会把 `.dev.vars`（ima 凭据 + 邀请码）、`.workbuddy/`、`wrangler.toml` 一并
> **公开发布** —— 2026-09-25 已因此发生真实泄露事故（见下）。
>
> `deploy.sh` 改为「白名单拷贝到 `.deploy/` 再发布」，拷贝后自检私密文件是否混入，混入即中止部署。
> **新增公开静态资源时，记得同步 `deploy.sh` 里的 `PUBLIC_FILES` / `PUBLIC_DIRS`**，否则该资源不会上线。

部署完成后会打印一个本次部署的专属域名（形如 `xxxx.jiese-checkin.pages.dev`）。
**验证新代码请用这个专属域名**——主域名可能仍在传播旧版本 Function，会误判成「修复无效」。

#### 事故记录（2026-09-25）：凭据被公开发布

- **现象**：`https://jiese-checkin.pages.dev/.dev.vars` 可被任意人下载，泄露 ima OpenAPI 凭据与邀请码；
  `.workbuddy/`、`wrangler.toml` 同样可公开访问。
- **根因**：`wrangler pages deploy` 不读 `.gitignore`，只认那份硬编码忽略清单。
- **处置**：改用 `deploy.sh` 白名单发布并重新部署；**删除此前所有含凭据的部署**——旧部署的
  `*.pages.dev` 专属域名会长期保留它上传时的资源，仅重部署无法回收；**轮换 ima API Key**
  （2026-09-26 完成，重新生成后旧 Key 随即失效）；邀请码经评估**维持不变**（它是小圈子共享口令，
  泄露影响面有限——仍需昵称才能打卡，站内另有审计与管理员删除兜底；更换则须通知全部成员）。
- **教训**：**`.gitignore` 只保护 git，不保护部署。** 凡「不该公开」的文件，必须在发布环节显式白名单化，
  并在部署后用 `curl -o /dev/null -w '%{http_code}' https://<域名>/.dev.vars` 抽查（期望 **404 或返回首页**）。

---

## API 参考

所有响应均为 JSON，失败时形如 `{ "ok": false, "error": "…" }`。

| 方法 | 路径 | 请求体 | 成功响应 |
|------|------|--------|----------|
| POST | `/api/verify` | `{nickname, invite_code}` | `{ok:true, nickname, folder:"ready"\|"degraded"}` |
| POST | `/api/prepare` | `{nickname, invite_code, image:{size,type}, audio:{size,type}}` | `{ok:true, date, image:{media_id, cos_key, cos_url, authorization, token}, audio:{…}}` |
| POST | `/api/finalize` | `{nickname, invite_code, reflection, image:{media_id, cos_key, size}, audio:{…}}` | `{ok:true, date, stats_updated, folder:"day"\|"user"\|"root"}` |
| GET | `/api/stats` | — | `{ok:true, today, rows:[{nickname, total, streak, last_date, checked_today}]}` |
| POST | `/api/admin/verify` | `{admin_password}` | `{ok:true}` |
| DELETE | `/api/admin/checkin` | `{admin_password, operator, nickname, date}` 或 `{admin_password, operator, nickname, all:true}` | `{ok:true, scope, deleted, audit_written, marked, row}` |

错误码约定：`400` 参数不合法 · `401` 邀请码或管理密码错误 · `404` 待删记录不存在 ·
`413` 附件超限 · `500` 服务端未配置 · `502` ima 侧失败（响应带 `stage` 标明失败环节）。

`folder` 字段（ADR-0008，前端不消费，仅供排查与运维）：

- `/api/verify` 的 `folder` —— `ready` 表示用户文件夹已就绪；`degraded` 表示未能确保（登录**照常成功**）。
- `/api/finalize` 的 `folder` —— 本次三样内容的**实际落库层级**：`day` = 目标态（日期文件夹）、
  `user` = 日期文件夹建不出、退回用户文件夹、`root` = 用户文件夹不可用、落知识库根目录。
  出现 `root` 即代表「存在因降级而落在根目录的内容」，需人工归位。
- 任何降级都会同时写一条 `[ima]` / `[finalize]` 告警日志，不会被静默隐藏。

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

## 目录结构（ima 知识库「戒色」）

打卡内容不落根目录，而是收进**两层**文件夹（ADR-0008）：

```
「戒色」
└── <昵称原文>          ← 用户文件夹：登录时自动确保存在
    └── YYYY-MM-DD      ← 日期文件夹：提交打卡时自动确保存在
        ├── 打卡笔记     （media_type 11）
        ├── 运动截图     （media_type 9）
        └── 阅读录音     （media_type 15）
```

| 契约 | 取值 |
|------|------|
| 用户文件夹名 | **昵称原文，大小写敏感，不做任何归一化** —— 与 KV 键、榜单行、审计记录同一口径 |
| 日期文件夹名 | `YYYY-MM-DD`（Asia/Shanghai），与 KV 键及笔记标题使用同一种日期写法 |
| 内容标题 | **保持不变**（仍是 `<昵称>的打卡 YYYY-MM-DD` 等），跨文件夹检索时标题仍是日期线索 |
| 建档时机 | 用户文件夹在 `/api/verify`；日期文件夹在 `/api/finalize` 的任何 `add_knowledge` 之前 |
| 幂等 | 「先枚举父级、精确命中即复用，未命中才创建」，创建后**回读校验**；同一天重复提交不会产生第二个日期文件夹 |

成员不感知也不操作目录结构——结构由系统替其维护。已有历史内容保持原位不动（无迁移能力，见「已知限制」）。

---

## 安全与隐私

- **凭据只在服务端**：邀请码、管理密码、ima 凭据全部是 Pages Secret，不进前端代码、不入仓库。
- **管理密码比对使用常量时间算法**，消除时序侧信道；删除不携带任何长期密钥。
- **上传凭证最小化**：`/api/prepare` 只回传该次上传的预签名 `Authorization` 与临时 `token`，不泄露长期密钥。
- **删除边界**：站内删除只作用于 KV `checkin:*` 统计记录；ima 内容必须在 ima 客户端自行删除。
- **发布边界**：一律用 `deploy.sh` 白名单发布，线上只含 `index.html` / `app.js` / `styles.css` /
  `_headers` / `functions/`；`.dev.vars`、`.workbuddy/`、`wrangler.toml`、`docs/` 等一律不进线上站点
  （2026-09-25 凭据泄露事故后加固，见「快速开始 → 部署」）。
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
7. **空文件夹不可回收**：登录即建档，意味着昵称打错或中途放弃会留下空文件夹；OpenAPI 上不存在任何
   删除端点，只能到 ima 客户端人工删。若实践中变多，纠正成本极低——把建档时机从登录挪到入库即可。
8. **无自动归位能力**：`move_knowledge` 虽存在但实测在任何配置下都是空操作（`move_results` 为 `{}`），
   因此根目录下的历史内容只能由维护者在 ima 客户端手工拖拽。降级残留的识别信号是
   `finalize` 响应里的 `folder: "root"`。
9. **目录不可用时的降级**：ima 侧枚举或建文件夹失败时，内容会依次退到用户文件夹、知识库根目录
   （登录与打卡本身永不失败）；成员文件夹内超过 50 条时按 `is_end` 翻页查找，日常打卡只按名字
   查当天文件夹，不受影响。

---

## 验证方式

本站没有引入测试框架，验证采用四种手段（改动统计数据路径、打卡表单或目录结构时应照做）：

| 手段 | 做法 | 适用 |
|------|------|------|
| 桩化 KV 回归测试 | 用内存 KV 模拟「list 缓存定格 60s」「get 抛错」，直接 import 真实 handler 调用 | 统计、删除、标记逻辑 |
| 桩化 ima 回归测试 | 直调真实 handler，**出站 HTTP 用可编程假实现替代**（可指令化表现为正常 / 已存在同名 / 报错 / 静默落根），断言假实现收到的请求 | 目录结构、建档幂等、分层降级 |
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

**v1.1.0**（2026-09-25）—— 新增 ima 知识库内的两层目录（`<昵称>/<YYYY-MM-DD>/`），自动建档、分层降级、
打卡与登录永不因目录失败；同版一并加固部署边界（`deploy.sh` 白名单发布，修复凭据被公开发布的事故）：

| 项 | 内容 |
|-----|------|
| [ADR-0008](docs/adr/0008-two-level-folders-in-ima-kb.md) | 登录建用户文件夹、打卡建日期文件夹；`create_folder` 实测契约；**部分取代 0003**，`IMA_USER_FOLDERS` 回退路径退休 |
| 部署加固 | `deploy.sh` 只发布公开静态资源；删除全部含凭据的历史部署（无 ADR，属运维处置，记录见「快速开始 → 部署」） |

**v1.0.0**（2026-09-25）—— 首个稳定版，包含 0001–0007 全套架构决策：

| ADR | 决策 |
|-----|------|
| [0001](docs/adr/0001-reuse-survey-to-ima-architecture.md) | 复用 survey-to-ima 三层架构（静态前端 + Functions + ima OpenAPI） |
| [0002](docs/adr/0002-nickname-invite-code-auth.md) | 昵称 + 共享邀请码认证，不建用户表 |
| [0003](docs/adr/0003-per-user-ima-folders.md) | 内容按用户文件夹归档到 ima 知识库（验证结论已被 0008 取代） |
| [0004](docs/adr/0004-kv-stats.md) | 打卡统计存 Cloudflare KV，全员可见 |
| [0005](docs/adr/0005-browser-direct-upload.md) | 浏览器直传 COS，跳过服务器中转 |
| [0006](docs/adr/0006-admin-managed-deletion.md) | 删除权限收敛到管理员：独立管理密码 + KV 审计 |
| [0007](docs/adr/0007-kv-list-consistency-deletion-marker.md) | 删除标记绕开 KV list 最终一致延迟 |

相关文档：[CONTEXT.md](CONTEXT.md)（词汇表与架构总览）、[AGENTS.md](AGENTS.md)（协作约定）。

---

## 许可

私人项目，未附开源许可证。
