# 15 · 与 CLIWorker 的能力对照（决定何时可以关停它）

> **2026-11-11 移除声明**：只读通道已彻底移除（宿主 subagent spec 无权限字段，做不到绝对只读）。
> 本文中相关行保留为历史对照，**不要再实现**。

> 目的：用户计划在本插件稳定后关停 `dsh-cliworker-now`。本文只对照**功能与使用方式**，
> 不涉及也不复制其任何实现（clean-room，见 `docs/CLEAN_ROOM.md`）。
> 日期：2026-11-10

## 1. 已经能替代的部分

| 能力 | CLIWorker | 集合石（当前） |
| --- | --- | --- |
| 按"角色/别名"派活 | ✅ 有 persona | ✅ 角色 + 别名 + 冲突检测 |
| 外部 CLI 通道 | ✅ codex/claude/codebuddy/kimi… | ✅ **codex 已端到端跑通**；in-process 已跑通 |
| 指定模型/强度 | ✅ 每个 worker 选 | ✅ 由通道实例承载（DD7），派单校验一致 |
| 只读约束 | ✅ read-only | ❌ **已移除，不要再实现**：宿主 subagent spec 无权限字段，做不到绝对只读 |
| 任务状态查询 | ✅ status | ✅ `meetingstone_get_task`（running/completed/failed/cancelled） |
| 取消任务 | ✅ stop | ✅ `meetingstone_cancel_task` |
| 结果回读 | ✅ 读输出 | ✅ `get_task` 返回真实输出（已验 PONG） |
| 并发纪律 | 由插件内部管理 | ✅ 同项目串行/按项目隔离（只读限流已随只读通道移除） |
| 本机 CLI 状态 | ✅ | ✅ 多源探测（含商店应用 Appx 路径） |
| 配置位置 | worker 配置/项目文件 | ✅ 插件 Config + 项目 `.meetingstone.json`（热读取） |

## 2. 目前**还不能**替代的部分（关停前必须确认）

| 能力 | 说明 | 影响 |
| --- | --- | --- |
| ~~CodeBuddy（acp 通道）~~ | ✅ **2026-11-10 已打通**：装 `@deepseek-ai/dsh-subagent-acp` + `insert` 一行；关键是 stdin 必须保持打开、用 node 启动 bin | 已解决 |
| **Claude Code 通道** | bundle 存在，但本机未安装 Claude CLI；provider 自带 pinned CLI，未实测 | 若需要 Claude 角色，需单独验证 |
| **会话续聊（followup）** | 我们现在是一次性 activation；宿主有 `prepareContinuable`，但未接 | 不能像 CLIWorker 那样"让沙僧接着改" |
| **隔离副本 + 合回（merge back）** | CLIWorker 每个 worker 在隔离副本里干活再合回；我们直接在宿主 workspace 执行 | 多 worker 并行改同一仓库时，没有它的"隔离→合并"保护（宿主有 `dsh-experimental-tool-worktree` 可考虑接入） |
| **多 CLI 混合编队** | CLIWorker 可在一次任务里混用不同 CLI | 我们现在是"一个角色一次派单" |

## 3. 建议的关停顺序

1. **先补 acp 通道**（CodeBuddy）：装 `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1` + 配置行 + 实跑 PONG。
2. **再补续聊**（若你确实需要"继续改"）：接宿主 `prepareContinuable`。
3. **隔离与合回**：评估用宿主 worktree 工具替代，或承认差距（并行写同一仓库时不推荐）。
4. 以上三项里，**第 1 项是硬前提**；第 2、3 项可按你的实际使用习惯决定是否等。

## 4. 结论

**2026-11-10 更新：三条通道（codex / codebuddy-acp / in-process）均已真机验证通过，角色人设注入已实现。**
CLIWorker 已在 profile 里 `disabled: true`（可逆，删掉那两行或改 false 即恢复）。

剩余差异只有两项，按需再补：

| 差异 | 影响 | 何时需要补 |
| --- | --- | --- |
| **会话续聊（followup）** | 不能对同一个子 Agent 追加指令，只能重新派单 | 当你需要"让沙僧接着改刚才那段"时 |
| **隔离副本 + 合回** | 多个 worker 并行改同一仓库没有隔离保护 | 当你需要并行派多个写任务时（可考虑接宿主 worktree 工具） |
