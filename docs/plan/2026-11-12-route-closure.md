# 路由证据闭环：三缺口复核与最小修复方案（2026-11-12）

- 复核者：悟空（role-wukong / `acp-hy4free` / `hy4free`）
- 任务：补齐上次《CLI 与模型路由验收矩阵》（`docs/plan/2026-11-12-route-matrix.md`）的三个「动态未闭环」缺口，目标是**让路由证据真正闭环**。
- 纪律执行：**未改任何源码、未改 profile、未重启 DSH、未装包、未发起新派单、未向任何队友发消息**。写入本报告前本工作树 `git status --short` 为空；本报告是本工作树唯一新增文件（文档，非源码）。
- 方法：全部结论自己动手验证，不照抄上次报告。用「本工作树」`src/` 的纯函数跑真实 profile，并读一手 run 记录。复核脚本与日志：`.meetingstone/runs/2026-11-12-route-closure-verify.mjs`、同名 `.log`。
- 证据目录：主项目产物目录 `d:\MeetingStone\.meetingstone\runs\`（本工作树之外，123 条 JSON）。profile：`C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`（mtime 2026-11-12 17:34:14 +0800）。

---

## 结论摘要

| 缺口 | 本次结论 |
|---|---|
| 1. 唐僧零派单记录 | **已闭合**：`52729d80` 真实记录 `provider=acp-kimi` / `model=kimi-k3.1-pro`，与上次静态核实逐字一致。 |
| 2. 八戒 `model=null` | **是证据缺口（非路由错误），该修**。根因：`buildRunBase` 只取 `role.channel.model`，而 in-process 通道用 `llmModel` 且生效值在 `agentOptions` 里；`buildRunBase` 根本没收到 `agentOptions`。最小改法=加 1 个 `effectiveModel` 字段（不重载 `model`）。 |
| 3. `reasoningEffort` 全通道不落盘 | **值得加**。根因两层：`buildRunBase` 不写、`run-store.normalize` 白名单无该键。**需同时指出任务前提的偏差**：`agentOptions.reasoningEffort` 只对 in-process 有值；ACP 四通道 `agentOptions={}`，reasoning 由 provider 行 `--effort` 承载。 |
| D. 最小修复 | 改 2 个文件 2 个函数 + 2 个调用点，加 3 个可选字段；纯增量、向后兼容、`schemaVersion` 不变。 |

**关于「能不能升级为动态可证」**：能，但要精确定义边界 —— 升级到**「记录级动态可证」**（每条派单记录自带 provider / effectiveModel / reasoningEffort，派单时经 fail-closed 校验后写入），**不是**「CLI 进程内自报 telemetry」。若 P0 要求进程级硬证据，仍需 CLI 侧自报（本次范围外，未确认）。详见 §5。

---

## 任务 A：唐僧实测（缺口 1）

来源：`d:\MeetingStone\.meetingstone\runs\52729d80-56aa-436e-afb8-52f73b59c457.json`（一手记录，mtime 2026-11-12 18:56:28 +0800，1741 B）。

| 字段 | 实测值 | 行号 |
|---|---|---|
| `childId` | `52729d80-56aa-436e-afb8-52f73b59c457` | :3 |
| `role` | `role-tangtang` | :5 |
| `channel` | `acp-cli` | :6 |
| **`provider`** | **`acp-kimi`** ✅ | :7 |
| **`model`** | **`kimi-k3.1-pro`** ✅ | :8 |
| `status` | `running`（`stopReason=null`、`finishedAt=null`、`resultBytes=0`） | :9,17,19 |
| `jobId` | `meetingstone-dispatch-99d0897da8794617` | :11 |
| `artifactPolicy` | `runs` | :35 |
| `operationId` / worktree | `840c495c-…`（独立工作树） | :42,48-54 |

**与上次静态核实是否一致：一致。** 上次报告 §2.1/§2.2 静态结论：`ch-acp-kimi` → `provider=acp-kimi`、`model=kimi-k3.1-pro`（profile:82-87）、provider 行 `subagent-acp-kimi --model kimi-k3.1-pro --effort high`（profile:233-248）。实测 `provider`/`model` 逐字吻合，`channel=acp-cli` 也与 `kind` 一致。**缺口 1「唐僧零记录 → 未验证」现已闭合**：当前配置下唐僧首次有派单记录，且路由与声明一致。

**关于「如果它还在跑，等它完成或用 `meetingstone_wait`」** —— 如实说明：
- `ToolSearch` 精确名查 `meetingstone_wait` / `meetingstone_dispatch` → 均 Not found；`WaitForMcpServers` → `ready:true`（无待连接 MCP）。**本会话未挂载这两个 MCP 工具，无法调用 `meetingstone_wait`。**（与上次报告 §3.3 一致）
- 复核期间已持续观察该文件：`status` 仍为 `running`，mtime/大小未变。**最终 `status` / `result` 未确认**（不推测）。
- **但这不影响路由证据闭环**：`provider` / `model` 由 `buildRunBase`（`adapter.js:292-341`）在**派单创建时**写入，且该记录写在 `await subagents.startActivation(spec)` 成功之后（`adapter.js:1146` → `:1249`），`subagents.getProvider(provider)` 也已通过（`:1013`）。即 `acp-kimi` 是**真实启动的子 Agent provider**，不是仅声明。`provider`/`model` 在终态结算里通过 `{...runBase, ...settled}` 原样透传（`:896-908`、`:1213`），不会随 `status` 改变。等待只会补 `status`/`result`，不改变路由证据。

**自身交叉验证**：本人本次派单记录 `7d87360a-ef43-46c0-918f-030a4c93b784.json`（`operationId=63cbe8ab-…`，即本工作树）为 `role-wukong` / `acp-hy4free` / `hy4free`（:5-8），与配置逐字一致，佐证 run 记录的 provider/model 口径可信。该记录 `artifactPolicy=runs`（:35）—— 即本次派单声明的落盘策略。

---

## 任务 B：`model=null` 是不是设计缺口

### B.1 定位写 run 记录的代码

写盘链路（已逐段读码确认）：
`adapter.start()` → `buildRunBase()`（`adapter.js:292-342`，调用点 `:1249`，卸载迟到路径 `:1189`）→ `emitRunStart(runBase)`（`:1289`）/ 终态 `{...runBase, ...settled}` → `onRunFinish` → `runStore.writeRun()`（`run-store.js:831`）→ `persistRecord()`（`:726`）→ **`normalize()`（`:574-701`，白名单）** → `JSON.stringify` → 落盘（`:748`）。

两个关键落盘函数：
- **`buildRunBase`（adapter.js:292-342）**：`model: role?.channel?.model ?? null`（**`:302`**）。
- **`normalize`（run-store.js:612-700）**：白名单 `model: record.model ?? null`（**`:619`**）—— 只是透传 `buildRunBase` 给的值，**不会补算**，也不认识 `llmModel` / `agentOptions` 等键。

### B.2 `model` 字段从哪来、为什么 in-process 是 null

`effectiveRole` = `route.role`（`adapter.js:1000`）；`resolveRoute`（`:953-989`）把角色 channel 与命中的通道实例合并成 `effectiveRole.channel`（`:962-963`），`route.instance` = `channelsById.get(channelId)`（`:970`）。

真实 profile 的通道形状（profile `:82-112`，本人读取确认）：
- ACP 四通道：有 `model`（如 `kimi-k3.1-pro`）+ `reasoning: high`。
- `ch-inprocess`（`:106-112`）：`kind: in-process` / `provider: spawn` / **`llmProvider: workbuddy` / `llmModel: deepseek-v4.1-flash` / `reasoning: high`**，**没有 `model` 键**。

于是 `effectiveRole.channel.model === undefined` → `buildRunBase` 的 `:302` 得到 `null`。**这与「`agentOptions` 里明明有 provider/model」不矛盾**：生效值来自另一条路径：

`buildChildAgentOptions(effectiveRole, route.instance)`（`adapter.js:367-381`，在 `:1088` 调用）→ 对 `kind==='in-process'` 从**通道实例**读 `llmProvider`/`llmModel`/`reasoning`，组装 `{ agentOptions: { provider, model, reasoningEffort } }`（`:371-379`）→ `...childAgentOptions` 展开进 `spec.request`（`:1127`）传给宿主。**`agentOptions` 从未传给 `buildRunBase`**（两个调用点 `:1189` / `:1249` 的参数都只有 `{ input, role, provider, childId, startedAt }`）。

**本人独立复核**（脚本对真实 profile 跑本项目纯函数，输出见 `.log`）：
```
唐僧 acp-cli     channel.model=kimi-k3.1-pro    buildRunBase.model=kimi-k3.1-pro  agentOptions={}
悟空 acp-cli     channel.model=hy4free          buildRunBase.model=hy4free        agentOptions={}
八戒 in-process  channel.model=(none) llmModel=deepseek-v4.1-flash  buildRunBase.model=null
                 agentOptions={"provider":"workbuddy","model":"deepseek-v4.1-flash","reasoningEffort":"high"}
沙僧 acp-cli     channel.model=glm-5.3-flash    buildRunBase.model=glm-5.3-flash  agentOptions={}
小白 acp-cli     channel.model=hy3              buildRunBase.model=hy3          agentOptions={}
```
→ **根因确定**：生效模型 `deepseek-v4.1-flash` 存在于 `agentOptions.model`，但 `buildRunBase` 读的是 `channel.model`（in-process 无此键）且未接收 `agentOptions`，`normalize` 又只做白名单透传 → 必然 `null`。

### B.3 该不该修

**结论：该修，但定性为「证据/可观测性缺口」，不是路由错误。**

- 不是错误：`model:null` 忠实反映了字段定义（`role.channel.model`）—— in-process 通道按设计就没有 `model` 键，LLM 路由是**宿主级**概念（`llmProvider`/`llmModel`），不是子 Agent channel model。路由本身是**正确**的：`agentOptions` 显式钉死（`adapter.js:367-381`、`:1121-1127`，2026-11-12 计费事故修复），且 `adapter.start` 两道 fail-closed 校验（`:1031-1058`、`src/roles/capabilities.js:160-173`）保证不一致必被拒。上次报告 §4.2 的「设计缺口」应精确理解为：**P0 验收所需的「生效模型」在 run 记录里不可观测**。
- 不修的代价：P0 三要素（provider/model/reasoningEffort）里的 model 对八戒永远无法用 run 记录验收 → 与本次「让路由证据真正闭环」的目标直接冲突。
- **不要重载 `model`**：若把 in-process 的 `model` 改成 `llmModel`，会让 `model` 在 ACP=「通道声明模型」、in-process=「宿主 LLM 模型」两种语义混用，且存量 123 条记录里八戒的 `model:null` 变成历史歧义，破坏现有口径。
- **最小改法**：纯增量加一个 `effectiveModel` 字段（= `agentOptions.model ?? channel.model ?? null`），`model` 原样不动。详见 §D。

---

## 任务 C：`reasoningEffort` 不落盘

### C.1 run 记录有没有地方能存 reasoning

**没有。** 两处都堵死：
1. `buildRunBase`（`adapter.js:296-341`）返回对象无任何 reasoning/effort 键。
2. `normalize`（`run-store.js:612-700`）白名单逐项枚举（`:613-699`），**无 `reasoning` / `reasoningEffort` / `effort`**。本人实测 `52729d80` 记录的顶层键共 51 个，正则 `reasoningEffort|"effort"|"reasoning"` 命中数 = **false**（脚本 §C 输出）；上次报告统计 114/114 条无此类顶层键，本次复核一致。
3. 读侧 `loadRun`（`:909-957`）与 `listRuns`（`:967-1036`）也都没有。

### C.2 派单时 `agentOptions.reasoningEffort` 有值，为什么没进记录

**先纠正任务前提（重要，避免照抄错误假设）**：`agentOptions.reasoningEffort` **只对 in-process（八戒）有值**。本人复核输出：唐僧/悟空/沙僧/小白四个 ACP 通道 `agentOptions={}`（空对象）。原因：`buildChildAgentOptions` 对 `kind !== 'in-process'` 直接 `return {}`（`adapter.js:370`）；ACP 的 reasoning 由 **provider 行 `--effort high`** 承载（profile `:44-45` 等），插件不传 `agentOptions`（上次报告 §5.3 亦证 ACP provider 显式 `capabilities.agentOptions=false`）。

所以「有值」的实际范围与「为什么没进记录」分两层：
- **in-process**：`agentOptions.reasoningEffort='high'` 确有值，但它和 B 一样 —— 只进 `spec.request`（`:1127`），**没进 `buildRunBase` 参数**，而 `buildRunBase`/`normalize` 都没有该字段 → 不落盘。
- **ACP 四通道**：连 `agentOptions.reasoningEffort` 都不存在（是 `--effort` CLI 参数），更谈不上落盘。真正与「实际强度」对应的是 `effectiveRole.channel.reasoning='high'`（配置派生，且被 `adapter.start` 严格校验 `:1053-1058` 钉死），但 `buildRunBase` 没读它。

→ **统一根因**：`buildRunBase` 既不接收 `agentOptions`，也不读 `channel.reasoning`；`normalize` 白名单无该键。两层都缺，所以「全通道不落盘」。

### C.3 值不值得加（记录变大 vs 可验证性）

**值得加，成本可忽略。**

- **记录变大**：加 3 个短字符串字段约 90–110 B。`MAX_FILE_BYTES = MAX_RESULT_BYTES(256KB) + MAX_CHANGED_FILES_BYTES + 512KB`（`run-store.js:74`），上限 ≥768KB；现存最小记录 `52729d80` 仅 1741 B。增量占比 ≤0.02%，不会触发 `persistRecord` 的超限裁剪（`:731-743`）。**「记录变大」不构成反对理由。**
- **可验证性收益**：正是 P0 验收三要素之一。加完后 5 个角色 × 3 要素都能从 run 记录直接核对，把「只能静态证明」升级为「记录级动态可证」。
- **反例/边界**：这些值仍是**配置派生 + fail-closed 强制**（`channel.reasoning` / `agentOptions`），不是从 CLI 进程读回的 telemetry。加字段能做到「声明 = 强制 = 落盘」三者一致，但做不到「进程内真实 effort 自报」。这一点必须写清，避免过度宣称（见 §5）。

---

## 任务 D：最小修复方案（可直接交 Lead 实施）

### D.1 改动清单（2 文件 / 2 函数 / 2 调用点，纯增量）

**① `src/dsh/adapter.js` — `buildRunBase`（:292）**
- 形参增加 `agentOptions`（默认 `{}`）：`function buildRunBase({ input, role, provider, childId, startedAt, agentOptions })`。
- 在返回对象里新增 3 个字段（放在 `provider` / `model` 附近，语义相邻）：
  ```js
  effectiveProvider: agentOptions?.provider ?? null,
  effectiveModel: agentOptions?.model ?? role?.channel?.model ?? null,
  reasoningEffort: agentOptions?.reasoningEffort ?? role?.channel?.reasoning ?? null,
  ```
  取值语义：
  | 通道 | effectiveProvider | effectiveModel | reasoningEffort |
  |---|---|---|---|
  | ACP（唐僧/悟空/沙僧/小白） | `null`（无宿主 LLM 覆盖） | `channel.model`（本就正确） | `channel.reasoning`（=`--effort`，被 `:1053-1058` 钉死） |
  | in-process（八戒） | `workbuddy` | `deepseek-v4.1-flash` | `high` |
  - `model` 字段**原样保留**（`:302` 不动），避免语义混用与历史歧义。
  - `?? null` 兜底：老数据/异常入参不抛错。

**② `src/dsh/adapter.js` — `start()` 两个 `buildRunBase` 调用点**
- `:1249`：`buildRunBase({ input, role: effectiveRole, provider, childId, startedAt, agentOptions: childAgentOptions.agentOptions })`
- `:1189`（卸载迟到路径）：同样补 `agentOptions: childAgentOptions.agentOptions`。
- `childAgentOptions` 已在 `:1088` 定义，位于两个调用点之前，直接可用；无需重算。

**③ `src/run-store.js` — `normalize()`（:612 返回对象）** —— **必改，否则新字段被白名单丢弃**
- 新增白名单项（带 `?? null` 兜底，保证旧记录可读）：
  ```js
  effectiveProvider: record.effectiveProvider ?? null,
  effectiveModel: record.effectiveModel ?? null,
  reasoningEffort: record.reasoningEffort ?? null,
  ```

**④ 可选（不改也能闭环，仅为 `list_runs` 便利）**
- `src/run-store.js:978-1033` `listRuns()` 摘要白名单加 3 键；
- `src/dsh/register.js:873-894` `meetingstone_list_runs` 的 slim 白名单加 3 键。
- `loadRun()`（`:909-957`）用 `{...record}` 展开，**无需改动**，新字段自动返回。
- `get_task` 走 `loadRun`，故**验收读取路径无需改**。

### D.2 兼容性（会不会破坏现有记录）

**不会。** 逐项核对：
- 3 个字段全部**新增、可选、缺省 `null`**；`schemaVersion` 保持 `1`（`:613`）；现有 51 个键一个不动、语义不变。
- 存量 123 条记录缺这些键 → 读侧 `?? null` 得 `null`，不报错。`loadRun` 只做 `JSON.parse` + `projectInterrupted` + 展开（`run-store.js:932-957`），**无 zod / 严格 schema 校验**（已 grep 确认 `src/run-store.js` / `register.js` 无针对 run 记录的 `.parse()`），不会因未知键拒绝。
- `emitRunFinish` / `backfillLateSettlement` / `rememberFinished` 都用 `{...runBase, ...settled}` 透传（`adapter.js:896-908`、`:1213-1222`），新字段在 running→终态全程不丢。
- **不回填存量**：绝不给旧记录补写这些字段（那是伪造证据）。修复后**新派单**才带全字段；`52729d80`（唐僧）与 `7d87360a`（悟空）属修复前记录，仍无新字段 —— 其 `provider`/`model` 证据有效，但 `reasoningEffort` 需靠修复后的新派单补齐。

### D.3 测试怎么写（复用现有测试，不新建文件）

现有可挂靠点：`tests/dsh-adapter.test.mjs`（`buildChildAgentOptions` 回归 `:854-901`、`startActivation` 显式路由断言 `:876-901`；`fakeCtx` 提供 `onRunStart`/`onRunFinish` 钩子 `:237`、`:743-744`、`:826`）、`tests/run-store.test.mjs`（`写读往返：字段白名单`）、`tests/p0-bc-regression.test.mjs:150`（`buildRunBase` → 磁盘字段断言范式）。测试入口 `node scripts/run-tests.mjs`（`node --test` 枚举 `tests/**/*.test.mjs`）。

1. **`tests/run-store.test.mjs` — 白名单往返**：`writeRun()` 写入带 `effectiveProvider/effectiveModel/reasoningEffort` 的记录，`loadRun()` 断言三值原样返回；再写一条**不带**这三键的旧形状记录，断言读回为 `null` 且不抛错（向后兼容）。同时断言一个白名单外的键（如 `secret`）仍被丢弃。
2. **`tests/dsh-adapter.test.mjs` — in-process 闭环**：扩写 `:876` 的回归用例，给 fixture channel 补 `reasoning:'high'`，用 `onRunStart` 捕获 `runBase`（或 `writeRun` 后的磁盘记录），断言
   `effectiveProvider==='workbuddy'`、`effectiveModel==='deepseek-v4.1-flash'`、`reasoningEffort==='high'`，且 `model===null`（保持原语义）；并保留原 `spec.request.agentOptions` 断言（`:896-900`），证明「传给宿主的值」与「落盘的值」同源。
3. **`tests/dsh-adapter.test.mjs` — ACP 闭环**：新增一例用 `acp-cli` 角色（`channel.model='kimi-k3.1-pro'`、`reasoning:'high'`），断言 `agentOptions==={}`、`effectiveProvider===null`、`effectiveModel==='kimi-k3.1-pro'`、`reasoningEffort==='high'`。
4. **回归**：`npm test`（`scripts/run-tests.mjs`）全绿；`npm run verify`（host-schema / manifest / package 校验）通过，确认新增字段不影响 schema 校验。
5. **验收脚本（Lead 侧，修复后）**：对 5 个角色各补 1 次极小派单，读 `.meetingstone/runs/<childId>.json` 核对 provider / effectiveModel / reasoningEffort 与 profile 逐项一致 —— 即本次「动态可证」的落地验证。

### D.4 为什么不选「只加 `agentOptions` 一个字段」这一更小的方案

单加 `agentOptions` 对象确实只改 1 个字段，但：ACP 四通道 `agentOptions={}`，其 `reasoningEffort`（=`--effort high`）仍不落盘 → 缺口 3 对 4/5 角色仍未闭合，且 `effectiveProvider`/`effectiveModel` 语义隐含在对象里不便于列表核对。故推荐 3 个扁平标量字段：改动量同为「2 函数 + 2 调用点」，但闭合全部 5 角色 × 3 要素。

---

## 结论：修完之后能否从「静态可信」升级为「动态可证」

**能升级为「记录级动态可证」，但必须说清边界，不能过度宣称。**

- **闭合后的证据链（每个新派单记录自洽）**：`provider`（`route.provider`，`getProvider` 通过后才启动）+ `effectiveModel`（`agentOptions.model` 或 `channel.model`）+ `reasoningEffort`（`agentOptions.reasoningEffort` 或 `channel.reasoning`），在 `startActivation` 成功后由 `buildRunBase` 一次性写入，经 `normalize` 白名单落盘；配合已有的两道 fail-closed 校验（`capabilities.js:160-173`、`adapter.js:1031-1058`）与 provider 行 `--model/--effort` 静态证据 → **声明 = 强制 = 落盘**三者一致，5 个角色 × 3 要素都能从 run 文件直接核对，不再依赖「翻配置 + 肉眼比对」。上次报告 §3 的「唐僧未验证 / 八戒 model 运行时未验证 / reasoningEffort 运行时不可观测」三行均可改写为「可验证」。
- **边界（未确认 / 不谎称）**：这些值仍是**配置派生 + fail-closed 强制**，不是从 CLI 子进程读回的 telemetry。run 记录的 `model`/`effectiveModel` 不能单独证明 CLI 进程内用了该模型 —— 需要 CLI 侧自报才能拿到进程级硬证据（本次范围外，**未确认**）。所以严格表述是「动态可证（记录级）」，而非「进程级实测」。
- **存量数据**：修复只影响新记录；123 条存量不回填（不伪造）。唐僧已有 `52729d80`（provider/model 有效），其 `reasoningEffort` 与全矩阵新字段需靠修复后的新派单补齐。

**给 Lead 的三步**：(a) 按 §D.1 实施（2 文件、纯增量）；(b) 按 §D.3 跑测试与 `npm run verify`；(c) 修复后对 5 角色各补 1 次极小派单，读 run 记录核对三字段 —— 至此路由矩阵从「静态可信 + 动态部分未闭环」升级为「静态可信 + 动态可证（记录级）」。

---

## 未验证 / 风险 / 后续建议

| 项 | 状态 | 说明 |
|---|---|---|
| `52729d80` 最终 `status`/`result` | **未确认** | 复核期间仍 `running`；`meetingstone_wait` / `meetingstone_dispatch` 本会话未挂载（`ToolSearch` Not found、`WaitForMcpServers=ready:true`），无法等待。不影响 provider/model 路由证据（创建时即写入，见 §A）。 |
| CLI 进程内真实 model/effort 回读 | **未确认** | 修复后仍属配置派生证据；需 CLI 自报（范围外）。 |
| 修复后新派单的全字段实测 | **待 Lead** | 本次纪律禁止改码/派单，仅给方案；实施后需真机回归。 |
| `ch-codex-astra`/`ch-codex-sol` 无 reasoning | 沿用上次结论 | 当前无启用角色引用，不导致派单失败；非本次三缺口范围。 |

---

## 证据索引（file:line）

| 结论 | 证据 |
|---|---|
| 唐僧实测 provider/model | `runs/52729d80-56aa-436e-afb8-52f73b59c457.json:3-9,11,35,42` |
| 本人派单记录 / artifactPolicy=runs | `runs/7d87360a-ef43-46c0-918f-030a4c93b784.json:5-8,35,42` |
| `buildRunBase` 的 model 派生 | `src/dsh/adapter.js:292-342`（`:302`） |
| `buildChildAgentOptions` 组装 agentOptions | `src/dsh/adapter.js:367-381`（`:370,372,376-379`） |
| agentOptions 只进 spec.request、不进 buildRunBase | `src/dsh/adapter.js:1088,1102,1127,1146,1189,1249,1289` |
| resolveRoute / effectiveRole / instance | `src/dsh/adapter.js:953-989,1000-1001` |
| 两道 fail-closed 校验 | `src/dsh/adapter.js:1031-1058`；`src/roles/capabilities.js:160-173` |
| `normalize` 白名单（无 reasoning） | `src/run-store.js:574-701`（`:612,619`） |
| 写盘链路 writeRun→persistRecord→normalize | `src/run-store.js:726-759,831-845` |
| 读侧无严格 schema（兼容） | `src/run-store.js:909-957`（`JSON.parse`+展开） |
| 列表/slim 白名单（可选扩展） | `src/run-store.js:967-1036`；`src/dsh/register.js:873-894` |
| 文件大小上限（记录变大可忽略） | `src/run-store.js:74`（≥768KB） |
| profile 通道形状 | `C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml:82-112`（`ch-inprocess` 无 model）、`:42-45`（`--model/--effort`） |
| 现有可挂靠测试 | `tests/dsh-adapter.test.mjs:237,743-744,826,854-901`；`tests/run-store.test.mjs:25+`；`tests/p0-bc-regression.test.mjs:150` |
| 本人独立复核脚本/日志 | `.meetingstone/runs/2026-11-12-route-closure-verify.mjs`、`.log` |
| 工具不可用 | `ToolSearch('meetingstone_wait'/'meetingstone_dispatch') → Not found`；`WaitForMcpServers → ready:true` |
