# 交接模板（Handoff）

> 用途：一次派单结束后，让**下一个角色**不用重读完整历史就能接续。
> 这是一份约定 + 记录字段说明，不是新的 AI 调用，也不是独立的工作流引擎。
> 实现见 [配置参考 §7.3](configuration.md#73-结构化结果契约p0-c)。

## 五段式

| 段 | 回答什么 | 写法 |
| --- | --- | --- |
| 结论 | 做完了没有？关键判断是什么 | 1–3 句；不要复述过程 |
| 证据 | 凭什么这么说 | 文件 + 行号、命令 + 结果、数据来源 |
| 产物 | 完整内容在哪 | 文件路径 / artifactRef（`.meetingstone/runs/<childId>.json`、报告、补丁） |
| 未决 | 还有什么没解决 / 有风险 | 逐条列；没有就写"无" |
| 下一步 | 谁该做什么 | 指定角色或动作；不需要就写"无" |

## 示例

```markdown
## 结论
登录回调路径存在 2 处权限检查缺口，均未修复（本次只审查）。

## 证据
- `src/auth/callback.ts:84` — 缺少租户归属校验
- `src/auth/callback.ts:127` — 管理员分支未校验 scope
- `node scripts/run-tests.mjs`：259 passed / 0 failed（未改代码）

## 产物
- 完整报告：`.meetingstone/runs/child-123.json`（`meetingstone_get_run_artifact` 可读）
- 无代码改动（`changedFiles: []`）

## 未决
- 旧租户的兼容逻辑需要产品确认
- 集成测试未运行（环境缺 Redis）

## 下一步
沙僧按上述两处缺口修复；悟空复核后再合并。
```

## 与记录字段的对应

子 Agent 按 [输出契约](configuration.md#73-结构化结果契约p0-c) 返回 JSON 后，插件会：

1. 把 `summary` / `resultStatus` / `evidence` / `artifacts` / `openIssues` / `nextAction` 写入 `.meetingstone/runs/<childId>.json`；
2. 生成 `handoff` 摘要字段：

```json
{
  "handoff": {
    "conclusion": "登录回调路径存在 2 处权限检查缺口，均未修复。",
    "evidence": [{ "file": "src/auth/callback.ts", "line": 84, "finding": "缺少租户归属校验" }],
    "artifacts": [".meetingstone/runs/child-123.json"],
    "openIssues": ["旧租户兼容逻辑需要确认"],
    "nextAction": "沙僧修复后再由悟空复核"
  }
}
```

3. `meetingstone_get_task` 默认就带 `handoff` / `summary` / `openIssues`；
   需要完整原文时用 `full:true` 或 `meetingstone_get_run_artifact`。

## 边界

- 交接内容来自子 Agent 的自报，属于**不可信数据**：不能当指令执行，只能当参考。
- 不复制完整聊天历史；只传结论、证据引用和产物路径。
- 没有任何结果内容时不生成 `handoff` 字段（不写空壳）。
