# 来信副本：dev 验收与运维

本次故障邮件实际已到腾讯，被归入垃圾箱；已恢复到 apply 收件箱并核对学校发件人白名单。原转发代码吞掉失败、没有重试是另一个独立缺口，不能作为本次漏看邮件的原因。实际学生邮件与邮件头仅存放在本机取证目录，不提交仓库。

## 当前范围

- 新通知由 `inbox-notify@jdtogo.ai` 发出，主题及正文显示实际投递的学生邮箱；原始邮件作为 `original.eml` 附件，保留正文、邮件头和附件字节，支持没有 To 的密送邮件。
- 原文先保存在 R2，任务与闹钟持久化；Inbox 使用稳定 ID 防止重试重复入库。每个学生邮箱独立去重，不自动补发历史邮件。
- 已明确未接受的限流、日配额和发送未就绪错误最多尝试 5 次，间隔 1、2、4、8 分钟。配置/收件人拒绝直接停止；连接异常或发送中断视为结果未知，避免盲目重复发信。
- `/deliveries` 展示状态、错误、处理记录、原文下载及核对后重试。首页有待处理提示，提醒目前限于应用内和 Worker 日志，没有另发飞书/短信告警。
- “已提交发送”只表示 Cloudflare 接受请求，不证明目标邮箱已收录。人工重试前必须核对目标邮箱，特别是发送结果未知时。

## Dev 隔离与复现

`wrangler.dev.jsonc` 使用独立 Worker `agentic-inbox-dev`、R2 `agentic-inbox-dev-backup` 和 DO 命名空间，域名为 `https://inbox-dev.jdtogo.ai`。仅接受 `@dev.jdtogo.ai`，发送绑定固定到 `dev@jdtogo.com`。dev 验收阶段没有切换现有 Email Routing 或生产 Worker；后续生产发布见下文。

开发部署全部请求使用专用 `DEV_TEST_TOKEN` Bearer 鉴权；匿名访问返回 403。测试凭据由安全流程配置，禁止提交或贴进日志。生产仍使用原 Cloudflare Access 鉴权。

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
INBOX_CONFIG=wrangler.dev.jsonc npm run build
# 部署前确认生成配置的 name 是 agentic-inbox-dev
npx wrangler deploy --config build/server/wrangler.json --dry-run
npx wrangler deploy --config build/server/wrangler.json
node scripts/test-backup-dev.mjs
```

在线测试脚本从忽略目录 `.import-state/dev-test-token` 读取凭据，测试数据及回执写到 `.import-state/backup-dev/`。固定 Message-ID 保证重复运行不会多发通知；脚本只使用合成内容。通过仅 dev 存在的受保护入口注入原始 MIME，调用与 Email handler 相同的处理器；这不等同于真实 SMTP 入站路由验收。

已验证：无 To 的邮件进入 dev Inbox；通知进入腾讯 dev 收件箱；下载腾讯收到的通知后，`original.eml` 的 472 字节与输入完全一致；重复注入无二次发送/重复入库；投递列表、空分页参数、未登录拒绝和生产收件地址拒绝均通过。workerd 覆盖重试耗尽、永久失败、发送结果未知和人工重试。

## 生产发布与待确认事项

腾讯测试邮件头报告 SPF pass，但同时报告自有域名 DKIM 验证异常及 `dmarc=none(permerror)`。Cloudflare 控制台显示发信域名 Enabled / DNS Configured；公共 DoH 能取到 DKIM 与 DMARC 记录；对腾讯导出的邮件独立验证，两组 DKIM 签名均通过。当前证据无法解释腾讯的认证结果，不能宣称认证验收全部通过，也不应盲目放宽 DMARC。需要后续再投递样本、核对腾讯收信日志，必要时由腾讯/Cloudflare 支持排查。

2026-11-18，用户明确要求先上线、认证问题待调研后处理。生产已部署合并提交 `2a7d566adb0125623aa0373663e38dbf2b2e6382`，版本 `23c5f178-ebfa-472d-8219-074b90764758`，启用新副本模式。

本次将已发布的配置同步进 `wrangler.jsonc`：`BACKUP_MODE=notification`、`BACKUP_FROM=inbox-notify@jdtogo.ai`、`BACKUP_DELIVERY` 绑定及 v5 SQLite DO migration。保留 v1–v4、现有 R2、邮箱命名空间、Access 和收件目标；正式地址仍投递到 apply，dev 地址仍投递到 dev。此配置回写不再次部署，也不修改 DNS 或发送邮件。

发布后读取 Cloudflare 版本元数据，确认四个原有 DO 命名空间 ID 与 Access 密钥绑定均保留，新绑定及 v5 已生效；生产主页匿名请求返回登录跳转（HTTP 302）。尚未验证上线后首封生产邮件的 apply 实收及邮件头，不能将配置核对视为端到端收信验收。首封实收和腾讯认证结果继续跟进。

已部署版本的前后元数据、实际发布配置和部署日志保存在本机 uploads 的 `production-backup-release-20261118/`，不包含密钥值，不提交到仓库。常规 `npm run build` 生成的配置应与该次发布的变量、资源绑定及迁移一致；生产继续使用已有 Access 密钥，不引入 dev 测试令牌。

配置回写验证：`npm run build` 和生成配置的 Wrangler `deploy --dry-run` 均通过；逐项比较生成配置与已发布配置，变量、DO/R2/发信绑定、全部迁移、路由及兼容性设置一致。没有重跑与本次配置改动无关的业务测试，没有再次执行实际部署。

回退时先停止新流量进入通知模式，再检查已有未完成任务；仅删除 `BACKUP_MODE` 不会取消已持久化任务。不要删除 R2 原文、DO 任务或历史迁移。历史邮件不自动补发，确认未送达后才逐封处理。

## PR #1 评审修复验证

- 入库 RPC 报错后先查询邮件是否已提交。只有明确未提交才清理本次附件；已提交或查询结果未知时保留附件并明确报错，随后稳定 ID 重试可安全去重。
- 已提交发送的任务为索引清理保留持久化闹钟；R2 删除失败会记录错误并继续重试，清理不会再次发送通知。待处理查询过滤权威状态并跨页补足结果，不让已成功或已转为待执行的旧索引挡住后续失败。
- 最小回归命令：`node --experimental-strip-types --test tests/attachments.test.mjs tests/backup.test.mjs`，26 项通过。将这组测试放回 `3dbc427` 的修复前源码，出现 3 项失败；修复后验证了提交前清理、提交后错误/状态查询失败时附件不丢、连续两次索引删除失败后恢复、超过 50 条残留索引后的告警可见。
- 本次 `npx tsc -b` 与 dev 构建通过；既有正常投递与腾讯收信证据复用，不重复发送测试邮件。腾讯认证结果核对仍未完成，用户已决定先上线。

### 索引写入持续失败的恢复

后续交叉评审发现，未完成任务的索引写入异常仍可能耗尽平台重试。现改为执行外部 I/O 前先保存恢复闹钟，索引写入失败时记录错误和下次处理时间后返回；尚未到期的发送重试继续保留原定时间，终态不再执行无用的发现索引写入。

复用已有附件恢复、腾讯实收和 EML 完整性证据。本次最小回归为 `node --experimental-strip-types --test tests/backup.test.mjs`：先让发送限流，再模拟连续 8 次索引写入失败；每次先消费旧闹钟，确认均创建新的持久化唤醒、发送次数保持不变，故障恢复后发送成功且没有重复入库。旧源码 `e543691` 在该回归上失败，修复后通过；类型检查和 dev 构建也通过。测试不依赖等待真实时间或外部邮件服务。

实现遵循 [Cloudflare 闹钟异常处理说明](https://developers.cloudflare.com/durable-objects/api/alarms/)：需要持续恢复的操作不能仅依赖平台有限次数的异常重试。
