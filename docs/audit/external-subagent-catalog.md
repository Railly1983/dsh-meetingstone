# 外部 CLI 任务进入 Subagents 面板：官方路径核查

| 项 | 内容 |
| --- | --- |
| 日期 / 角色 | 2026-11-11 · 八戒（技术主管） |
| 范围 | 只读取证：`app.asar`、profile 内 provider 包、本机会话日志；不改代码、不 commit、不重启 |
| 宿主 | DSH `0.2.2-rc.1`；证据路径前缀 `app.asar/dsh/node_modules/@deepseek-ai/` |

## 1. 结论（TL;DR）

1. `delivery:'caller'` = 只把结果交给 `activation.result`，**不写 external catalog、不给父会话完成通知**。
2. `delivery:'parent'` = 结果仍进 `activation.result`，**额外**给父会话投一条 user-role 完成通知；external 还会在父 Session 追加 `subagent/catalog`（`mode:'external'`）。
3. 用户看到的 `Codex provider smoke test · 外部任务` **不是 MeetingStone 适配器产生的**：它来自官方 `subagent_codex` 工具（`dsh-tool-subagent` 硬编码 `delivery:'parent'`）。会话日志 seq 4564→4565 完整记录。
4. 建议：**默认保持 `caller`**。若要原生面板可见，做显式 opt-in（默认关闭），不要全局改；面板行只是“静态行”，不可点、无状态、无耗时、永久残留，换不来可用的进度 UI。

## 2. `delivery` 语义对照

| 维度 | `delivery:'caller'` | `delivery:'parent'` | 证据（`dsh-subagent/lib/index.js`） |
| --- | --- | --- | --- |
| 结果去向 | `activation.result` promise，返回给调用方 | 同样返回 `activation.result` | `:2085-2090`（receipt 恒带 result）、`:2056-2057` |
| 父会话通知 | 无（`notifySettlement` 直接 return） | 一条 user-role 通知；父空闲→queue（新 turn），父运行→steer（最近 step） | `:2060-2071`；README `:61,:167` |
| 通知内容 | — | “Background subagent …”+ closing text + structured + diagnostic | `:511-545`；README `:167` |
| 本地子 Agent catalog | **仍写**（与 delivery 无关） | 写 | `:1471`；README `:123` |
| 外部执行 catalog | **不写**（由 caller 自己记成员） | 写 `mode:'external'` | `:1514`；README `:123` |
| 本地持久化 | `sessionPersistence` 可选（可临时会话） | 必须存在，否则 `PERSISTENCE_UNAVAILABLE` | `:1401`、`:2258-2262` |
| 本地子提示词 | 不追加“可回信”指引 | 追加 `withContinuableReturnGuidance` | `:1466` |
| 未传时默认 | — | `inputs.delivery ?? "parent"` | `:1848` |

> 结果在 **teardown 之后**才 settle：`result` 携带 output/stopReason，捕获失败则 reject（README `:73`）。取消：`dispose()` 会 abort external controller 并等待 `run.dispose()`（`:2004-2008`）。

## 3. external catalog 的写入条件与字段

- 仅 **external provider**（无 `prepareContinuable`，如 codex / acp / claude-code）走 `startExternal`；且仅 `spec.delivery === 'parent'` 时追加（`:1514`）。
- 写入函数 `establishExternalCatalogChild(parent, childId, label)`（`:833-841`；可读源码 `dsh-subagent/lib/types/catalog.js:104-111`）：`{version:2, childId, childCreatedAt:Date.now(), mode:'external', label}`。schema 见 `:723-726`，投影视图 `{id, createdAt, mode, label}` 见 `:746-753`。
- **没有 status / kind / duration 字段**；“条目只在创建时记一次成员关系，不携带执行状态”（README `:123`）。失败/完成都不会更新该行。
- 官方工具路径：`dsh-tool-subagent/lib/index.js:471` 固定 `delivery:"parent"`，所以 `subagent_codex` 派发必然写 external 行。
- 真实案例（`C:\Users\30673\.dsh\sessions\--D-MeetingStone--\session-417e6b6a….v4.jsonl.zstd`）：seq 4564 `tool/call name=subagent_codex, description="Codex provider smoke test"` → seq 4565 `subagent/catalog data={version:2, childId:329f0260…, mode:"external", label:"Codex provider smoke test"}` → seq 4577 父会话收到 `subagent-settled` 失败通知（同 turn 内 spliced 到 next-step）。该行无本地会话文件、删不掉（`docs/audit/agent-cleanup.md:29,:52`）。

## 4. 若适配器改用 `delivery:'parent'`

- `result` 仍可用：`receipt` 恒返回 `activation.result.promise`，通知不影响 settle（`:2085-2090`）。
- 取消/错误/终态仍可拿：`dispose()`、`controller.abort()`、result resolve/reject 逻辑与 delivery 无关（`:2004-2008`、`:2049-2057`；README `:73`）。
- 重复投递：宿主侧**只发一条通知**（README `:171`），不会双通知；但会与 MeetingStone 自己的呈现重复——适配器仍写 run 记录并由 `meetingstone_wait` / `meetingstone_get_task` 回读全文，模型会“通知一次 + 查询一次”。实测 caller 模式下本地任务确实无通知、靠轮询 run JSON（seq 6562/6563 等）。
- 额外副作用：通知是 user-role 消息，父忙时 steer（实测量子在同一 turn 内插入 next-step）；外部失败也会永久留一行无状态“外部任务”，加剧“清单不准”的观感。

## 5. 面板对 external 条目的渲染（`dsh-client-ui-subagent/lib/client.js`）

| 能力 | 结果 | 证据 |
| --- | --- | --- |
| 名称 | 显示 `entry.label ?? id` | `:202,:279` |
| 副标题 | `summary.title · 外部任务`（i18n `mode.external`） | `:203,:206-210`；`:870` |
| 状态 | **无**（`activity` 置 undefined，`completed` 强制 false） | `:204-205` |
| 耗时 / token | **无**（external 无 summary/projection，`activityDuration` 返回 undefined） | `:211-218,:70-77` |
| 点击打开 | **不可**（`open()` 对 external 直接 return） | `:219-220` |
| 键盘可达 | `tabIndex:-1`、`aria-disabled` | `:248-249` |
| 侧栏打开 | 无按钮（只留占位） | `:296` |
| 展开下级 | 不可能（external 视为叶子，`knownLeaf`） | `:196,:198` |
| 状态点 | 只显示 idle 圆点 | `:273` |

## 6. 建议（改 / 不改）

**默认不改（保持 `caller`），理由**：收益只是“能看到一个名字”，代价是父会话多一条完整输出通知（token 与 steer 打断）、与自有 run 记录双份呈现、且行永久不可点/无状态。它不能替代真正的进度 UI。

若产品验收硬性要求“外部任务出现在原生 Subagents 面板”，**唯一官方路径就是 `delivery:'parent'`**，建议做成显式 opt-in：

1. 最小改动点：`src/dsh/adapter.js:1027`（`delivery: 'caller'` → 配置值，默认仍 `caller`）；仅对 external provider 生效。
2. 配置：`src/config.js` 增加 `subagents.externalDelivery: 'caller'|'parent'`；文档注明副作用。
3. 去重：parent 模式下不要再让 `get_task` 重复推送全文（或把通知视为唯一呈现），并接受该行不可导航。
4. **不推荐**“保持 caller 但私写 catalog”：需调用宿主内部 `parent.session.append('subagent/catalog', …)`，非公开契约、升级易碎，且写出来同样是死行。
5. 替代可见性：原生 Jobs 已在用（`ctx.jobs.start`，`src/dsh/adapter.js:738,1174`），能显示 label/状态/取消；MeetingStone 的 Runs/Jobs 面板才是进度展示的正解。

风险清单：通知与自有结果双份；steer 打断主控；失败行永久残留；label 只在创建时冻结；若误把本地通道也切成 parent，会额外要求持久化并向子 Agent 注入“可回信”指引（`:1401,:1466`）。

## 7. 未验证项

- 未做 GUI 截图级核对；external 行的存在由会话日志与 client 源码证明，未逐像素确认渲染。
- 未真机实测“切到 parent 后 MeetingStone 的 result/取消/错误”全链路；结论基于源码 + README + 官方工具真实日志。
- 未核对 DSH 后续版本是否改变 catalog v2 / UI 行为（本机 0.2.2-rc.1）。
- 会话重开/归档后 external 行的持久显示未实测（catalog 事件持久，推测永久）。
- 未逐版本 grep provider 是否消费 `label`；本机 codex/acp/claude-code 包内无 `.label` 读取。
