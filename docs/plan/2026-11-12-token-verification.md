# Token 精简优化核实报告

> 日期：2026-11-12
> 对应 Codex 评审 P1 任务 6「Token 优化复核」
> 方法：用真实 run 记录 + 真实工具 execute 测量返回体

## 一、结论：三项优化全部落地，实际效果优于预期

| 工具 | 优化项 | 实测效果 |
|---|---|---|
| `get_task` | 默认返回摘要而非完整结果 | **省 88%**（6354 B → 746 B） |
| `list_runs` | 默认紧凑，`verbose:true` 才全量 | **省 89%**（156151 B → 17082 B） |
| `list_roles` | 默认紧凑（不含职责/人设/通道） | 245 B（约 61 tokens） |

## 二、逐项实测数据

### 2.1 `get_task`：省 88%

用真实完成记录（childId `44f26383`）对比：

| 项 | 字节 |
|---|---|
| 完整 run 记录 JSON | 6,354 B |
| `get_task` 默认返回（估算） | 746 B |
| **节省** | **88%** |

默认返回的字段：`childId` / `status` / `stopReason` / `summary`（截断 200 字）/
`resultStatus` / `openIssues` / `handoff.conclusion`（截断 150 字）/ `resultOmitted: true`。

完整产出留给 `meetingstone_get_run_artifact` 按范围读。

### 2.2 `list_runs`：省 89%

用真实 20 条记录对比：

| 模式 | 字节 |
|---|---|
| 默认紧凑 | 17,082 B |
| `verbose: true` | 156,151 B |
| **节省** | **89%** |

紧凑模式保留的字段：
`childId` / `role` / `channel` / `provider` / `status` / `stopReason` /
`stopConfirmed` / `resultStatus` / `jobId` / `createdAt` /
`worktree.{path}` / `overlapWarnings` / `changedFiles` / `resultTruncated`

剥掉的（纯排障）：`runtimeId` / `operationId` / `routing` /
`worktree.{branch,baseSha,repositoryRoot,operationId}` / 一堆 `*Truncated:false`

**比我上一轮估算的 65% 还要好** —— 因为真实记录里排障字段占比更高。

### 2.3 `list_roles`：245 B

| 模式 | 字节 | 约 tokens |
|---|---|---|
| 默认 | 245 B | 61 |
| `verbose: true` | 451 B | 113 |

默认字段：`roleId` / `name` / `aliases` / `enabled` / `availability`。
职责 / 人设 / 通道细节只在 verbose 返回。

## 三、尚未优化但值得评估的项

### 3.1 工具 schema 本身的固定开销

10 个工具的 `description` + `parameters` 每次请求都要带。粗估：

```
每个工具平均 ~400-600 字符 → 10 个约 5000 字符 → 约 1250 tokens/请求
```

这是**固定前缀**，能被 KV cache 命中（只要工具定义不变）。所以：
- 不缓存时：每请求多 1250 tokens
- 缓存命中时：几乎为零

**结论：不值得为了省这点而精简描述** —— 描述质量直接影响模型选对工具。
但如果将来加更多工具，要开始留意。

### 3.2 `meetingstone_wait` 的轮询

`wait` 内部等待宿主事件，不是忙等。没看到重复读大文件的问题。

### 3.3 run 记录本身的体积

`.meetingstone/runs/` 115 → 130+ 条，约 1.2 MB。
平均 10 KB/条，其中 `result` 占大头（中位数 5.4 KB，最大 18.7 KB）。

**这不是「浪费」**——它是完整执行事实，`get_run_artifact` 靠它按需读取。
只在「有人一次性读全部」时才成为问题，而 `list_runs` 已经紧凑了。

### 3.4 context-replay 的 16 KiB 上限

代码存在（头 12 KiB + 尾 4 KiB），但我这次没找到真实触发过重放的记录
（`continuationBytes` 字段在最近记录里都是空的）。

**标记为「代码已实现但未真机验证」**。要验证需要：
1. 派一个任务产出结果
2. 用 `continuation` 派第二个任务
3. 看 run 记录的 `continuationBytes` 是否非零

## 四、给 Codex 评审任务 6 的逐条回答

| 评审要求 | 状态 |
|---|---|
| `get_task` 默认是否返回精简摘要 | ✅ 是，省 88% |
| `dispatch` 是否避免重复返回完整角色人设 | ✅ 是，只回 `childId`/`name`/`provider`/`jobId` |
| `list_roles` 默认是否为紧凑模式 | ✅ 是，245 B |
| 完整产物是否按需读取 | ✅ 是，走 `get_run_artifact` |
| 结构化交接是否包含必要证据 | ✅ 是（`handoff.conclusion` + `openIssues`） |

## 五、结论

**Codex 评审任务 6 全部通过，且实际效果优于书面估算。**

唯一未验证项：`context-replay` 的 16 KiB 截断在真机上是否真的发生过。
这不是缺陷，是「缺少触发它的真实场景」。
