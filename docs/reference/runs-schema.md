# `.meetingstone/runs` 记录字段规范（C3 落地版）

> 任务：C3（task-10）｜执行：沙僧｜2026-11-12
> 上游契约：`docs/design/context-contract.md`（C1，唯一事实源）。本文只描述 Runs 落盘字段，不重复契约正文。
> 范围：`src/run-store.js`、`src/result-contract.js`、`src/taskspec.js`、`src/context-replay.js`、`src/dsh/adapter.js`、`src/dsh/register.js`、`src/dispatch/dispatcher.js`。
> 兼容原则：**新字段全部可选**；旧记录读取为缺省（`undefined`/`null`），**不因缺字段报错、读取不回写**。

---

## 1. 记录与 C1 六字段的映射

C1 六字段：F1 目标与验收 / F2 背景与相关文件 / F3 前序结论 / F4 已完成与产物 / F5 证据 / F6 遗留问题与下一步。
落盘记录通过三组字段承载，**不新增 handoff 子字段**：

| C1 字段 | 落盘字段 | 来源 | 说明 |
| --- | --- | --- | --- |
| F1 目标与验收 | `taskSpec.title` / `taskSpec.objective` / `taskSpec.acceptance` / `taskSpec.scope` | 派单参数（`validateTaskSpec`） | 保护字段不截断（`src/taskspec.js:411-453`） |
| F2 背景与相关文件 | `contextPack.files` / `contextPack.knownFacts` / `taskSpec.contextRefs` | 派单参数 | 给路径不重搜 |
| F3 前序结论 | `contextPack.priorResults` / `handoff.conclusion` | 派单/结果 | `priorResults[{summary, artifactRef}]` |
| F4 已完成与产物 | `handoff.artifacts` / `artifacts` | 结果 JSON | 路径列表（≤10） |
| F5 证据 | `evidence`（`[{file,line,finding}]`）/ `handoff.evidence` | 结果 JSON | 片段内联由结果契约约束 |
| F6 遗留与下一步 | `openIssues` / `nextAction` / `handoff.openIssues` / `handoff.nextAction` | 结果 JSON | — |

辅助证据字段（跨 CLI 实际执行的自证）：`childId`、`role`、`channel`、`provider`、`model`、`worktree`、`changedFiles`、`durationMs`、`isolation`、`jobId`、`continuationBytes`、`upstreamChildId`、`taskId`。

---

## 2. C3 新增/落盘字段

| 字段 | 类型 | 写入条件 | 语义 |
| --- | --- | --- | --- |
| `taskId` | `string \| null` | 派单参数 `taskId` 存在 | Team 任务板 id 的**单向**外键；不写回 Team，不参与去重/重放（C1 §6） |
| `artifactPolicy` | `'none' \| 'runs' \| null` | 新派单总是显式写入（缺省 `runs`） | 落盘策略权威值：来自 `TaskSpec.artifactPolicy`（C1 §5） |
| `artifactPolicyViolation` | `true`（仅违规时出现） | `artifactPolicy==='none'` 且 `artifacts` 非空 | 契约违规标记；**不改变任务状态** |
| `reportedArtifactPolicy` | `'none' \| 'runs' \| null` | 子 Agent 结果里回显了 `artifactPolicy` | 审计用回显值；不覆盖权威 `artifactPolicy` |
| `upstreamChildId` | `string \| null` | 本次派单带 `continuesFrom` 且解析成功 | 上一轮 run 的 childId（C1 F4 追溯；V1 F4 缺口修复） |
| `durationMs` | `number`（仅可得时出现） | `startedAt`/`finishedAt` 均为合法数字且 `finishedAt >= startedAt` | 墙钟耗时（跨 CLI 执行的证据字段） |

`upstreamChildId` 由 `formatContinuation()` 返回、`buildRunBase()` 写入（`src/context-replay.js`、`src/dsh/adapter.js`）。
`durationMs` 由 `run-store normalize()` 从起止时间推导，不信任调用方自报。

---

## 3. 只读/审计派单的落盘策略（C1 §5）

| `artifactPolicy` | 允许写盘 | `artifacts` | 记录标记 |
| --- | --- | --- | --- |
| `none` | ❌ 不得写工作区（含 `.meetingstone/runs/`） | 必须 `[]` | 违规时 `artifactPolicyViolation: true` |
| `runs`（缺省） | ✅ 仅 `.meetingstone/runs/`（或隔离工作树内同名目录） | 必须列真实路径 | — |

派单入口：`meetingstone_dispatch({ artifactPolicy: 'none' | 'runs' })` → `validateTaskSpec`（枚举校验）→ `renderTaskBrief` 简报 → 适配器提示词中的输出契约按策略切换文案（`renderOutputContract(policy)`）。

---

## 4. 旧记录兼容

1. 旧记录缺 `taskId/artifactPolicy/upstreamChildId/...` → `loadRun` 保持缺省（不伪造、不回写）；`listRuns` 统一映射为 `null`（列表可读）。
2. 新字段只在有意义时写入（`artifactPolicyViolation`/`durationMs`/`upstreamChildId` 条件写入），避免历史记录被无意义填充。
3. 只有发生 overlap 回写时旧记录才会被重写一次（既有机制），重写按当前 normalize 规则，不改变原值语义。
4. `schemaVersion` 保持 `1`：新增字段均为可选，不触发版本升级。

---

## 5. 示例（带 continuation + taskId 的新记录，节选）

```json
{
  "schemaVersion": 1,
  "childId": "3ca77be6-…",
  "role": "role-sashi",
  "provider": "acp",
  "model": null,
  "status": "completed",
  "startedAt": 1794459742514,
  "finishedAt": 1794459980905,
  "durationMs": 238391,
  "taskId": "task-5",
  "artifactPolicy": "runs",
  "upstreamChildId": "33b87e20-…",
  "continuationBytes": 10302,
  "taskSpec": { "title": "…", "artifactPolicy": "runs", "acceptance": ["…"] },
  "handoff": {
    "conclusion": "…",
    "evidence": [{ "file": "src/client/index.js", "line": 1713, "finding": "…" }],
    "artifacts": [".meetingstone/runs/v1-r2-verify.md"],
    "openIssues": ["…"],
    "nextAction": "…"
  },
  "artifacts": [".meetingstone/runs/v1-r2-verify.md"],
  "evidence": [],
  "openIssues": ["…"],
  "nextAction": "…"
}
```

---

## 6. 代码点（复审用）

| 能力 | 位置 |
| --- | --- |
| 策略字段与枚举校验、简报、摘要 | `src/taskspec.js`（STRUCTURED_FIELDS / validateTaskSpec / renderTaskBrief / summarizeTaskSpec） |
| 结果回显策略、输出契约文案 | `src/result-contract.js`（ARTIFACT_POLICIES / parseStructuredResult / resultRecordFields / renderOutputContract） |
| 保护字段（含 artifactPolicy）、upstreamChildId | `src/context-replay.js`（collectProtectedFields / formatContinuation） |
| 初始记录（taskId/artifactPolicy/upstreamChildId） | `src/dsh/adapter.js`（buildRunBase） |
| 记录白名单/兼容/违规/耗时/列表 | `src/run-store.js`（normalize / listRuns） |
| 派单参数与透传 | `src/dsh/register.js`（dispatch parameters / input）、`src/dispatch/dispatcher.js`（adapter.start） |

## 7. 未纳入（明确范围外）

- 不把 run 细节写回 Team 任务板（单向）。
- 不新增 `schemaVersion`、不做旧记录批量迁移。
- `artifactPolicyViolation` 不升级为 `partial` 状态（C1 §5.3）。
- worktree 内产物的主工作区回收仍为独立问题（C1 §5.3/U3）。
