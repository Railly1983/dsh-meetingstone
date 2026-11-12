# 上下文与交接契约（C1 · V1 唯一事实源）

> 任务：C1（task-5）｜执行：沙僧｜2026-11-12｜状态：**定稿（文档先行，实现改动留给 C2/C3）**
> 依据：`docs/reference/交接文档_V1.1.md` §6.4、`docs/reference/efficiency-v1.0.md` §3.2/§3.3/§8、V1/V2 实测结论（`docs/plan/verify/2026-11-12-v1-goal.md`、`2026-11-12-v2-teams.md`）
> 地位：本文件是「三层上下文 + 六字段交接 + 派单/结果契约 + Runs 字段」的**唯一事实源**；`src/taskspec.js`、`src/result-contract.js`、`src/context-replay.js`、`src/run-store.js` 与本文件冲突时，以本文件为准（实现差异清单见 §9，由 C2/C3 落地）。
> 边界：本任务只定稿契约 + 标注代码点，**未改任何代码/配置/profile**。

---

## 0. 一页结论

1. **三层上下文固定**：L1 公共（稳定、最前、字节级不变；禁时间戳/任务 ID/随机数）→ L2 任务（最小必要，追加）→ L3 交接（不可信、有界、只放上一轮终态）。
2. **六字段交接模板**采用「`TaskSpec` 字段 + `handoff` 字段」拼合，**不新增结果字段**（例外只有两个已批准项：`artifactPolicy`、`taskId`）；逐字段映射见 §2。
3. **禁止默认传聊天历史**：契约里没有「聊天历史/messages」字段；任务上下文只能来自 `TaskSpec`/`ContextPack`/`contextRefs`/`continuesFrom`。
4. **只读例外**：只读/审计派单允许 `artifactPolicy:"none"`（不落 full 产物）；需要落盘时用 `"runs"` 且**只允许**写 `.meetingstone/runs/`；两条规则不再冲突（§5）。
5. **Runs 可加 `taskId` 外键**：单向引用 Team 任务板，**不把 run 细节写回 Team 任务**（§6）。

---

## 1. 三层上下文（Layer Model）

### 1.1 L1 公共上下文（Public / Stable）

| 项 | 内容 |
| --- | --- |
| 定义 | 跨任务不变的部分：角色身份与人设（`role.prompt`，缺省回退 `description`）、项目级稳定规范（`AGENTS.md`/`CLAUDE.md` 由宿主 `dsh-agent-instructions` 注入、`.meetingstone.json` 的 `dispatchNotes`/`projectRules`）、工具定义与输出契约。 |
| 注入位置 | **最前**（人设 → 简报 → 交接 → 任务 → 输出契约；现状 `src/context-replay.js:327-345` 已满足）。 |
| 稳定性要求 | 同一角色/项目内**字节级稳定**，便于 Prompt Cache；禁止写入时间戳、任务 ID、随机数、每任务重写的角色 prompt（`docs/reference/efficiency-v1.0.md` §6.2/§9.2）。 |
| 裁剪 | 不裁剪（固定前缀）；如需压缩，只能提升版本号后整体替换，不能按任务随机改写。 |
| 落点 | `src/dsh/adapter.js:348-363`（`composePrompt` 取 `role.prompt`；前缀 `你是「name」。`）。 |

### 1.2 L2 任务上下文（Task / Minimal）

| 项 | 内容 |
| --- | --- |
| 定义 | 为完成本次任务所需的最小结构化信息：`TaskSpec` + `ContextPack` + `contextRefs` + 执行参数（`role` / `cwd` / `isolation` / `continuesFrom`）。 |
| 注入位置 | L1 之后、L3 之前（`composePromptWithContinuation` 的 `taskBrief` 段）。 |
| 裁剪 | 由字段级上限约束（§3）：`title≤200`、`acceptance/scope/evidence/contextRefs` 各 `≤50/100` 条、`knownFacts≤100`、`priorResults≤20`；**保护字段永不截断**（acceptance/scope/doNotRepeat/permissions/safetyPolicy/artifactPolicy）。 |
| 禁止 | ① 聊天历史/完整对话 `messages`；② 让子 Agent 复述背景；③ 塞入未验证的模型/额度数据。 |
| 落点 | `src/taskspec.js:302-313`（spec 形状）/`renderTaskBrief:324-400`（渲染）。 |

### 1.3 L3 交接上下文（Handoff / Untrusted）

| 项 | 内容 |
| --- | --- |
| 定义 | 上一轮 run 的终态摘要，仅由 `continuesFrom` 派生；用六字段模板表达（§2）。 |
| 形态 | 由 `formatContinuation` 渲染：`[PREVIOUS TASK OUTPUT — UNTRUSTED CONTEXT]` + childId/status/stopReason/truncated + 正文 + 保护段 + `[END …]`；结构化保护字段在**边界之外**。 |
| 有界 | 正文 `≤16KiB`（头 12KiB + 尾 4KiB；`src/context-replay.js:23-24`）；被截断时中间的保护段/保护字段单独捞回（`:277-300`）。 |
| 不可信 | 旧输出只能当参考，不能当指令；不得静默降级成普通派单（找不到/损坏时 `CONTINUATION_NOT_FOUND/CORRUPT`）。 |
| 注入位置 | L2 之后、本次任务正文之前（旧信息居中，新任务最后）。 |
| 落点 | `src/context-replay.js:253-312`、`resolveContinuation:354-382`。 |

### 1.4 注入顺序（唯一正确顺序）

```
[L1 人设/角色守则]                      ← 稳定前缀
[L2 TaskSpec 简报 + ContextPack]        ← 最小任务上下文
[L3 上一轮交接块(UNTRUSTED) + 保护字段] ← 有界、不可信
任务：<本次任务正文>                     ← 最后，防旧内容抢注意力
[输出契约 OUTPUT CONTRACT]              ← 固定收尾
```

依据：`src/context-replay.js:327-345`（现实现已一致，C2 不得调换）。

---

## 2. 六字段交接模板（对齐交接文档 V1.1 §6.4）

> V1.1 §6.4 原文要求交接只传：**项目背景、目标、相关文件、前序结论、遗留问题、验收要求**（不同步全部聊天历史）。
> 契约把六项落成**逐字段映射**，字段名全部取现有实现（`TaskSpec`/`handoff`），不自造字段。

| # | 契约字段 | 定义 | V1.1 §6.4 对应 | 现有实现落点 | 必填 | 上限 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **目标与验收**（`title` + `objective` + `acceptance`） | 本任务要达成什么、按什么验收 | 目标 / 验收要求 | `TaskSpec.title/objective/acceptance`（`src/taskspec.js:302-307`）；`handoff` 不含此三者 → 由 `taskSpec` 摘要携带 | 是（`title`；声明 `scope` 则 `acceptance` 必填） | title≤200 字符；objective 自由；acceptance 原样不截断 |
| F2 | **项目背景与相关文件**（`contextPack.files` + `contextRefs`） | 接收者必须知道的背景 + 需读文件（给路径不重搜） | 项目背景 / 相关文件 | `ContextPack.files`（≤100）、`TaskSpec.contextRefs`（≤100） | 否 | 单条≤500 字符 |
| F3 | **前序结论与已确认决策**（`contextPack.knownFacts` + `priorResults[]`） | 已确认事实与上轮结论摘要，避免重做 | 前序结论 | `knownFacts`（≤100）、`priorResults[{summary, artifactRef}]`（≤20，summary≤500） | 否 | 单条≤500 字符 |
| F4 | **已完成与产物位置**（`handoff.artifacts`） | 上轮已产出什么、产物路径 | 相关文件（产物部分） | `handoff.artifacts`（≤10，`src/result-contract.js:249-269`） | 否 | 单条≤1000 字符 |
| F5 | **证据**（`handoff.evidence`） | `file:line` + 原文/命令结果，**片段内联 ≤5 行** | 前序结论（证据部分） | `handoff.evidence[{file,line,finding}]`（≤10） | 否 | 单条≤1000 字符；原文片段≤5 行 |
| F6 | **遗留问题与下一步**（`handoff.openIssues` + `handoff.nextAction`） | 未决问题/风险 + 下一动作 | 遗留问题 | `openIssues`（≤10）、`nextAction`（≤2KiB） | 否 | 单条≤1000 字符 |

**组合规则**：
1. 交接物 = 「`taskSpec` 摘要（F1/F2）」+「`contextPack`（F2/F3）」+「`handoff`（F4/F5/F6）」；**不新增任何 handoff 子字段**。
2. `handoff.conclusion` 不是独立第 7 字段，它是 F1 的摘要化结论（≤500 字符），仅用于首屏；六字段完整性以 F1–F6 为准。
3. 保护字段（`acceptance`/`scope`/`doNotRepeat`/`permissions`/`safetyPolicy`/`artifactPolicy`）一律**原文进入重放块**，不参与 16KiB 截断（`src/context-replay.js:98-154`）。
4. 证据片段必须内联（`file:line` + ≤5 行原文），**只给行号等于要求接收者重读**（T3 实测结论）。

---

## 3. 派单契约（TaskSpec + ContextPack）

来源：`src/taskspec.js`。**结构化模式**由 9 个字段任一出现触发（`:20-30`）。

| 字段 | 类型 | 规则（现状实现） | 契约要求 |
| --- | --- | --- | --- |
| `title` | string | 结构化模式唯一硬必填（`:140-144`）；落盘截断 120（`:428`） | 必须短、可展示 |
| `objective` | string | 可省略=任务正文即目标（`:146-154`） | 建议给；≤400 落盘 |
| `scope` | `{include[], exclude[]}` | 各 ≤100 条、单条≤500，超限**显式拒绝**不静默切（`:159-176`） | 声明即边界 |
| `acceptance` | string[] | 声明 `scope` 时必须 ≥1 条（`:178-187`）；保护字段不截断 | 验收可判定 |
| `evidence` | string[] | ≤50 条（自由文本，落盘裁剪） | 期望证据形态 |
| `contextRefs` | string[] | ≤50 条；未提交文件必须给**绝对路径**（V1 F2 实测） | 给路径不重搜 |
| `roleHint` | string | ≤200（`:195-202`）；仅随简报传递不改路由 | 可选 |
| `outputBudget` | `number | {summaryTokens, notes}` | 正整数；notes≤500（`:204-232`） | 摘要预算 |
| `contextPack` | object | `knownFacts/files/priorResults/doNotRepeat`（`:234-288`）；`doNotRepeat` 保护不截断 | 最小上下文 |
| `artifactPolicy` **（新增）** | `"none" \| "runs"` | **本契约新增（Lead 已批准）**，见 §5；缺省 `"runs"` 等价现状 | 只读例外 |
| `taskId` **（新增，工具参数层）** | string | **本契约新增（Lead 已批准）**，见 §6；不进 TaskSpec 校验，进 run 记录 | 跨系统外键 |

**校验口径**：只拒绝「缺了就无法执行/无法验收」的字段；简单查询不传结构化字段一律放行（旧路径零行为变化）。

---

## 4. 结果契约（子 Agent 输出 JSON）

来源：`src/result-contract.js`。字段闭集：`status / summary / evidence / artifacts / changedFiles / tests / openIssues / nextAction`（`:84-94`）；**不新增结果字段**，仅新增 `artifactPolicy` 回显（§5）。

| 字段 | 规则 | 落盘 |
| --- | --- | --- |
| `status` | 闭集 `completed | partial | blocked | failed`（`:17`） | `resultStatus`（不覆盖宿主终态 `status`） |
| `summary` | 300–500 token；不复述背景 | `summary`（≤8KiB，超限截断并标 `summaryTruncated`） |
| `evidence` | `[{file,line,finding}]`（字符串容错折成 finding） | `evidence`（≤50） |
| `artifacts` | 产物路径（见 §5 约束） | `artifacts` |
| `changedFiles` | 只读任务必须 `[]`；落盘到 `reportedChangedFiles`，**不覆盖** git 计算的 `changedFiles` | — |
| `tests` | 运行过的测试与结果 | `resultTests` |
| `openIssues` | 未决问题/风险 | `openIssues` |
| `nextAction` | 下一角色动作 | `nextAction`（≤2KiB） |
| `artifactPolicy` **（新增）** | 必须回显派单声明值（`none`/`runs`）；缺省按 `runs` | `artifactPolicy` |
| handoff 派生 | `conclusion/evidence/artifacts/openIssues/nextAction` 由上述字段派生（`:249-269`） | `handoff` |

**解析容错**：取回复中**文档顺序最后一个**合法结构化对象（`:111-144`）；提取失败退回纯文本，完整输出仍落盘（`:12-13`）。

---

## 5. 只读/审计派单的落盘例外（`artifactPolicy`）

### 5.1 冲突（V2 实测）

- 输出契约要求「完整内容写入项目产物目录（如 `.meetingstone/runs/`），回复里只给路径」（`src/result-contract.js:320`）。
- 但只读/审计类任务按定义不得写工作区；且 worktree 隔离下产物落在 worktree 内、主工作区不可见（V1 F3）。
→ 两条规则直接冲突：只读任务要么被迫违反只读，要么不落 full 产物。

### 5.2 契约定义

`TaskSpec.artifactPolicy: "none" | "runs"`（新字段，已批准）：

| 值 | 含义 | 允许写盘 | artifacts 字段 | 适用 |
| --- | --- | --- | --- | --- |
| `"none"` | 不落 full 产物；完整内容只在 run 记录的 `result` | ❌ 不得写入工作区（含 `.meetingstone/runs/`） | 必须 `[]`，不得声称已写文件 | **只读/审计默认** |
| `"runs"`（缺省） | 允许把完整报告落到产物目录 | ✅ **只允许** `.meetingstone/runs/`（或隔离工作树内的同名目录）；❌ 不得写 `src/**`、`tests/**`、`docs/**` 等被 git 跟踪的路径 | 必须列出实际路径（≤10） | 需落盘审计/长报告任务；写任务默认 |

### 5.3 规则（消除冲突）

1. `artifactPolicy` 由**派单方声明**并进入保护字段（不随截断丢失）；结果必须**回显原值**。
2. `artifactPolicy:"none"` 时，结果若给出 `artifacts` → 视为契约违规：C3 在记录标 `artifactPolicyViolation:true`，**不改变任务状态**（不把只读违规伪装成失败，也不静默吞掉）。
3. `artifactPolicy:"runs"` 且隔离模式为 `worktree` 时，产物路径必须写清是 worktree 相对路径；主工作区回收由 C3（Runs 证据规范）处理，本契约不承诺跨工作区可见。
4. 只读派单的「完整性」由 run 记录的 `result` 承载（现状已落盘，`MAX_RESULT_BYTES=256KiB`，`src/run-store.js:25`）；`none` 不等于丢证据，只等于不额外落文件。

### 5.4 放行矩阵

| 任务类型 | artifactPolicy | 允许写 `.meetingstone/runs/` | artifacts 必填 |
| --- | --- | --- | --- |
| 只读/审计 | `none`（默认） | ❌ | 必须 `[]` |
| 只读/审计 + 需落长报告 | `runs`（显式） | ✅（仅该目录） | ✅ |
| 写任务 | `runs`（缺省） | ✅ | 按需 |

---

## 6. Runs 记录与 `taskId` 外键

### 6.1 现有记录形状（`src/run-store.js:597-671`）

`schemaVersion / childId / runtimeId / role / channel / provider / model / status / stopReason / jobId / diagnostic / createdAt / startedAt / finishedAt / result / resultBytes / summary / evidence / artifacts / changedFiles / taskSpec / contextPack / title / continuation / continuationBytes / operationId / isolation / routing / worktree / overlap* / stopConfirmed` 等。

### 6.2 新增字段：`taskId`（可选）

| 项 | 定义 |
| --- | --- |
| 来源 | 派单工具顶层参数 `taskId`（与 `continuesFrom` 同级，`src/dsh/register.js:594-606` 参数块） |
| 落点 | run 记录顶层 `taskId: string \| null`（缺省 `null`，保持旧记录可读） |
| 语义 | **外键**：指向 Team 任务板任务 id（`team_task_create` 返回值）或其他外部任务 id；仅用于「执行事实 → 协作意图」的只读关联 |
| 方向 | **单向**：Runs 记录 `taskId`；**不把 run 细节写回 Team 任务**，不做双向同步（`docs/plan/2026-11-12-agent-team-fit.md` §4.1 第 4 条「单一事实来源约定」） |
| 约束 | 字符串≤200；不做格式校验（Team/外部 id 形态不同）；不参与去重、不参与上下文重放、不改变 continuation 语义 |
| 查询 | `list_runs`/`get_task` 原样透传；不做跨系统 join |

---

## 7. 禁止默认传聊天历史（硬规则）

1. 派单/交接契约中**不存在** `messages` / `chatHistory` / `transcript` 字段；未知字段一律忽略（`src/taskspec.js:13`），忽略即不进入提示词。
2. 任务上下文只允许来自：`TaskSpec`（§3）、`ContextPack`（§3）、`contextRefs`（路径）、`continuesFrom`（上一轮终态六字段）。
3. 同一会话内的完整历史只在**宿主会话内**存在，不随派单外发；子 Agent 是全新进程（外部 CLI 无真续聊，`src/context-replay.js:3-8`）。
4. 允许的例外：用户明确要求时，由调用方把必要片段**手工整理进 `knownFacts/contextRefs`**，仍受字段上限约束。
5. 可验证点：任何派单的最终提示词 = §1.4 顺序五段；C2 可用「无 continuation 时提示词不含上轮输出」与「提示词不含 `messages` 字样」做断言。

---

## 8. 兼容与迁移（零迁移）

1. 新字段全可选：`artifactPolicy` 缺省 `runs`、`taskId` 缺省 `null`，行为与当前一致。
2. 旧 run 记录读取不变（新增字段缺省不报错）；`list_runs/get_task` 不因缺字段失败（现状 `record.continuation ?? null` 同类处理，`src/run-store.js:646-651`）。
3. 六字段模板不新增 handoff 子字段，`buildHandoff` 输出形状不变（`src/result-contract.js:249-269`）。
4. 不做：结果字段扩张、Team 双向同步、`artifactPolicy` 自动推导（如按 isolation 猜）——一律显式。

---

## 9. 与现有实现的差异清单（交 C2/C3 落地）

| # | 差异 | 位置（file:line） | 需改点 | 归口 |
| --- | --- | --- | --- | --- |
| D1 | 交接模板未显式按六字段组织（handoff 只有 5 项，F1/F2 在 `taskSpec`） | `src/result-contract.js:249-269`；`src/context-replay.js:253-312` | **无需改结构**；在 `formatContinuation` 渲染文案中加六字段小标题（F1–F6），或在 `renderProtectedFieldsBlock` 后补摘要行 | C3 |
| D2 | 无 `artifactPolicy`（输出契约仍无条件要求写产物目录） | `src/result-contract.js:320`（契约文本）；`src/taskspec.js:20-30`（结构化字段表）；`src/context-replay.js:98-135`（保护字段白名单） | ① TaskSpec 增字段+枚举校验 ② 输出契约文案改「按 artifactPolicy」 ③ 结果回显 ④ 保护字段加入 | C3 |
| D3 | 无 `taskId` | `src/dsh/register.js:551-606`（参数）、`:714-733`（input）；`src/run-store.js:597-671`（记录） | 参数透传 + 记录字段 + `list_runs` 透传 | C3 |
| D4 | 只读派单要求写 `.meetingstone/runs` 全文与只读冲突 | `src/result-contract.js:308-322` | 随 D2 一起改为条件文案 | C3 |
| D5 | 重放记录无上游 childId（V1 F4：`continuationBytes` 有、上游 id 无） | `src/context-replay.js:301-311`、`src/run-store.js:646-651` | 增 `upstreamChildId` 字段（C3） | C3 |
| D6 | 提示词顺序已正确，无需改 | `src/context-replay.js:327-345` | 作为 C2 基线，禁止调换 | C2（只读基线） |
| D7 | 未知键静默忽略，聊天历史无入口 | `src/taskspec.js:13`、`:122-127` | 保持；C2 用测试固化 | C2 |
| D8 | `artifactPolicy` 未纳入保护字段白名单 | `src/context-replay.js:98-135` | 白名单加 `artifactPolicy`（防截断丢失） | C3 |

---

## 10. 验收断言（可执行，供 C2/C3 引用）

1. 无 `continuesFrom` 时，提示词**不含** `[PREVIOUS TASK OUTPUT`；有则恰好一个边界对。
2. `artifactPolicy:"none"` 的派单：结果 `artifacts` 必须为空；记录无产物文件（除 run JSON 本身）。
3. `artifactPolicy:"runs"`：`artifacts` 路径全部位于 `.meetingstone/runs/` 下。
4. `taskId` 出现在 run JSON 顶层且等于派单参数；Team 任务描述不被 run 内容改写。
5. 交接块含六字段标题且 `acceptance/scope/doNotRepeat` 原文出现（不被 16KiB 截断吞掉）。
6. 派单提示词不出现 `messages`/`chatHistory` 段。

## 11. 未决项（交给后续任务）

| # | 项 | 归口 |
| --- | --- | --- |
| U1 | 六字段标题的具体文案（中/英）与是否影响缓存前缀 | C3（文案）、C2（缓存） |
| U2 | `artifactPolicy` 违规是否升级为 `partial` 状态 | C3（建议只标 `artifactPolicyViolation`，不改状态） |
| U3 | worktree 产物回收（主工作区可见性） | C3（Runs 证据规范） |
| U4 | `taskId` 与 Team 任务的关联查询（是否需要 list_runs 过滤参数） | C3 |

## 12. 写入边界声明

本任务仅写本文件（`docs/design/`）；未改 `src/**`（含 write scope 内三个源码文件，仅做只读核对与差异标注）、未改 profile、未重启 DSH、未安装插件。§9 的代码改动由 C2/C3 执行。
