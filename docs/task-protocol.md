# 任务/结果协议（V1 简化版）

> TaskSpec / ContextPack / Handoff 三个机制合并为**一份薄协议**：派单只传四件，回执只返四件。
> 这是协作约定，不是表单：缺字段不会自动失败（硬校验只有 §5 的三条）。
> 字段实现见[配置参考 §7](configuration.md)，交接写法见 [handoff.md](handoff.md)。

## 1. 任务协议（主控 → 子 Agent）

| 项 | 写什么 | `meetingstone_dispatch` 字段 |
| --- | --- | --- |
| 任务名称 | 一眼认得出的短名，进 Jobs / list_runs | `title` |
| 目标 | 要达成什么结果，不是怎么做 | `objective`（省略时 `task` 正文即目标） |
| 范围 | 只改哪些、不许碰什么 | `scope.include` / `scope.exclude` |
| 验收 | 怎样算做完，可执行、可判定 | `acceptance[]` |

最小调用（可直接照抄）：

```json
{
  "role": "沙僧",
  "task": "给 dispose 超时分支补一个单测，断言槽位未释放",
  "title": "补 dispose 超时单测",
  "objective": "覆盖 dispose 超时路径，失败时能定位到未释放的槽位",
  "scope": { "include": ["tests/dispatcher.test.mjs"], "exclude": ["src/", "配置"] },
  "acceptance": ["node scripts/run-tests.mjs 全绿", "超时用例断言槽位保留"]
}
```

旧用法 `{ "role": "沙僧", "task": "..." }` 完全可用，行为不变。

**何时可省略**

| 场景 | 传什么 |
| --- | --- |
| 简单查询 / 只读确认 | 只传 `role` + `task` |
| 单文件小改、边界显然 | `title` + `task`，`scope` / `acceptance` 可省 |
| 跨文件、并行、要交付物 | 四项齐全 |
| 要指定证据或盘点上下文 | 再加 `evidence[]` / `contextRefs[]` |

例外：一旦传了非空 `scope`，`acceptance` 必填，否则 `TASKSPEC_INVALID`（§5）。

## 2. 结果协议（子 Agent → 主控）

四项：**状态、结论、证据、完整报告路径**。

```json
{
  "status": "completed",
  "summary": "已补齐 dispose 超时单测；全量测试通过，未改 src。",
  "evidence": [
    { "file": "tests/dispatcher.test.mjs", "line": 214, "finding": "新增超时用例，断言槽位保留" },
    { "file": "scripts/run-tests.mjs", "line": 1, "finding": "259 passed / 0 failed" }
  ],
  "artifacts": [".meetingstone/runs/child-123.json"],
  "changedFiles": ["tests/dispatcher.test.mjs"],
  "tests": ["node scripts/run-tests.mjs → 259 passed / 0 failed"],
  "openIssues": [],
  "nextAction": "无"
}
```

**证据格式**（能复核为准）：

- 代码：`文件:行号` + 一句结论，例如 `src/taskspec.js:185` — 声明 scope 却无 acceptance 会被拒绝；
- 命令：命令原文 + 结果摘要（通过数 / 失败数 / 退出码）；
- 取不到就写「未验证」，不猜、不省略。

`status` 只取 `completed` / `partial` / `blocked` / `failed`。

## 3. 六条规则

1. **自动取必要项目背景**：主控不用粘贴仓库结构，子 Agent 自己读项目。
2. **给了路径不重搜**：`contextRefs` / `contextPack.files` 里的文件视为已确认，直接读。
3. **不传完整聊天历史**：只传结论、路径和已确认事实。
4. **子 Agent 不复述背景**：回执只说做了什么、凭什么、还差什么。
5. **全文落盘**：完整结果写 `.meetingstone/runs/<childId>.json`（上限 256KiB）。
6. **主控只读摘要**：默认看 `summary` / `handoff`，要原文再按需取。

## 4. 与现有能力映射

| 协议项 | 落点 | 用法 |
| --- | --- | --- |
| 任务四项 | `meetingstone_dispatch` 的 `title` / `objective` / `scope` / `acceptance` | 传任一结构化字段即进入结构化模式 |
| 回执四项 | 子 Agent 输出契约 `status` / `summary` / `evidence` / `artifacts` | 解析后写入 run 记录与 `handoff` |
| 主控默认视图 | `meetingstone_get_task`（不带 `full`） | 回 summary / resultStatus / openIssues / handoff |
| 一次取回正文 | `meetingstone_get_task` + `full:true` | 适合短结果；长结果用下一行 |
| 按范围取全文 | `meetingstone_get_run_artifact` | `headBytes`/`tailBytes`，或 `lineFrom`/`lineTo` |
| 批量收口 | `meetingstone_wait`（`childIds[]` + `timeoutMs`） | 一次等齐，不当轮询用 |

**高级字段是可选增强，不强制**：`evidence`、`contextRefs`、`contextPack`、`outputBudget`、`roleHint` 只在需要时加；一个都不传时，提示词与旧版一致。

## 5. 校验边界

只有三种情况拒绝（`TASKSPEC_INVALID`）：

1. 用了结构化字段但缺 `title`；
2. 声明了非空 `scope` 却没有 `acceptance`；
3. 关键字段类型错误（如 `acceptance` 传字符串、`contextPack` 传数组）。

其余一律放行：简单查询不传 `scope` / `acceptance` / `evidence` 不会报错。

## 6. 明确不做

- 不建独立 Context Pack / Handoff 引擎，不加数据库、不加队列；
- 不做固定模板或全字段表单；
- 不传完整聊天历史，不让子 Agent 复述背景。
