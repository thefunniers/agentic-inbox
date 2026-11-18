# 来信副本：dev 验收与运维

本次故障邮件实际已到腾讯，被归入垃圾箱；已恢复到 apply 收件箱并核对学校发件人白名单。原转发代码吞掉失败、没有重试是另一个独立缺口，不能作为本次漏看邮件的原因。实际学生邮件与邮件头仅存放在本机取证目录，不提交仓库。

## 当前范围

- 新通知由 `inbox-notify@jdtogo.ai` 发出，主题及正文显示实际投递的学生邮箱；原始邮件作为 `original.eml` 附件，保留正文、邮件头和附件字节，支持没有 To 的密送邮件。
- 原文先保存在 R2，任务与闹钟持久化；Inbox 使用稳定 ID 防止重试重复入库。每个学生邮箱独立去重，不自动补发历史邮件。
- 已明确未接受的限流、日配额和发送未就绪错误最多尝试 5 次，间隔 1、2、4、8 分钟。配置/收件人拒绝直接停止；连接异常或发送中断视为结果未知，避免盲目重复发信。
- `/deliveries` 展示状态、错误、处理记录、原文下载及核对后重试。首页有待处理提示，提醒目前限于应用内和 Worker 日志，没有另发飞书/短信告警。
- “已提交发送”只表示 Cloudflare 接受请求，不证明目标邮箱已收录。人工重试前必须核对目标邮箱，特别是发送结果未知时。

## Dev 隔离与复现

`wrangler.dev.jsonc` 使用独立 Worker `agentic-inbox-dev`、R2 `agentic-inbox-dev-backup` 和 DO 命名空间，域名为 `https://inbox-dev.jdtogo.ai`。仅接受 `@dev.jdtogo.ai`，发送绑定固定到 `dev@jdtogo.com`。没有切换现有 Email Routing 或生产 Worker。

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

## 上线前尚需确认

腾讯测试邮件头报告 SPF pass，但同时报告自有域名 DKIM 验证异常及 `dmarc=none(permerror)`。Cloudflare 控制台显示发信域名 Enabled / DNS Configured；公共 DoH 能取到 DKIM 与 DMARC 记录；对腾讯导出的邮件独立验证，两组 DKIM 签名均通过。当前证据无法解释腾讯的认证结果，不能宣称认证验收全部通过，也不应盲目放宽 DMARC。需要后续再投递样本、核对腾讯收信日志，必要时由腾讯/Cloudflare 支持排查。

生产 `wrangler.jsonc` 保持旧转发路径，本次没有启用新副本模式。通过 dev 验收并批准上线后，另行加入生产 `BACKUP_DELIVERY` 绑定和下一版本 SQLite DO migration，设置 `BACKUP_MODE=notification` 与 `BACKUP_FROM`，核对生产收件目标、发信额度、Access 以及真实 SMTP 路由。不要把 dev 的新命名空间 migration 覆盖生产已有迁移。切换后的第一封必须核对 apply 实收及邮件头。

回退时先停止新流量进入通知模式，再检查已有未完成任务；仅删除 `BACKUP_MODE` 不会取消已持久化任务。不要删除 R2 原文、DO 任务或历史迁移。历史邮件不自动补发，确认未送达后才逐封处理。
