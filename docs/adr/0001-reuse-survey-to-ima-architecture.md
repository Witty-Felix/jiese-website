# ADR 0001 — 复用 survey-to-ima 三层架构

日期：2026-09-25
状态：已接受

## 背景

戒色打卡站需要把用户提交的内容（笔记、图片、录音）沉淀到 ima 共享知识库「戒色」。团队已有一套验证过的架构（见《调查问卷网站实现机理总结》）：纯静态前端 + Cloudflare Pages Function + ima OpenAPI，两个线上站点（survey-to-ima、xinghe-kb-survey）均稳定运行。

## 决策

完全复用该架构：

1. **前端**：无框架三件套（index.html / app.js / styles.css），不含任何密钥，提交目标为同源相对路径。
2. **后端**：Cloudflare Pages Functions（`functions/api/*.js`），ima 凭证存 Pages Secrets，不进代码、不进前端。
3. **落库**：ima OpenAPI——笔记走 `import_doc → add_knowledge`，图片（media_type=9）与录音（media_type=15）走 `create_media → COS 直传`。

## 理由

- 已踩过的坑全部有文档记录（Secrets 变更需重新部署、Key 月度轮换、1019 错误页判据等）。
- 同源 Pages Function 无 CORS 问题。
- 零数据库依赖即满足主链路（见 ADR 0004 的例外）。

## 后果与待验证项

- ⚠️ `create_media → COS 直传` 在本项目中为首次使用（现有两站只用过笔记），实现阶段需先做最小验证（先传一张图、一段录音到测试 KB）。
- ⚠️ 录音单文件 ima 上限 200MB/2 小时；Cloudflare 免费版请求体上限约 100MB，实际录音（朗读文章）通常仅数 MB，不构成问题，前端仍做体积校验。
- ima API Key 约 1 个月有效期，沿用现有轮换流程（put → redeploy → 端到端验证）。

## 验证结论（2026-09-25 更新：全链路已端到端跑通 ✅）

- `create_media` 请求体**不含 media_type**，字段为：`knowledge_base_id / file_name / file_size / content_type / file_ext`；返回 `media_id` + `cos_credential`（临时密钥，约 12h 有效）。
- **COS 直传签名要点**（对齐官方 `cos-upload.cjs`，ima-skills-1.1.2.zip）：
  - 签名头仅 `content-length` + `host`，值需 URL 编码，键名小写排序；
  - `HttpString = put\n/{cos_key}\n\ncontent-length=…&host=…\n`；
  - **`StringToSign = sha1\n{KeyTime}\n{sha1(HttpString)}\n` —— KeyTime 只出现一次**（写成两段会 SignatureDoesNotMatch，本次实现踩过）。
- `add_knowledge` 文件类：顶层 `media_id` + `file_info{cos_key, file_size, last_modify_time}`（不是 `media_info`）；图片=9、音频=15；音频 ≤200MB/2h，图片 ≤30MB。
- Workers 环境实测：Cloudflare Pages Function 内用 WebCrypto（HMAC-SHA1）完成 COS 签名可行，图片/音频/笔记三链路均在线上验证成功。
- 「戒色」KB 的 OpenAPI ID 为 **base64 形式**（与 ima 界面里显示的纯数字知识库 ID 不同源，两者不可互换）；
  取值经 `get_addable_knowledge_base_list`（需传 `{"limit":50}`）获得，实际值存放在 Cloudflare Secret `IMA_KB_ID`，
  **不写入仓库**（本仓库为公开仓库，资源标识同样不外泄）。
- 本机 `~/.config/ima` 凭证已于 2026-09-25 轮换更新；旧 Key（09-02 生成）当时已失效（报 `200002 skill auth failed`）。
