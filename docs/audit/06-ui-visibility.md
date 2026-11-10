# 06 · 外部任务在原生 UI 的可见性（P0-06）

> 采集人：八戒 ｜ 日期：2026-11-10 ｜ 方式：工具层取证（**未做截图级 UI 观察，见 §4**）

## 1. 结论

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 外部 CLI 任务会出现在原生 Subagents 列表里吗 | **不会**。原生 `list_agents` 只看得到 DSH 原生子 Agent（本会话当前为空） | `list_agents` 返回空；而 CLIWorker 同时有 3 个 Worker |
| 外部 CLI 任务有自己的界面吗 | 有，但属于**插件自己的面板**（CLI Worker 窗口），不是宿主原生 UI | `cliworker_status` 返回的 3 个 worker 有各自 title/status/agentName/usage，另有独立窗口概念 |
| 宿主原生能拿到外部任务的用量吗 | **部分能**：CLIWorker 把 codex 的 usage 透传进 worker 记录（`conversationTelemetry.usage`：input/output/cacheRead/reasoning） | `cliworker_status` 中 wukong 条目 |
| 任务状态可查询性 | 有 `queued/running/completed` 三态 + `lastResult` | 同上 |

## 2. 对本项目的直接含义

1. **不要把"外部任务出现在原生 Subagents UI"写进产品承诺**——实测不成立。我们第一版的定位应是"派单 + 返回原生可达的引用"，UI 展示交给宿主或未来自建面板。
2. **用量可以拿，但要标明来源**：codex 的 usage 是 CLI 真实返回，属于"CLI 实际返回"档，不是宿主 Token Meter 统计。两者不能混着显示（见交接文档第 8 章）。
3. **状态三态够用，但缺中间过程**：原生 UI 里没有逐步事件流。若第一版需要"看到它在干什么"，只能靠 subagent 的结果回传或自建面板——后者我们已决定不做 UI。

## 3. 与 Agent Teams 的关系

如果将来启用 Team（P0-05），成员状态才会进原生 UI。当前不启用，所以"外部任务可视化"这条在第一版是**明确缺口**，需在 README 与 Gate 清单里如实写明。

## 4. 未验证项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| DSH 桌面端 GUI 里 Jobs / Subagents 面板对**插件派发的任务**的实际渲染 | **未做截图级验证** | 我只能读工具层数据，看不到你的屏幕。如果你在界面上看到过 CLI Worker 任务出现在某处，告诉我位置，我补记 |
| `dsh-tool-subagent` 派发的任务在原生 UI 的表现 | 未验证 | 需要一次真实的后台 subagent 派发 |
| 原生 Jobs 面板能否关联外部进程 | 未验证 | — |

> 这一条我不编：**工具层证据支持"原生 Subagents 看不到外部 CLI Worker"，但界面层面的最终确认需要你看一眼或授权我做一次可视化验证。**
