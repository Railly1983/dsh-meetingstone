# P1-2 · 历史测试 Agent 命名与清理策略

> 采集人：八戒 ｜ 2026-11-11 ｜ 方法：只读抽取本机 `app.asar`（DSH `0.2.2-rc.1`）+ 只读解析 `.dsh/sessions/*.zstd`。**未改宿主/插件代码，未删除任何会话。**
> 证据前缀 `PKG/` = `app.asar/dsh/node_modules/@deepseek-ai/`。

## 结论

- 宿主**没有删除会话**的 API 或 UI；会话只能**归档/取消归档**（侧栏 README 原文："会话可以归档但绝不会被删除"）。
- **Subagents 面板的行不是侧栏 session list**，而是父会话日志里的 `subagent/catalog` 投影；行的主标题是创建时冻结的 descriptor `label`，**没有改名/移除接口**。归档子会话不会删掉它，归档父会话才会让整个面板不可达。
- **Jobs 面板的"清空"只清浏览器本地状态**；Host 侧只有 `ctx.jobs.remove(id, caller)` 能删**已结算**的单条 job。历史测试条目的正确策略是"不再新增 + 归档旧父会话"，**不要手删 `.zstd`**。

## 能力矩阵

| 能力 | 官方入口 | 插件能否调用 | 用户操作 |
| --- | --- | --- | --- |
| 重命名会话标题 | `session.rename`：`PKG/dsh-api-session-controller/lib/index.js:734-747`，Remote 声明 `:3454` | 能。Host 注入 `ctx.sessionController.rename({sessionId,title})`；浏览器 half 走 `ctx.remote.session.rename`。目标须 live/可恢复 | 侧栏行「⋯ → 重命名会话」、双击标题、`Mod+Alt+G` |
| 删除会话 | **不存在**。Remote 全集见 `:3445-3469`，无 delete/remove；`dsh-client-ui-workspace/README.zh.md:247` 明说没有删除 | 不能 | 无 |
| 归档 / 取消归档 | `workspace.archiveSession` / `unarchiveSession`：`PKG/dsh-api-workspace-controller/lib/index.js:297-308`、Remote 声明 `:707-708` | 能。Host `ctx.workspaceController.archiveSession(...)`；浏览器 `ctx.remote.workspace.*`；跨 owner 受 remote-access policy 限制 | 行「⋯ → 归档会话」；「视图选项 → 全部对话 / 仅显示已归档」恢复 |
| 单条 Subagent 行改名/删除 | 无 | 不能 | 无 |
| 单条已结算 Job 清理 | `ctx.jobs.remove(id, caller)`：`PKG/dsh-jobs-local/lib/index.js:523-527` | 能（host 侧，须 owner sessionId；仅终态） | 无直接入口 |
| 批量清空已结束 Job | 无 bulk API | 循环 `remove` | 「后台任务 → 已结束 N → 清空」（本地，刷新复现） |

## 为什么 Subagents 行删不掉

- DSH `0.2.2` 没有独立的全局 Subagents 页面；所谓"面板"就是每个父会话页头的子代理目录（`dsh-client-ui-subagent`，从父会话打开）。
- 来源：父会话页头 → 直接子代理目录；投影定义 `PKG/dsh-subagent/lib/index.js:793-808`，只 append `subagent/catalog`（`:816-823`），没有 remove 事件。
- 行主标题 = `entry.label ?? entry.id`（`PKG/dsh-client-ui-subagent/lib/client.js:202`）；`summary.title` 只作副标题（`:206-210`）。label 在创建时由 `spec.label` 快照（`dsh-subagent/lib/index.js:1410-1417`）。
- 侧栏永远隐藏 `origin === "subagent"` 的会话（`PKG/dsh-client-ui-workspace/lib/client.js:964-965`），所以这些子会话只能从父会话目录打开。
- 本机实测：`C:\Users\30673\.dsh\sessions\--D-MeetingStone--` 共 22 个日志（2 个主会话 + 20 个子会话）。主会话 `session-417e6b6a…` 的目录有 21 行：4×`meetingstone:role-selftest`、1×`…-fork`、1×external `Codex provider smoke test`、4×P0-01/02/02b 与 P2 Gate、11×`meetingstone:role-bajie`；`session-cc5a771a…`（`isSeeded=true` 的 fork/seed）复制了其中 10 行。
- `meetingstone:role-selftest` 就来自 `src/dsh/adapter.js:1049` 的 `label: meetingstone:${roleId}`。

## Jobs 面板

- `dsh-client-ui-jobs` 的「清空」只是 React state `clearedKeys`（`PKG/dsh-client-ui-jobs/lib/client.js:329-337,409-415`），不调 Host；刷新页面会重新出现。
- Host 注册表是进程本地的（`PKG/dsh-jobs/README.zh.md:57`）；结算记录一直列出，直到 owner 释放、服务释放或 `remove`（`:130`）。Job Remote 只有 `list/follow/kill`，没有 remove（`PKG/dsh-api-job-controller/lib/index.js:264-266`）。
- 所以彻底清空 = 重启 DSH（进程本地自然清空），或插件在终态后按 jobId 调 `ctx.jobs.remove`；运行中的 job 必须先 kill 并等结算。

## 命名：三层，谁决定

1. **会话标题**：Host `dsh-session-title` 自动取首条用户消息或 LLM 生成；显式 rename 会把标题钉住（`PKG/dsh-session-title/lib/index.js:301-312`）。本机日志里首标题是原文"你是「八戒」。…"，随后 LLM 标题才变成任务名（如"历史测试 Agent 清理策略调研"）。
2. **Subagents 行主标题**：插件在 `spec.label` 里决定，创建后冻结；当前是 `meetingstone:<roleId>`（`src/dsh/adapter.js:1049`）。
3. **Job 行标题**：插件在 `ctx.jobs.start({label})` 里决定，之后不可改；当前是 `角色名 · 任务摘要`（`src/dsh/adapter.js:442-447,788`）。

历史条目**不能只改名不删**：descriptor/label 没有更新接口；session title 可以 rename，但 Subagents 行只变副标题，主标题仍是 `meetingstone:…`，且子会话在侧栏没有改名入口。

## 推荐清理步骤（用户可照做）

1. 先分类：Subagents 行（父会话页头目录）、Jobs 行（页头「后台任务」）、侧栏会话行，三者存储位置不同。
2. **Subagents 旧行不要手删**。要"眼不见"就归档旧父会话（行「⋯ → 归档会话」），或直接新开主会话；归档不删日志，「视图选项 → 全部对话」可恢复。手删 `C:\Users\30673\.dsh\sessions\…\session.v4.jsonl.zstd` 会留下打不开的幽灵行，且不可恢复。
3. Jobs：点「后台任务 → 已结束 N → 清空」只能临时隐藏；要永久清掉当前进程的已结束任务，重启 DSH 或让插件在结算后 `ctx.jobs.remove`。
4. 项目 `.meetingstone/runs` 会自动清理（100 条/30 天，`src/run-store.js:54-55`；带 worktree 的记录永不清，`:1003-1009`）。手删只会让 `list_runs` 少记录、`get_task`/`continuesFrom` 查不到旧 childId，并丢失工作树元数据。
5. 旧 selftest 会话本身极小（4 个各约 19 KB，删了只省 ~77 KB），**建议保留**；4 个 P0-* / P2 Gate 是真实交付记录，也保留；external `Codex provider smoke test` 只有 catalog 行、没有本地会话文件，删不了。持久日志是 `sessionStats`/Token 统计的口径来源（`PKG/dsh-session-stats/README.zh.md:12`），手删会连带丢该会话统计，并留下打不开的幽灵行。

## 插件侧应做的

- 新任务的 Subagents label 改成可读的 `角色名 · 任务标题`（与 Job label 同源），roleId 留在 run 记录里，不再用 `meetingstone:<roleId>` 作为面板主标题。
- selftest / 冒烟测试不再进入主会话目录：用一次性新主会话，测完归档；从角色配置中移除 `role-selftest` 一类测试角色。
- 任务标题先写 `TaskSpec.title`，不要依赖首条 prompt 的自动标题；Job label 继续用 `角色名 · 任务摘要`。
- 可选：派单终态后由插件按 jobId 调 `ctx.jobs.remove(jobId, ownerSessionId)` 清理自己产生的已结算 job；只删不再需要读输出的记录，并先确认终态。
- **不要**为此新增"删除会话"API、不要把测试条目写进历史日志、不要做 DOM 注入。

## 未验证

- 桌面端菜单/按钮的截图级验证未做；UI 路径来自 bundle 文案与 README。
- 归档子会话后 Subagents 目录是否仍显示该行：按投影代码应显示，未做 UI 实测。
- 插件直接调 `ctx.sessionController.rename` / `ctx.workspaceController.archiveSession` 需要新增 inject，当前插件未接；跨 principal 的 remote 调用还受 remote-access policy 限制。
- `@agentclientprotocol/sdk` 里的 `session/delete` 是 ACP 协议能力（`app.asar/dsh/node_modules/@agentclientprotocol/sdk/...`），**不是** DSH 的 `ctx.remote.session`；是否被某个 provider 用来删真实会话未验证。
- `ctx.jobs.remove` 对面板行的实时移除效果按注册表 `removed` 事件推断，未做 UI 实测。
