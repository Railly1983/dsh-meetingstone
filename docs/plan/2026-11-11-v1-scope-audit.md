# V1 范围核对（Scope Audit）

> 依据：`docs/V1-SCOPE.md`（2026-11-11 冻结）。只读审计，未改代码/配置/profile，未 commit。
> 结论：代码层暴露面基本收敛；用户文档、工具描述与设置页仍有超出 V1 的宣传或展示。

## 1. 工具暴露面

| 项 | 位置 | V1 归属 | 处理建议 |
| --- | --- | --- | --- |
| `autoRoute` | `src/dsh/register.js:544-549`；行为 `628-678` | 实验（默认关） | 保留默认关；描述/文档降级 |
| `routingRules` | `src/config.js:99-101`；`src/index.js:373-375` | 实验（默认关） | 仅 `autoRoute:true` 生效；文档标注 |
| `title/objective/scope/acceptance` | `src/dsh/register.js:551-568`；`src/taskspec.js:140-187` | V1（P0-3 任务协议） | 保留 |
| `evidence/contextRefs` | `register.js:569-578`；`taskspec.js:189-193` | V1（最小上下文） | 保留，不单列卖点 |
| `roleHint/outputBudget` | `register.js:579-587`；`taskspec.js:195-232` | 超出（P0-3 四要素之外） | 文档降级/隐藏 |
| `contextPack` | `register.js:588-593`；`taskspec.js:234-288` | V1（V1-SCOPE:81） | 保留，不单独宣传 |
| `cwd/isolation` | `register.js:594-600` | V1（P0-2/P0-4） | 保留；默认 `worktree` |
| `continuesFrom` | `register.js:601-605`；`src/context-replay.js:1-23` | V1 协议内 opt-in | 保留；发布说明不单列 |
| `list_roles.verbose` | `register.js:506-511` | V1（诊断开关） | 默认 false，保留 |
| `get_task.full` | `register.js:814-819` | V1（摘要优先） | 默认 false，保留 |
| `wait/list_runs/cancel/get_run_artifact/cli_status` | `register.js:883-941,786-804,1090-1117,943-1089,1118-1138` | V1（P0-1/P0-2/P0-3） | 保留 |

## 2. 配置暴露面

| 字段 | 位置 | 是否真实生效 | 处理建议 |
| --- | --- | --- | --- |
| `roles` / `channels` | `src/config.js:78-97` | 生效 | 保留 |
| `defaultRoleId` | `config.js:98`；`index.js:175`；`routing.js:387-421` | 仅 `autoRoute` 兜底生效 | 修正描述：不是"未指定角色的默认" |
| `routingRules` | `config.js:99-101` | 仅 `autoRoute` 生效 | 标实验 |
| `dispatchNotes` | `config.js:102`；`gui/host.js:256` | 只读展示，派单未消费 | 设置页降级或标 advisory |
| `projectConfigFile` | `config.js:103-105` | 生效 | 保留 |
| `limits.*` | `config.js:106-124`；`dispatcher.js:431-435` | 3 项全部生效 | 保留；UI 展示属超出 |
| `fallbackRoleId` | `config.js:86` | 解析但不消费（"只提示"也无实现） | 标保留字段或删除 |
| 会话级 `defaultRoleId/dispatchNotes/projectRules` | `src/session/config.js:32-39,772-818` | 仅 `defaultRoleId` 进 autoRoute；后两项不消费 | 文档降级 |

## 3. 脚本、文档与面板

- 账本 `scripts/token-ledger.mjs`（`package.json:24`，未进 `verify`：`package.json:29`）：V1-SCOPE:77 定为开发工具；但 `docs/efficiency.md:111-137` 作为用户能力介绍 → 文档降级。
- A/B `scripts/measure-tool-output.mjs`（`package.json:23`）与 `docs/plan` 报告：V1-SCOPE:78 允许的简单脚本；报告自述"不构成 Token 节省结论"（`2026-11-11-p0a-ab.md:190`；`2026-11-11-tool-output-baseline.md:8-12`）→ 保留，不算产品宣传。
- 跨宿主 POC：`docs/cross-host/*`（V1-SCOPE:82 暂缓）；README 未链接，npm `files` 不含 docs（`package.json:12-16`）→ 保持归档。
- 三个原生面板：client 只注册 `settings.section` / `conversation.session.header.actions` / `sidebar.right.pane.tab(.title)`（`src/client/index.js:1016-1021`），无自建任务/会话/进程面板；任务列表用原生 Jobs（`docs/gui-0.2.0.md:3-5`；`src/dsh/adapter.js:55-65,739-791`）→ 合规。
- 文档漂移：`docs/gui-0.2.0.md:7-9` 称设置页只有三段，实际渲染 CLI/角色/模型/额度/规则/错误六段（`src/client/index.js:609-633`）。

## 4. 默认行为（已核对）

- 不传 `role` 且不传 `autoRoute` → `ROLE_REQUIRED`，不触达 dispatcher（`register.js:638-645`；`dispatcher.js:625-633`；`tests/routing.test.mjs:338-345`）。
- 传 `role` 时即使 `autoRoute:true` 也显式优先，不走规则（`register.js:671-677`；`tests/routing.test.mjs:329-337`）。
- 不传 `autoRoute` 绝不自动路由；`defaultRoleId` 只在 `autoRoute:true` 分支读取（`routing.js:387-421`）。
- 免轮询：`wait` 明确"不要高频调用/不要轮询"（`register.js:885-889`）；文档同口径（`architecture.md:88-89`；`release/0.1.0-alpha-checklist.md:62`）。
- 验证：`node --test tests/routing.test.mjs tests/config.test.mjs tests/gui.test.mjs` → 41 pass / 0 fail；`node scripts/verify-host-schema.mjs` → PASS（8 工具）。

## 5. 与 V1-SCOPE 不一致

1. **V1-SCOPE:46 与实现冲突**：写"未指定用默认角色"，实际未指定即 `ROLE_REQUIRED`；`defaultRoleId` 仅 autoRoute 兜底。建议改为"未指定必须显式报错，或传 `autoRoute:true`"。
2. **工具描述假数字**：`dispatch` 称"默认并行上限 2/项目、4/全局"（`register.js:529`），但按项目额度已删除（`docs/plan/2026-11-11-briefing.md:138`；`CHANGELOG:42`；`dispatcher.js:526-561` 只查全局）。
3. **自动路由仍被当 V1 卖点**：`configuration.md:48-110` 有完整章节+示例，`efficiency.md:146-149` 称"已作为代码级派单功能落地"，`dispatch` 描述 `533-535` 详述 P1-B；与 V1-SCOPE:76"文档不作为 V1 卖点"不符。
4. **账本仍写进用户文档**：`efficiency.md:111-137` 的 §5 与 V1-SCOPE:77"仅开发工具"不符；两份文档由 `README.zh-CN.md:52-53` 作为正式文档链接。
5. **Handoff 被单列**：`release/0.1.0-alpha-checklist.md:62` 把 `continuesFrom` 列入 Added 主打项；V1-SCOPE:81 要求"不单独宣传"。
6. **设置页多出配置面**：UI 展示 `limits`/`dispatchNotes`（`client/index.js:557-578,628-631`），V1-SCOPE:8-14 未列，`gui-0.2.0.md:7-9` 也声称只有三段。
7. **两份用户文档损坏**：`docs/configuration.md`、`docs/efficiency.md` 首行即双字节乱码（UTF-8 解码为"閰嶇疆…"），无法作为发布文档；HEAD 提交 `622a0a9` 引入，`HEAD~1` 可读。
8. **工具数/UI 状态过期**：`README.md:9,11`、`CHANGELOG.md:65,85`、`architecture.md:23` 仍写"六个工具/无 UI"；`architecture.md:37` 仍写"同项目默认串行"。
9. **V1 欠账（非超范围）**：V1-SCOPE:9 要求 CLI"连接检测与启停"；设置页只有只读检测（`client/index.js:414-457`），无启停控件。若由 profile 行启停承担，需在文档写明。

## 6. 结论与最小改动

- **已收敛**：autoRoute 默认关、role 缺失明确报错、默认免轮询、无自建面板、脚本/跨宿主未进 V1 发布面。
- **未收敛**：自动路由与账本仍在用户文档中作为能力介绍；工具描述有错误并发数字；设置页多出 limits/dispatchNotes；V1-SCOPE:46 与实现冲突；两份核心文档损坏。
- **最小改动（建议，本次未做）**：
  1. 文档：修 `configuration.md`/`efficiency.md` 编码（以 `HEAD~1` 为底稿重做降级），把 §1.2/§5 标实验或移入 dev 文档；删 release checklist:62 的 continuesFrom 单列；改 V1-SCOPE:46。
  2. 文案：`register.js:529` 的"2/项目"改为"4/全局"或删除；精简 `533-535` 的 P1-B 说明；`config.js:98` 描述改为"仅 autoRoute 兜底"。
  3. UI：把 limits/dispatchNotes 段标为"只读诊断"或移除；`roleHint/outputBudget` 不写进发布说明。
  4. 清理：README/CHANGELOG/architecture 的 6 工具与无 UI 表述统一为 8 工具 + 只读 GUI。
- 本次未改任何代码/配置；报告仅为审计结论。
