# 微信小程序媒体打卡验收记录

## 自动化覆盖

- `tests/miniprogram-checkin.test.cjs` 模拟原生选择器、`verify → prepare → readFile → COS PUT ×2 → finalize`、读取字节不一致、上传失败、取消日期重复登记和结果未知重交。
- `tests/miniprogram-upload-policy.test.mjs` 覆盖 100 MiB（`104857600` 字节）边界、边界加一字节、选择器扩展名和 `readFile` 字节断言。
- `tests/upload-channel.test.mjs` 与 `tests/submission-contract.test.mjs` 覆盖服务端 `wechat-miniprogram` 通道、`prepare`/`finalize` 双闸门、通道绑定和拒绝路径无副作用。

## 真机基线

仓库沿用 Issue #12 已记录的真机基线：MAA-AN00、Android 16、微信 8.0.78、基础库 3.17.3。该记录证明小文件链路可以完成
`chooseMessageFile → verify → prepare → readFile → COS PUT ×2 → finalize`；本次新增的小程序页面仍需在开发者工具和真机上按当前 `miniprogram/` 工程重新走一遍，尤其要确认服务器域名白名单和实际 COS 主机配置。

## 明确未覆盖项

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
