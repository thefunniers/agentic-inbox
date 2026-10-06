# Agentic Inbox 实现记录

更新时间：2026-10-06

## 已确认的产品决策

- 生产域名：`inbox.jdtogo.ai`。
- 受控邮箱域名：`jdtogo.ai` 和 `dev.jdtogo.ai`。两域都入库；根域备份到 `apply@jdtogo.com`，`dev` 子域备份到 `dev@jdtogo.com`。
- 新邮件到达不存在的内部收件地址时，自动创建邮箱；初始状态为 `unassigned`，允许运营人员直接看到并后续绑定申请案例。
- 管理员和运营人员使用独立邮箱账号登录，第一阶段共用相同权限策略。
- 学生端展示由业务前台审核后提供，不直接暴露 Agentic Inbox 原始邮件页面。
- 腾讯历史邮件导入放在第二阶段，一次性执行；不阻塞第一阶段上线。
- 企业微信认证放在第二阶段；第一阶段先使用 Cloudflare Access 配置的邮箱登录。
- MCP 保留实现，但第一阶段默认关闭，后续单独开放 Agent 服务权限。
- 暂不做腾讯已发送邮件备份。

## 阶段一：基础系统运行

状态：阶段一部署已完成。Catch-all 指向 `agentic-inbox`，旧 Worker 保留作回滚。

已完成：

- 检查项目结构、Wrangler 配置和现有 Worker 邮件处理逻辑。
- 将 `DOMAINS` 从示例值改为 `jdtogo.ai`。
- 增加 `inbox.jdtogo.ai` Worker Custom Domain 配置。
- 增加 `MCP_ENABLED=false`，MCP 路由默认返回 404。
- 增加可配置的 `BACKUP_EMAIL` / `BACKUP_DEV_EMAIL`，让 Agentic Inbox 接管 Catch-all 后仍向腾讯企业邮箱转发来信；原 `jdtogo-email-router` 保留为回滚目标。
- 收件处理改为优先使用 Cloudflare Email Worker 的 envelope recipient。
- 收件地址限制为 `DOMAINS` 中的受控域名。
- 收到不存在的内部地址时自动创建 `unassigned` 邮箱并初始化 Durable Object 文件夹。
- 保留 `EMAIL_ADDRESSES` 作为可选的严格地址白名单。
- `npm ci` 完成；`npm run typecheck` 通过。
- `npm run build` 通过；`npx wrangler deploy --dry-run` 通过，确认 Worker、R2、Workers AI、Durable Objects、Email Sending 和环境变量绑定均能生成部署包。

上线操作步骤：

现有邮件路由只有一条规则：匹配类型 `all` 的 Catch-all，动作是发给 `jdtogo-email-router`。`dev.jdtogo.ai` 已在本 Zone 开通且状态为 `ready`，所以这条根域 Catch-all 已经把子域邮件送进旧 Worker。不能另建 `*@dev.jdtogo.ai`。把这一条改到 `agentic-inbox` 后，两个域一起进来。

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 填 `BACKUP_EMAIL=apply@jdtogo.com`、`BACKUP_DEV_EMAIL=dev@jdtogo.com`，preview 桶改为 `agentic-inbox-preview`，`DOMAINS` 包含 `jdtogo.ai,dev.jdtogo.ai` | ✅ 已完成 |
| 2 | 创建 R2：`agentic-inbox`、`agentic-inbox-preview`。原有 `static`、`studyreport` 保留 | ✅ 已完成 |
| 3 | 新终端中不再设置 `CF_API_TOKEN`、`CLOUDFLARE_API_TOKEN`、`CF_ACCOUNT_ID`，`cf` OAuth 可用 | ✅ 已完成 |
| 4 | 在项目目录执行 `npx wrangler deploy`。配置里不要加 `addresses`，这次部署不改 Catch-all | ✅ 已完成 |
| 5 | 给网页 `inbox.jdtogo.ai` 配 Access，并用 `npx wrangler secret put` 写入 `POLICY_AUD`、`TEAM_DOMAIN`。缺这两项只影响网页，不影响收信 | ✅ 已完成 |
| 6 | 可选：`luyunsong@jdtogo.ai` 测试规则已用完并删除。21:14 测试信已入库；该地址现在走 Catch-all | ✅ 已完成 |
| 7 | 把现有 Catch-all 从 `jdtogo-email-router` 改到 `agentic-inbox`。`@jdtogo.ai` 和 `@dev.jdtogo.ai` 都会进来。旧 Worker 保持部署，回滚就是把 Catch-all 指回去 | ✅ 已完成 |
| 8 | 切流后 `wangwenxuan@jdtogo.ai` 与 `wangwenxuan@dev.jdtogo.ai` 都已自动建邮箱。网页、Access 登录已确认，MCP 保持关闭 | ✅ 已完成 |

切过去之后的处理：先看收件人是不是 `@dev.jdtogo.ai`，是就转发到 `dev@jdtogo.com`，否则转发到 `apply@jdtogo.com`，然后写入 Agentic Inbox。`alice@dev.jdtogo.ai` 和 `alice@jdtogo.ai` 是两个邮箱。

## 阶段二：历史导入与企业微信认证

状态：未开始

- 使用腾讯 IMAP 或 EML 导出做一次性导入工具。
- 保留原始 MIME、附件、邮件头、Message-ID、文件夹和导入批次。
- 从历史邮件中提取 `jdtogo.ai` 内部收件地址并创建邮箱。
- 增加导入断点、去重和失败重试。
- 接入企业微信作为 Cloudflare Access 身份源或 OIDC/SAML 身份提供方。
- 增加员工、案件、邮箱绑定和审计记录。
- 为学生小程序/App 提供审核后的业务 API。
- 评估 MCP 的 Service Auth、Agent 邮箱范围和发送权限。

## 当前状态

2026-10-06 已执行 `npm run build` 和 `npx wrangler deploy`。自定义域名 `inbox.jdtogo.ai` 已创建。2026-10-06 21:20 之后，Catch-all 已改指向 `agentic-inbox`。`jdtogo-email-router` 仍部署着，回滚是把 Catch-all 指回去。

Access 应用名 `Agentic Inbox`，域名 `inbox.jdtogo.ai`，登录方式是一次性验证码。目前只允许 `xtlys@outlook.com`，因为账号里只有这一位成员，没有另给运营邮箱名单。`POLICY_AUD` 和 `TEAM_DOMAIN` 已写入 Worker secret。`TEAM_DOMAIN` 是 `https://xtlys.cloudflareaccess.com`。

2026-09-20 到 2026-09-21 的认证失败来自 shell 里的旧 `CF_API_TOKEN`。这些变量已从 `~/.zshrc` 移除。2026-10-06 确认新登录 shell 中 `CF_API_TOKEN`、`CLOUDFLARE_API_TOKEN`、`CF_ACCOUNT_ID` 均未设置，`cf` 可使用 OAuth 列出并创建 R2。

已创建的 bucket：`agentic-inbox`、`agentic-inbox-preview`，以及原有的 `static`、`studyreport`。Worker 已部署。邮件路由现在只剩 Catch-all，指向 `agentic-inbox`。`luyunsong@jdtogo.ai` 的单独规则已删除。`jdtogo-email-router` 仍在账号里，作回滚用。

2026-10-06 21:14 收到 `xtlys@outlook.com` 发给 `luyunsong@jdtogo.ai` 的测试信，主题是 Test inbox。R2 记录于 13:14:35Z 自动创建，状态 `unassigned`。Worker 日志没有备份失败。腾讯 `apply@jdtogo.com` 已确认收到副本，并从 Inbox 成功回复到 `xtlys@outlook.com`。


2026-10-06 21:25 确认切流后的两个域都入库：`wangwenxuan@jdtogo.ai`、`wangwenxuan@dev.jdtogo.ai`，以及早先的 `luyunsong@jdtogo.ai`。阶段一部署配置到此完成。
`dev.jdtogo.ai` 已加入 `DOMAINS`。Catch-all 现已指向 `agentic-inbox`，根域和子域都会进入新 Worker：子域备份到 `dev@jdtogo.com` 并入库，根域备份到 `apply@jdtogo.com` 并入库。不能另建 `*@dev.jdtogo.ai`。
