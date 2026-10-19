# 邮箱功能修复（2026-10-20）

范围：修复 2A-BUG-1（长关键词搜索）和 2A-BUG-2（回复引用）；依本轮要求，不处理 Inbox 单边邮件及重复投递。

## 变更

- 搜索的 query、from、to、subject 全部改为参数绑定的 `INSTR(LOWER(...), LOWER(...))` 字面子串匹配，保留原有 ASCII 大小写不敏感行为。结果列表和总数共用筛选构造逻辑，不修改邮件或表结构。
- 原来的 `%关键词%` 模式会触及 Durable Objects 的 [LIKE/GLOB 50 字节限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。使用 [SQLite INSTR](https://www.sqlite.org/lang_corefunc.html#instr) 后，中文和长主题不再触及该模式限制；`%`、`_` 作为普通字符搜索。
- 搜索请求失败时显示 `Search failed` 和重试按钮，不再显示 0 条结果；失败状态隐藏结果计数与分页。
- 前端回复、回复全部、转发及服务端邮件文本统一使用 `htmlparser2` 提取正文。排除 head、style、script、XML、模板和注释，保留段落、换行、表格文字并解码 HTML 实体。进入编辑器前仍转义文本。
- 不重写已存邮件、附件或历史导入数据，不改变路由、备份、Access 或 MCP 配置。

## 验证

| 项目 | 结果 |
| --- | --- |
| 修复前线上复现 | 2026-10-20 已登录 API：49 个 ASCII 字符的 query 返回 500 |
| 自动回归 | 14 项通过；覆盖 48/49/500 字节、长中文、emoji、4 类文本筛选、字面通配符、引号、空 Cc/Bcc、组合筛选、分页及总数 |
| 引用回归 | Office 样式/元数据、脚本、注释、不完整 HTML、HTML 实体、段落、列表、表格和纯文本均通过 |
| 历史正文转换 | 133 封本地 EML 全部生成非空引用正文；其中 84 封含 style，未发现已知 CSS/Office 元数据泄漏；明细在忽略目录 `.import-state/mailbox-fixes-2026-10-20/quote-corpus.json` |
| 类型检查 | `npm run typecheck` 通过 |
| 依赖锁定 | `npm ci --ignore-scripts --dry-run` 通过；既有依赖版本未升级 |
| 构建及部署预检 | Coda `run-held`：`e6a8e8a9-23f2-444a-a0c4-7369854d1d36`，待返回 |
| 正式部署与网页复测 | 待构建通过后执行 |

自动测试：`npm test`。原始验收结果保留在 [2A_ACCEPTANCE_2026-10-20.md](2A_ACCEPTANCE_2026-10-20.md)，不覆盖修复前失败证据。
