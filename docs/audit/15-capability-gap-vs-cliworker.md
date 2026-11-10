# 15 · 与 CLIWorker 的能力对照（决定何时可以关停它）

> 目的：用户计划在本插件稳定后关停 `dsh-cliworker-now`。本文只对照**功能与使用方式**，
> 不涉及也不复制其任何实现（clean-room，见 `docs/CLEAN_ROOM.md`）。
> 日期：2026-11-10

## 1. 已经能替代的部分

| 能力 | CLIWorker | 集合石（当前） |
| --- | --- | --- |
| 按"角色/别名"派活 | ✅ 有 persona | ✅ 角色 + 别名 + 冲突检测 |
| 外部 CLI 通道 | ✅ codex/claude/codebuddy/kimi… | ✅ **codex 已端到端跑通**；in-process 已跑通 |
| 指定模型/强度 | ✅ 每个 worker 选 | ✅ 由通道实例承载（DD7），派单校验一致 |
| 只读约束 | ✅ read-only | ✅ 只读角色必须引用 `permissionPreset: read-only` 的实例，否则拒绝启动 |
| 任务状态查询 | ✅ status | ✅ `meetingstone_get_task`（running/completed/failed/cancelled） |
| 取消任务 | ✅ stop | ✅ `meetingstone_cancel_task` |
| 结果回读 | ✅ 读输出 | ✅ `get_task` 返回真实输出（已验 PONG） |
| 并发纪律 | 由插件内部管理 | ✅ 写串行/只读限流/按项目隔离（真机验证） |
| 本机 CLI 状态 | ✅ | ✅ 多源探测（含商店应用 Appx 路径） |
| 配置位置 | worker 配置/项目文件 | ✅ 插件 Config + 项目 `.meetingstone.json`（热读取） |

## 2. 目前**还不能**替代的部分（关停前必须确认）

| 能力 | 说明 | 影响 |
| --- | --- | --- |
| **CodeBuddy（acp 通道）** | 需要 `@deepseek-ai/dsh-subagent-acp`（非 bundle）+ 手写 `subagent-acp` 行（`command`/`args`）。不过 CodeBuddy 无头入口在本机非 TTY 下会崩（`-p`/`--acp` 都 exit 1），真实可用的 ACP 启动参数尚未确定 | 沙僧/小白这类 CodeBuddy 角色目前派不出去 |
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

**现在还不能关。** codex 与 in-process 已经可用，但 CodeBuddy 通道（你最常用的"沙僧/小白"主力）还没打通。
建议保留 CLIWorker 直到 acp 通道验证通过；届时再按 §3 的顺序切换。
