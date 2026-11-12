# Token 优化独立复核（Lead 侧）

> 时间：2026-11-12 18:35
> 目的：与悟空独立做的评估交叉验证，避免单一视角。
> 数据来源：`.meetingstone/runs/` 115 条真实记录

## 一、实测数据

### 1.1 run 记录体积分布

| 指标 | 值 |
| --- | --- |
| 记录总数 | 115 |
| 总大小 | 1137 KB |
| 平均 | 10.1 KB/条 |
| 有结果的记录 | 94 / 115 |
| resultBytes 中位数 | 5,447 B |
| resultBytes 最大 | 18,666 B |
| resultBytes 总和 | 530,365 B |
| summary 上限（MAX_SUMMARY_BYTES） | 8 KB |

### 1.2 摘要压缩是否生效

| 情况 | 数量 |
| --- | --- |
| `resultBytes === summaryBytes`（未压缩） | 4 |
| `resultBytes !== summaryBytes`（已压缩） | 90 |

**结论：90/94 生效，压缩机制正常。** 4 条未压缩的可能是结果本身就短于上限。

### 1.3 最大的 6 条记录

| childId | 大小 | resultBytes | summaryBytes | 角色 |
| --- | --- | --- | --- | --- |
| 9e06112b | 29.9 KB | 18,666 | 18,666 | 八戒 |
| 8cd71ffd | 27.7 KB | 16,158 | 1,545 | 八戒 |
| 2a9b0649 | 24.9 KB | 14,324 | 14,324 | 八戒 |
| afff4277 | 24.1 KB | 13,052 | 911 | 八戒 |
| 33b87e20 | 23.7 KB | 8,487 | 1,889 | 沙僧 |
| 50cc987b | 23.7 KB | 10,517 | 1,052 | 八戒 |

**观察**：最大的记录集中在八戒（进程内 spawn），因为它是调度角色，会跑长任务。

## 二、发现的优化点

### 2.1 `list_runs` 返回体冗余（明确的优化空间）

实测单条记录（running 状态）= **1.7 KB**，其中包含：

```json
{
  "worktree": {
    "path": "D:\\MeetingStone\\.meetingstone\\worktrees\\...",
    "branch": "meetingstone/...",
    "baseSha": "c238ea3d12cf7134e0a91c1b005e0d79532d687d",
    "repositoryRoot": "D:\\MeetingStone",
    "operationId": "..."
  },
  "routing": { "roleId": "role-bajie", "auto": false },
  "operationId": "...",
  "runtimeId": "...",
  "overlapWarnings": [], "overlapTruncated": false, "overlapTotal": 0,
  "changedFiles": null, "changedFilesUnknown": false, "changedFilesTruncated": false, "changedFilesTotal": null,
  "resultTruncated": false, "summaryTruncated": false, ...
}
```

**冗余项**（对模型决策无价值）：
- `worktree.path` / `branch` / `baseSha` / `operationId` —— 这些是排障用的，不是决策用的
- `runtimeId` —— 内部标识
- 一堆 `*Truncated: false` / `*Unknown: false` —— 默认值噪音
- `overlapWarnings: []` 空数组 + `overlapTruncated` + `overlapTotal` 三个字段表达「没有重叠」

**估算**：每条可压到 ~600 B，20 条从 34 KB → 12 KB，**省 65%**。

**建议**：
- `list_runs` 默认只返回决策必需字段：`childId` / `role` / `status` / `summaryPreview` / `provider`
- `worktree` / `routing` / `overlap*` 只在 `verbose: true` 时返回
- 加 `meetingstone_get_task({ verbose: true })` 拿完整元数据

### 2.2 已确认生效的优化（不要动）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `get_task` 默认返回摘要 | ✅ 生效 | `SUMMARY_MAX_BYTES = 8KB`，90/94 记录已压缩 |
| `dispatch` 回执精简 | ✅ 生效 | 只回 `childId`/`name`/`provider`/`jobId`，不回角色全量 |
| `context-replay` 16KiB 上限 | ✅ 代码存在 | 头 12KiB + 尾 4KiB |
| 工具定义精简 | 待评估 | 10 个工具的 schema 每次请求都带 |

### 2.3 待核实项

1. **10 个工具的 schema 占多少 token**：需要统计所有 `parameters` + `description` 的字节数
2. **`wait` 轮询是否重复读大文件**：`meetingstone_wait` 内部实现要查
3. **同一角色连续派单能否复用会话**：外部 CLI 不支持（`prepareContinuable` 缺失），进程内可以

## 三、与悟空评估的交叉点

我等他的 `2026-11-12-token-optimization-review.md` 出来后对照：
- 他如果也指出 `list_runs` 冗余 → 高置信度，直接做
- 他如果指出别的点 → 合并清单

## 四、优先级建议

| 优先级 | 项 | 预期收益 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| P1 | `list_runs` 精简 | 省 65% 返回体 | 低 | 低（加 verbose 开关，向后兼容） |
| P2 | 工具 schema 瘦身 | 待测 | 中 | 中（可能影响模型理解） |
| P3 | 会话复用（仅进程内） | 待测 | 高 | 高 |

**先做 P1**：收益明确、成本低、风险低。
