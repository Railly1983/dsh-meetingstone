# CLI 与模型路由验收矩阵（2026-11-12）

- 验证者：悟空（role-wukong / `acp-hy4free` / `hy4free`）
- 目标：Codex 交叉评审 P0 —— 每个正式启用的角色，派单后**实际用的 provider / model / reasoningEffort** 必须与配置一致，不能有继承父会话、错扣额度。
- 方法：先静态（零成本，含用项目自身纯函数跑真实 profile 的独立复核），再动态（复用 `.meetingstone/runs/*.json` 一手记录）。
- 纪律执行：未改 profile、未重启 DSH、未装包、未向任何队友发消息、未发起新派单（原因见 §4.1）。本工作树 `git status` 在写入本报告前为空。
- 配置基线：`C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`，mtime `2026-11-12 17:34:14 +0800`（= 09:34 UTC）。下文「当前配置」指该版本之后。
- 一手复核脚本与日志：`.meetingstone/runs/2026-11-12-route-matrix-verify.mjs`、`.meetingstone/runs/2026-11-12-route-matrix-verify.log`。

---

## 1. 结论摘要

**静态：可信。** 5 个启用角色的通道/角色/provider/model/reasoning 声明全部自洽，且与 provider 行的 `--model` / `--effort`（ACP）、`llmProvider` / `llmModel`（in-process）、`model`（codex）逐项一致。派单前有 `resolveRoleChannel`（`src/roles/capabilities.js:160-173`）与 `adapter.start`（`src/dsh/adapter.js:1031-1058`）两道 fail-closed 校验，不一致必然抛 `MODEL_UNSUPPORTED`。防继承/防错扣有明确代码证据：in-process 由 `agentOptions` 显式钉死（`adapter.js:367-381`、`:1121-1127`，注释逐字记录 2026-11-12 计费事故与修复），外部 CLI 由 provider 行 `--model` 固定，且 ACP provider 显式声明 `capabilities.agentOptions=false` 并拒绝任何需要 agentOptions 的请求（`@deepseek-ai/dsh-subagent-acp/lib/index.js:458,465`）——子进程根本不用宿主 LLM，不存在「角色写一套、父会话按另一套扣费」的路径。

**动态：部分未闭环。** 当前配置下 4/5 角色有派单记录：悟空、沙僧、小白的 `provider/model` 与配置逐字一致；八戒 `provider=spawn` 一致但 `model` 恒为 `null`（设计缺口，见 §4.2）；唐僧**零记录 → 未验证**。所有通道的 `reasoningEffort` 都**不落盘**，运行时不可观测 → 只能静态证明。本会话未挂载 `meetingstone_dispatch`，无法发起新派单，故本次未产生新的 childId。

**重点问题定性：** `ch-codex-astra` / `ch-codex-sol` 缺 `reasoning` **不会**导致当前任何派单失败（无启用角色引用它们），插件也**不会**注入默认强度；它导致 (a) GUI 把 codex 标为「不支持思考强度」，(b) 思考强度完全由 Codex CLI 自身默认值决定——codex provider 的配置 schema 里根本没有 effort 字段。

**P0 验收状态：partial。** 未发现任何实际路由错配或错扣证据，但也无法签「完全可信」：唐僧缺派单证据、八戒模型不入盘、reasoningEffort 全通道无运行时证据。

---

## 2. 静态核实

### 2.1 通道声明的 model / 角色声明的 model / reasoning

| 角色 | channelId | 通道声明的 model | 角色声明的 model | 通道 reasoning | 角色 reasoning | 是否一致 |
|---|---|---|---|---|---|---|
| 唐僧 | `ch-acp-kimi` | `kimi-k3.1-pro`（patch:86） | `kimi-k3.1-pro`（patch:135） | `high`（:87） | `high`（:136） | ✅ |
| 悟空 | `ch-acp-hy4free` | `hy4free`（:92） | `hy4free`（:151） | `high`（:93） | `high`（:152） | ✅ |
| 八戒 | `ch-inprocess` | `llmModel=deepseek-v4.1-flash`（:111），**无 `model` 键** | 无（:162-166） | `high`（:112） | 无 | ✅（特例，见下注） |
| 沙僧 | `ch-acp-flash` | `glm-5.3-flash`（:98） | `glm-5.3-flash`（:179） | `high`（:99） | `high`（:180） | ✅ |
| 小白 | `ch-acp-hy4` | `hy3`（:104） | `hy3`（:194） | `high`（:105） | `high`（:195） | ✅ |

**八戒特例**：in-process 通道用 `llmProvider` / `llmModel` 而不是 `model`，角色侧也确实没有 `model` 键，二者不构成冲突。`buildChildAgentOptions` 只对 `kind==='in-process'` 生效（`adapter.js:370`），从**通道实例**读 `llmProvider=workbuddy` / `llmModel=deepseek-v4.1-flash` / `reasoning=high`，组装 `agentOptions={provider,model,reasoningEffort}`（`:371-380`）。独立脚本实测输出：`{"provider":"workbuddy","model":"deepseek-v4.1-flash","reasoningEffort":"high"}`，`provider=spawn`。故八戒的 effective model 是 `deepseek-v4.1-flash`、reasoningEffort 是 `high`，只是这两个值都不写进 run 记录。

### 2.2 执行侧：provider 行 `--model` / `--effort` 与通道声明（外部 CLI 的真实模型在这里）

| 通道 | provider 行 | 行内模型 | 行内 effort | 通道 model / reasoning | 一致 |
|---|---|---|---|---|---|
| `ch-acp-kimi` | `subagent-acp-kimi`（patch:233-248） | `--model kimi-k3.1-pro`（:245） | `--effort high`（:247） | `kimi-k3.1-pro` / `high` | ✅ |
| `ch-acp-hy4free` | `subagent-acp-hy4free`（:217-232） | `--model hy4free`（:229） | `--effort high`（:231） | `hy4free` / `high` | ✅ |
| `ch-acp-flash` | `subagent-acp`（:32-46） | `--model glm-5.3-flash`（:43） | `--effort high`（:45） | `glm-5.3-flash` / `high` | ✅ |
| `ch-acp-hy4` | `subagent-acp-hy4`（:62-77） | `--model hy3`（:74） | `--effort high`（:76） | `hy3` / `high` | ✅ |
| `ch-inprocess` | `agent-default-model`（:20-24） | `provider=workbuddy` / `model=deepseek-v4.1-flash` | —（走 agentOptions） | `llmProvider=workbuddy` / `llmModel=deepseek-v4.1-flash` / `high` | ✅ |
| `ch-codex-astra` | `subagent-codex`（:49-54） | `model=gpt-6-astra`（:53） | **无** | `gpt-6-astra` / **无 reasoning** | ✅（模型层面） |
| `ch-codex-sol` | `subagent-codex-sol`（:55-61） | `model=gpt-6.1-sol`（:60） | **无** | `gpt-6.1-sol` / **无 reasoning** | ✅（模型层面） |

角色侧 `provider` 与通道实例 `provider` 亦逐项一致（`acp-kimi`/`acp-hy4free`/`spawn`/`acp`/`acp-hy4`），`providerNameFor()` 实测输出与配置一致。

### 2.3 两道一致性校验（为什么不一致必然被拒）

1. `resolveRoleChannel`（`src/roles/capabilities.js:134-239`）：有 `channelId` 时对 `model` / `reasoning` 逐项比较，**只在 expected 与 actual 都非空且不等时**返回 `MODEL_UNSUPPORTED`（`:160-173`）；无 `channelId` 时按 kind→model→reasoning 收窄，reasoning 收窄到 0 返回 `REASONING_UNSUPPORTED`（`:213-223`）。
2. `adapter.start`（`src/dsh/adapter.js:1028-1059`）：更严——`if (declaredModel && instance.model !== declaredModel)` 与 `if (declaredReasoning && instance.reasoning !== declaredReasoning)` 直接抛 `MODEL_UNSUPPORTED`（`:1047-1058`）。该码在 dispatcher 透传白名单（`src/dispatch/dispatcher.js:79-87`）。

**独立复核结果**（脚本 §1，对真实 profile 跑项目自身函数）：5 个启用角色 `resolve=OK`、model/reasoning 全部 `OK`、第二道严格校验全部 `PASS`，无一 `MISMATCH`。

### 2.4 配置源优先级（排除干扰项）

项目根 `.meetingstone.json:164-168` 的 `ch-inprocess` 缺 `llmProvider/llmModel/reasoning`，与 profile 不一致，但它**不生效**：`cfg = normalizeConfig(config)`（`src/index.js:92`）、`createDshAdapter(ctx, { channels: cfg.channels })`（`:335-336`）、`channels` 只取 `globalConfig.channels`（`src/session/config.js:748-750`），且 `index.js:202-204` 明确「项目 `.meetingstone.json` 不再参与角色合并」。**profile 是唯一权威**。这是一个维护风险（有人可能改错文件），不是当前故障。

---

## 3. 动态验证

### 3.1 证据来源与局限（必须先说清，否则会误判）

证据取自 `d:\MeetingStone\.meetingstone\runs\*.json`（114 条 JSON，主项目产物目录），由 `buildRunBase`（`adapter.js:292-341`）+ `run-store.normalize`（`src/run-store.js:574-701`）落盘。

- **`provider` 是真实观测**：`spec.provider = route.provider`（`adapter.js:1102`），且 `subagents.getProvider(provider)` 通过才启动（`:1013-1015`）。
- **`model` 是配置派生**：`model: role?.channel?.model ?? null`（`adapter.js:302`），不是从 CLI 进程读回的。外部 CLI 真实模型由 provider 行 `--model` 决定（§2.2 已静态核实）。因此 run 记录的 model 只能证明「派单时声明与实例一致、且通过了 `MODEL_UNSUPPORTED` 校验」，不能单独证明 CLI 进程用了该模型；二者合起来才是完整证据。
- **`reasoningEffort` 完全不落盘**：`run-store.normalize()` 白名单（`:612-700`）无 `reasoning` / `reasoningEffort` / `effort`；实测 114/114 条记录无此类顶层键。→ 运行时不可观测。

### 3.2 动态验证表（当前配置）

| 角色 | 预期路由 provider / model | 实测路由 provider / model | childId（证据） | 是否一致 |
|---|---|---|---|---|
| 唐僧 | `acp-kimi` / `kimi-k3.1-pro` | **无当前配置派单记录** | — | **未验证**（§4.1） |
| 悟空 | `acp-hy4free` / `hy4free` | `acp-hy4free` / `hy4free` | `beaff738-dfd4-44f6-bbb3-8d363acf0271`（本会话自身派单，`operationId=34231875-…` 即本工作树）、`d217d262-eed0-45d5-a23c-ee1f8ddb19a7`、`12d58077-8f25-479f-860a-0b4113264083` | ✅ |
| 八戒 | `spawn` / effective=`workbuddy` + `deepseek-v4.1-flash`（agentOptions） | `spawn` / `model:null` | `d8aee0f4-dc00-44e9-8ab7-1710ac581d07`（极小 probe，1807B，正文即「reply OK only. No tools. Min probe」）、`14da4947-51e0-44c5-b843-bac8f1a8873c` | provider ✅；**model 运行时未验证**（§4.2） |
| 沙僧 | `acp` / `glm-5.3-flash` | `acp` / `glm-5.3-flash` | `124e339f-8dd5-498c-b774-18a9a30224da` | ✅ |
| 小白 | `acp-hy4` / `hy3` | `acp-hy4` / `hy3` | `e856ffa4-76ef-4ae7-a707-f4c82fd80c95`、`47841797-71e3-4fcc-b8ed-d33d47019d37` | ✅ |

**自身交叉验证**：本次会话（悟空）的运行时模型身份为 Hy4 / `hy4free`，与 `beaff738` 记录的 `provider=acp-hy4free / model=hy4free` 及配置逐字一致。这是「派单后实际用的模型」最直接的一手证据，不依赖他人结论。

### 3.3 为什么「本次新派单」是未验证

- 本会话工具列表无 `meetingstone_dispatch`；`ToolSearch` 精确名查找返回 `Not found (1)`；`WaitForMcpServers` 返回 `ready:true`（无待连接 MCP）。→ **无法发起新派单**。
- 按纪律「能静态证明的就别花钱」，且不向 `sashi` / `xiaobai` / `bajie` / `route-probe` / `d1-verifier` / `auditor` 发消息；当前 runs 目录已有多个并行会话产生的当前配置派单（多个 `running` 记录），重复派单只会重复扣费。
- 故 §3.2 全部为**复用既有派单记录**（一手可读文件），不是本次新派单；未产生新 childId。

### 3.4 reasoningEffort 动态验证

| 角色 | 配置 reasoning | 运行时证据 | 结论 |
|---|---|---|---|
| 全部 5 个 | `high`（唐僧/悟空/沙僧/小白角色侧；八戒通道实例侧） | run 记录无该字段 | **未验证（运行时）**，仅静态可证 |

静态可证部分：ACP 四通道 `--effort high`（§2.2）、in-process `agentOptions.reasoningEffort='high'`（`adapter.js:378-379`，脚本实测）。

---

## 4. 不一致项 / 缺口根因

### 4.1 唐僧零记录（非配置错误，是证据缺失）
profile 于 09:34 UTC 切到 ACP 角色；`role-tangtang` 共 4 条历史记录，全部 `codex / gpt-6-astra`（最新 `107630cb-d5ed-478b-a510-52f63b1676ca`，05:58 UTC「D2-C1 codex 只读派单回归」，`failureClass=quota`：`Product subagent failure (product: Codex; stage: turn; category: limit)`），均属**旧配置**。全库 `acp-kimi` 仅 1 条，是已停用 `role-kimi`（`efc87779-68ad-4cf4-8d51-0962dc93ee61`，11-11 09:31 UTC，`model:null`）。→ 当前配置下唐僧从未被派单，且本会话无派单工具。

### 4.2 八戒 `model:null`
`buildRunBase` 只写 `role.channel.model`（`adapter.js:302`）；in-process 用 `llmModel`、角色侧无 `model` 键 → 落盘必然 `null`。真正生效的 `workbuddy / deepseek-v4.1-flash / high` 通过 `agentOptions` 传给宿主，但 `agentOptions` **不落盘**。同类语义缺口：run 记录的 `provider` 对 in-process 是子 Agent provider 名 `spawn`，不是 LLM provider `workbuddy`。→ 八戒的 provider/model 在 run 记录里语义与 ACP 通道不同，不能套用同一验收口径。

### 4.3 历史大量 `model:null`（沙僧 42 条、小白 21 条等）
这些记录早于「通道实例表合并进 effectiveRole」或早于 profile 写入 `channels[].model`；当时角色声明里没有 model → 落盘 null。当前配置（09:34 UTC 后）沙僧/小白记录均已带正确 model（`124e339f` / `e856ffa4`），缺口已随配置补齐。**历史记录不能证明当前配置**，本报告已按时间切分。

### 4.4 两份配置源不一致（潜在风险）
见 §2.4。建议清理或同步 `.meetingstone.json`，避免后续维护者改错文件后误判「八戒没钉模型、会继承父路由」。

### 4.5 reasoningEffort 无运行时字段
`run-store.js:612-700` 与 `buildRunBase` 都无该字段 → P0 要求「reasoningEffort 必须与配置一致」目前**无法用 run 记录验收**。

### 4.6 错误码透传不完整（次要，不影响正确性）
`dispatcher.js:79-87` 的 `PASSTHROUGH_PREFIXES` 不含 `REASONING_UNSUPPORTED` / `CHANNEL_NOT_FOUND` / `CHANNEL_MISMATCH` / `CHANNEL_AMBIGUOUS`；经 `canStart`（`:708-721`）会被包成 `PROVIDER_UNAVAILABLE`，经 `start` 失败会被包成 `ADAPTER_FAILED`，损失可诊断性。

---

## 5. 重点：`ch-codex-astra` / `ch-codex-sol` 没有 reasoning

现象：`cordis.patch.yml:113-122` 两条 codex 通道只有 `model`，无 `reasoning`；`subagent-codex` / `subagent-codex-sol` 行（`:49-61`）也只有 `model` + `permissionMode: never`。

### 5.1 会导致派单失败吗？——当前配置：不会
5 个启用角色的 `channel.channelId` 全部指向 `ch-acp-kimi` / `ch-acp-hy4free` / `ch-inprocess` / `ch-acp-flash` / `ch-acp-hy4`（patch:133,149,164,177,192），**没有任何角色引用这两条 codex 通道**（标注「备用」）。114 条 run 记录中当前配置下零 codex 派单；历史 4 次 codex 派单（唐僧，旧配置）全部 `completed`（其中 1 次 quota 是额度/限流，与 reasoning 无关）。

### 5.2 假设启用会怎样（代码推演，脚本 §4 实测，非真机派单）
| 情形 | 第一道 `resolveRoleChannel` | 第二道 `adapter.start` | 结果 |
|---|---|---|---|
| 角色带 `channelId:ch-codex-astra` 且声明 `reasoning:high` | **被跳过**（`capabilities.js:160-173` 要求双方都非空；实例 reasoning 缺失） | `instance.reasoning !== declaredReasoning` → 抛 `MODEL_UNSUPPORTED`（`adapter.js:1053-1058`） | **派单被拒** |
| 角色无 channelId，只声明 `kind:codex` + `reasoning:high` | 按 reasoning 收窄到 0 → `REASONING_UNSUPPORTED`（`:213-223`） | 不会到达（canStart 先失败） | 返回 `PROVIDER_UNAVAILABLE` |
| 角色只声明 `model`、不声明 `reasoning` | 不触发 | 不触发 | **派单正常通过** |

脚本 §4 实测输出：`resolveRoleChannel => OK (第一道校验被跳过：实例 reasoning 为空)`、`adapter.start 严格校验 => MODEL_UNSUPPORTED (拒绝派单)`。

→ **缺 reasoning 本身不导致派单失败；只有当角色显式声明 reasoning 时才失败。**

### 5.3 会用默认值吗？还是强度为空？——插件不设置，由 Codex CLI 自身默认值决定
- `buildChildAgentOptions` 对 `kind !== 'in-process'` 直接返回 `{}`（`adapter.js:370`），即 codex / ACP / claude-code 都**不传** `agentOptions.reasoningEffort`。ACP provider 甚至显式 `capabilities.agentOptions=false` 并「拒绝任何需要 agentOptions 的请求」（`@deepseek-ai/dsh-subagent-acp/lib/index.js:458,465`）——传给外部 CLI 反而会失败。
- ACP 通道的 `reasoning:high` 实际由 provider 行 `--effort high` 承载（§2.2）；codex 通道没有等价物。
- codex provider 的 Config schema（`@deepseek-ai/dsh-subagent-codex/lib/index.js:816-821`）为 `{ providerName, model(必填), env, permissionMode, disposeGraceMs }`，**根本没有 effort/reasoning 字段**；`thread/start` 载荷（`:212-217`）只发 `cwd` / `ephemeral` / `model` / 权限参数；`startCodexRun`（`:842-846`）也只透传 `model`。→ **思考强度由 Codex CLI 自身内置默认值决定，插件既不设置、也不校验、也不落盘**。
- 唯一稳定可观测副作用：`buildCliCapabilities` 对 `kind=codex` 得到 `efforts=[]` → `reasoningSupported:false`（`capabilities.js:89-90`），GUI 把 codex 标为「不支持思考强度」，用户无法为该 CLI 选档位。脚本 §3 实测：`codex models=["gpt-6-astra","gpt-6.1-sol"] efforts=[] reasoningSupported=false`（对比 `acp-cli efforts=["high"] reasoningSupported=true`）。

→ 正确答案是「**强度用 CLI 自身默认值，插件不设置**」，既不是派单失败，也不是插件填了某个默认值。

---

## 6. 未验证项（明确原因）

| 项 | 原因 | 建议动作 |
|---|---|---|
| 唐僧当前配置派单路由 | 09:34 UTC 配置切换后零 `role-tangtang` 记录；本会话未挂载 `meetingstone_dispatch`，无法发起新派单；按纪律不向队友发消息、不重复扣费 | 主控在有派单工具的会话补 1 次极小任务（「回复 OK，不调用工具」），读 `.meetingstone/runs/<childId>.json` 核对 `acp-kimi/kimi-k3.1-pro` |
| 八戒 effective model 运行时值 | run 记录只落 `channel.model`，in-process 的 `llmModel` / `agentOptions` 均不落盘 | 给 `buildRunBase` / `run-store` 增加 `effectiveModel` / `reasoningEffort` / `effectiveProvider` 落盘 |
| 全部角色 reasoningEffort 运行时值 | 114/114 条记录无该顶层键（§3.1） | 同上；或由 provider 行 `--effort` 静态核对并写入验收口径 |
| 外部 CLI 进程内真实 model 回读 | run 记录的 model 是配置派生，非进程实测 | 已由 provider 行 `--model` 静态闭环；如需硬证据需 CLI 侧自报 |
| Codex 通道启用后的实际行为 | 当前无角色引用；未实测派单，只有代码推演 + 脚本模拟 | 启用前先补一次极小派单验证 |
| `MODEL_UNSUPPORTED` 实跑 | 114 条记录中 2 处 `MODEL_UNSUPPORTED` 字样均在 `result` 正文（讨论该错误码），`error` 字段为 null、`status=completed`；无真实触发记录 | 若需验收拒绝路径，用一次性错配配置在隔离 profile 里跑（本次不改 profile，未执行） |

---

## 7. 结论：当前配置下的模型路由是否可信

1. **配置层（静态）——可信。** 5 个启用角色声明自洽，且与 provider 行逐项一致；两道 fail-closed 校验保证不一致必然拒绝；没有任何启用角色指向 codex 备用通道。
2. **防继承 / 防错扣——可信且有代码证据。** in-process 由 `agentOptions` 显式钉死（`adapter.js:367-381`、`:1121-1127`）；外部 CLI 由 provider 行 `--model` 固定、ACP provider 拒绝 agentOptions（acp/lib/index.js:465），子进程不用宿主 LLM。未发现「继承父会话路由」或「错扣额度」的路径。
3. **运行时（动态）——部分未闭环。** 4/5 角色有当前配置派单记录，悟空/沙僧/小白逐字一致；唐僧零记录 → 未验证；八戒 model 不入盘 → 未验证；reasoningEffort 全通道无运行时字段 → 未验证。
4. **P0 验收状态：partial。** 不能签「完全可信」，但没有发现任何实际路由错配或错扣证据。

**建议主控三步闭环：**
- (a) 补唐僧一次极小派单，落 childId，闭合第 5 个角色；
- (b) 给 run 记录增加 `effectiveModel` / `reasoningEffort` / `effectiveProvider` 落盘（in-process 写 `llmModel` / `workbuddy`），让 P0 三要素都可被运行时验收；
- (c) 明确 codex 备用通道的 reasoning 语义：注明「由 Codex CLI 默认值决定、插件不设置」，或从 `channels` 移除以免 GUI 显示「不支持思考强度」造成误解；同时把 `REASONING_UNSUPPORTED` 等加入 dispatcher 透传白名单便于排障。

---

## 8. 证据索引（file:line）

| 结论 | 证据 |
|---|---|
| 通道/角色声明 | `C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml:82-122`（channels）、`:124-209`（roles）、`:20-24`（agent-default-model）、`:32-77`、`:217-248`（subagent-acp 行）、`:49-61`（subagent-codex 行） |
| 项目自身静态复核（真实 profile 跑纯函数） | `.meetingstone/runs/2026-11-12-route-matrix-verify.mjs` + 同名 `.log` |
| 配置源优先级 | `src/index.js:92`、`:202-204`、`:335-336`；`src/session/config.js:748-750` |
| 两道一致性校验 | `src/roles/capabilities.js:134-239`（`:160-173`、`:213-223`）；`src/dsh/adapter.js:1028-1059` |
| 防继承 / agentOptions | `src/dsh/adapter.js:344-381`、`:1083-1088`、`:1101-1129` |
| run 记录字段（model 派生、无 reasoning） | `src/dsh/adapter.js:292-341`（`:302`）；`src/run-store.js:574-701` |
| 错误码透传 | `src/dispatch/dispatcher.js:43-87`、`:257-265`、`:708-721` |
| ACP provider 拒绝 agentOptions | `@deepseek-ai/dsh-subagent-acp/lib/index.js:442-450`、`:458`、`:465` |
| codex provider 无 effort 字段 | `@deepseek-ai/dsh-subagent-codex/lib/index.js:212-217`、`:816-821`、`:842-846` |
| GUI 显示 codex 不支持强度 | `src/roles/capabilities.js:51-93`（`:89-90`） |
| 动态证据 | `d:\MeetingStone\.meetingstone\runs\beaff738-…json`（本会话自身）、`124e339f-…json`、`e856ffa4-…json`、`d8aee0f4-…json` 等 114 条 |
| 派单工具不可用 | `ToolSearch('meetingstone_dispatch') → Not found (1)`；`WaitForMcpServers → ready:true` |
