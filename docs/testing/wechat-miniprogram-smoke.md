# 微信小程序媒体打卡验收记录

## 自动化覆盖

- `tests/miniprogram-checkin.test.cjs` 模拟原生选择器、`verify → prepare → readFile → COS PUT ×2 → finalize`、读取字节不一致、上传失败、取消日期重复登记和结果未知重交。
- `tests/miniprogram-upload-policy.test.mjs` 覆盖 100 MiB（`104857600` 字节）边界、边界加一字节、选择器扩展名和 `readFile` 字节断言。
- `tests/upload-channel.test.mjs` 与 `tests/submission-contract.test.mjs` 覆盖服务端 `wechat-miniprogram` 通道、`prepare`/`finalize` 双闸门、通道绑定和拒绝路径无副作用。

## 真机基线

仓库沿用 Issue #12 已记录的真机基线：MAA-AN00、Android 16、微信 8.0.78、基础库 3.17.3。该记录证明小文件链路可以完成
`chooseMessageFile → verify → prepare → readFile → COS PUT ×2 → finalize`；本次新增的小程序页面仍需在开发者工具和真机上按当前 `miniprogram/` 工程重新走一遍，尤其要确认服务器域名白名单和实际 COS 主机配置。

## 初始未覆盖项（历史记录，已由后续真机验收补齐）

- 尚未在真机上实际读取 **100 MiB** 录音；100 MiB 精确边界与超过 1 字节目前只有自动化策略和端点测试覆盖。
- 未把 `api.324614917.xyz` 的 DNS/HTTPS、微信服务器域名白名单和发布审核条件当作代码测试结果；这些属于部署环境验收。
## 2026-10-05 真机小文件链路

用户提供的真机截图显示：

- 小程序已连接，提示“服务器正常”；
- 运动截图已经选中；
- 阅读录音选择成功后不再出现类型错误；
- 页面显示“打卡成功：截图、录音和感悟已登记”。

这证明当前工程在真机上至少完成了一次小文件完整提交路径。截图没有展示具体 HTTP 响应体、设备型号、微信版本或音频文件字节大小，因此这些字段仍不写成独立的协议证据。

仍未覆盖：100 MiB 录音压力场景、正式版 `api.324614917.xyz` 的 DNS/HTTPS 与服务器域名白名单验收。
## 2026-10-05 真机 100 MiB+1 字节拒绝

用户在真机选择 `reading-100MiB-plus-one.wav` 后，页面显示：

```text
微信小程序录音不得超过 100 MB
```

截图同时显示录音没有落入已选材料区，提交按钮仍不可用。该结果证明客户端选择回调闸门生效；“不调用 prepare”由自动化测试和服务端无副作用测试覆盖，真机截图本身不作为网络调用日志。
## 2026-10-05 精确 100 MiB 上传

用户在真机选择了 `reading-100MiB.wav`，页面显示文件大小为 `104857600` 字节，精确等于 100 MiB。

- 前两次提交在 COS 直传阶段显示“材料直传网络错误，请重试”；
- 第三次提交成功显示“打卡成功：截图、录音和感悟已登记”。

这证明精确 100 MiB 文件可以通过选择闸门并最终完成完整提交。前两次属于 COS PUT 阶段的**已知上传失败**，不是 `finalize` 回执丢失的“结果未知”；因此客户端没有保存 finalize 重交检查点，后续重新 prepare/上传属于当前契约的预期行为。

该结果不代表大文件网络上传具备稳定性保证；正式发布前仍需保留失败提示，并继续观察真实网络环境下的成功率。

## 2026-10-06 正式版 M4A prepare 故障修复

- 正式版用户提交 M4A（audio/mp4）时提示“服务器返回无法解析的响应”。
- 已复现：Pages prepare 返回 ima create_media 的 invalid media_type；自定义域名返回非 JSON HTTP 502。
- 排除此前错误假设：create_media 不需要 media_type；补充该字段并未修复，已撤回。
- 官方 ima 1.1.10 api.md 列出 M4A MIME 为 audio/x-m4a，WAV 为 audio/wav。
- 修复：仅在服务端 createMedia 边界归一化 audio/mp4 → audio/x-m4a、audio/x-wav → audio/wav；保留客户端契约与 COS PUT 行为。
- 新增 tests/ima-media-mime.test.mjs；修复前测试失败，修复后 npm test 10/10 通过。
- 已白名单部署；专属部署 5b8133ac.jiese-checkin.pages.dev 与 api.324614917.xyz 的 prepare 均返回 HTTP 200、JSON ok:true（使用 JPEG 526208 字节与 M4A 4811985 字节元信息）。未输出临时上传凭据。
- 此次探测仅申请临时媒体，没有上传附件或调用 finalize，不等于正式真机全链路通过。
- 返回的 COS 主机：ima-share-kb-1258344701.cos.accelerate.myqcloud.com。正式真机仍须验证 request 合法域名覆盖实际 COS 主机。
- 待验收：正式版关闭调试/不绕过域名校验后完成图片、录音直传及 finalize；备案状态另行确认。Issue #32 尚不应关闭。


## 2026-10-06 正式版完整提交及 ima 核验

- 用户按正式小程序码打开小程序，提交后截图显示“打卡成功：截图、录音和感悟已登记”。
- 用户随后确认 ima 中各项材料存在，录音可正常播放。至此旧版手动上传交互的正式版端到端测试通过。
- 此证据不等于异常分支全部经过真机故障注入，也不证明备案已通过。

## 2026-10-06 Issue #32 自动上传交互补齐（待新版本真机验收）

- 每次选择返回立即校验；两份材料齐备后直接自动 verify → prepare → readFile → COS PUT ×2，无额外确认/暂存页面。
- 当前 API prepare 必须同时接收两份材料元信息，第一份选择后等待另一份；不拆分后端契约。
- 上传与登记分离：uploaded 检查点保存原 submission_id/媒体回执，感悟仍可编辑；点击提交才冻结感悟并调用 finalize。
- finalize 结果未知继续手动重交，固定原感悟/回执/通道，不重新 prepare 或 PUT。旧版本无 phase 的检查点按结果未知处理。
- 新增实际 Page 选择回调回归：第二份选择后自动两次 PUT、无 finalize；手动提交采用最新感悟，无重复 prepare/PUT。覆盖重载与结果未知后感悟冻结。
- 尚未把本次小程序交互改动上传或发布。需开发者工具编译/预览，真机验证自动上传、填写感悟、最终登记以及重复日期确认，然后上传新版本。
- 精确 100 MiB/超限边界真机已有历史证据，不重复声称新交互压力场景已经验证。
