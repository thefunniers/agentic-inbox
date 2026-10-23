# 附件功能发布记录（2026-10-23）

## 本次改动

- 新建邮件、回复及转发支持多选、拖入和移除附件，显示文件名与大小；读取、保存及发送期间阻止重复操作。
- 草稿保留附件并维持同一个草稿 ID，重新打开或直接发送时恢复附件；转发默认复用原附件，允许增删。
- 收件附件支持中文文件名下载、图片预览及正文 CID 图片显示，预览失败时保留原文件下载入口。
- 前后端统一校验附件数量、编码与邮件大小；附件引用限定在当前邮箱，草稿写入使用事务，存储及发送失败会清理本次产生的数据。
- 发送成功以邮件服务的确认结果为准，失败保留编写内容；调用原生邮件绑定前将 base64 解码为原始字节，避免附件内容被重复编码。
- 补充附件收发、草稿事务、失败回滚及字节一致性回归测试，并记录正式部署和 Outlook 收件验证结果。

## 发布

- 正式站点：`https://inbox.jdtogo.ai`。
- Worker：`agentic-inbox`。
- 首次附件版本：`30d5abcf-272f-486f-a6d4-52f4665e5adf`；标签：`attachments-2026-10-23`。
- 当前版本：`8a083695-ed27-4f15-87c5-f0e9abdf4cb1`；标签：`attachment-bytes-2026-10-23`。`wrangler deployments list` 确认承接 100% 流量。
- 第二次发布时间：`2026-10-23T15:11:25.864Z`（北京时间 23:11:25）。
- 回滚目标：`15251c8e-d7d1-40f8-adc5-cd284274e830`。
- 发布命令：`npx --no-install wrangler deploy --message 'Complete attachment sending, receiving, drafts and forwarding (2026-10-23)' --tag attachments-2026-10-23`。
- 正式发布成功，16 个新增或变更的静态资源已上传；`wrangler deployments list` 确认新版本承接 100% 流量。
- 部署记录时间：`2026-10-23T15:00:02.437Z`（北京时间 23:00:02）。

## 验证

- `npm test`：首次 46 项通过；补充附件发送字节一致性回归后 47 项通过。
- `npm run typecheck`、`npm run build`、`npx --no-install wrangler deploy --dry-run`、`git diff --check`：通过。
- 发布后匿名访问首页、`/api/v1/mailboxes` 和 `/mcp`：均返回 HTTP 302，仍由 Cloudflare Access 保护。
- 本次未改变 Access 配置、Catch-all、两个受控域名或腾讯备份地址。

## 真实附件投递测试

用户要求从现有 `karlyang2001` 邮箱发往 `xtlys@outlook.com`。目录搜索 `karlyang` 唯一命中完整地址 `karlyang20000101@jdtogo.ai`，实际发件使用该地址。独立测试文件：

| 附件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `附件测试-2026-10-23.txt` | 328 字节 | `a45c55b5540c14fc2bae4245a9335407d7ce8b526194f618ebced9781edd862c` |
| `attachment-check-2026-10-23.png` | 21299 字节 | `200058d12ef3817eb62750207fe14bd7ac6f2458097fa932c3f492e66ae25314` |

用户已完成正式网页登录。浏览器扩展不具备本地文件 URL 访问权限，附件通过原生文件选择器成功多选上传，未修改扩展权限。

| 邮件 | 发送时间（北京时间） | 应用邮件 ID | 结果 |
| --- | --- | --- | --- |
| `附件功能上线测试 · 2026-10-23` | 23:04 | `db001ac0-d30e-4cdc-a7de-e8fc0c00d24a` | 正式站点显示 `Email sent!`；Outlook 已收到且显示两个附件。邮件最初进入垃圾邮件，已移至收件箱；取消了添加安全发件人的提示 |
| `附件功能复测（二）· 2026-10-23` | 23:11 | `5b2162ea-b5c6-4908-86dd-12efb6ffdb5d` | 从应用内转发原测试邮件并复用两个原始附件；编码调整版本上线后发送成功；Outlook 收件箱确认收到（界面时间 23:12），显示两个附件，下载文件完整性检查通过 |

首次收件时 Outlook 显示附件大小约 0.4 KB、27.7 KB，与原文件的 328 字节、21299 字节存在差异。为消除将 base64 字符串再次当作文件内容发送的歧义，`workers/email-sender.ts` 在调用原生邮件绑定前使用 `base64ToBytes` 还原附件内容。Cloudflare 的[官方文件上传示例](https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/#file-uploads)使用二进制 `ArrayBuffer` 传入附件；当前绑定类型同样支持 `ArrayBufferView`。

新增回归覆盖中文 UTF-8、全部 256 种字节值、PNG 和空文件，校验交给邮件服务的字节与应用附件下载字节一致。既有新建、草稿复用、回复与转发测试也改为校验原始字节。

收件侧核验已完成：用户将复测附件保存至 Downloads 后，两个文件的大小和 SHA-256 均与上表发送前原文件完全一致。Outlook 收件箱当前选中的第二封复测邮件显示 TXT 0.3 KB、PNG 20.8 KB，与下载文件一致。

用户反馈 PNG 似乎打不开后，进一步检查了下载文件：PNG 签名、各数据块 CRC、256 × 128 RGB 图像结构均正常，Pillow 的 `verify()` 和完整像素解码通过，macOS `sips` 识别正常。通过 macOS「预览」实际打开 `/Users/xtlys/Downloads/attachment-check-2026-10-23.png`，成功显示彩色渐变测试图，未复现打不开的问题。原文件、下载文件均未修改；本轮未再次发送邮件或部署。打开结果截图为 `attachment-test-20261023/downloaded-png-preview.png`。

第一封邮件显示的大小差异未另行下载核验，因此不根据界面大小认定第一封文件损坏。此前 Outlook 保存对话框的自动化导航问题已由用户手动下载解决；未绕过认证或读取客户端内部邮件数据库。

测试文件和截图保存在 Coda uploads 的 `attachment-test-20261023/`，不纳入代码提交。
