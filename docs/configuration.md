# 配置参考

> 第一版没有 UI：配置写在 profile 的 `cordis.patch.yml`（全局）与项目根的 `.meetingstone.json`（项目级）。
> 改完**重启 DSH** 生效（全局配置在插件加载时读取；项目配置按调用读取，改完下一次工具调用即生效）。

## 1. 全局配置（profile 的 `cordis.patch.yml`）

```yaml
- id: meetingstone
  name: dsh-meetingstone
  config:
    channels: [...]      # 通道实例表（见 §2）
    roles: [...]         # 角色表（见 §3）
    defaultRoleId: role-sashi
    dispatchNotes: "常规实现优先沙僧；关键改动交悟空复核。"
    projectConfigFile: .meetingstone.json
    limits:
      serializeWrites: true              # isolation:none 时同项目串行（正确性保护，不是并发额度）
      maxParallelWritesTotal: 4          # 本插件派发的并行写任务全局上限（仅本插件，默认 4）
      defaultIsolation: worktree         # worktree | none
```

> ⚠️ patch 是**整值替换**：覆盖这一行时要把整个 `config` 写全，不是深合并。

### 1.1 并行与工作树隔离

`meetingstone_dispatch` 默认 `isolation:'worktree'`：每个任务在
`<projectRoot>/.meetingstone/worktrees/<operationId>` 的独立 git 工作树里执行，
分支为 `meetingstone/<operationId>`。详见 [工作树隔离](worktree-isolation.md)。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `limits.defaultIsolation` | `worktree` | `worktree`=每任务独立工作树；`none`=主工作区 |
| `limits.maxParallelWritesTotal` | `4` | 本插件派发的并行写任务全局上限（仅统计本插件任务）；超限立即返回 `WRITE_LIMIT_TOTAL`，**不排队** |
| `limits.serializeWrites` | `true` | 仅在 `isolation:none` 时生效：同项目串行。这是同一工作区的**正确性保护，不是并发额度** |

并发纪律（2026-11-11 用户决策后的新模型）：

- **宿主容量交给宿主**：宿主 `maxActiveSubagents` 默认 **8**，是**进程内共享池**——宿主自己的子 Agent 与本插件派单都计入。池满时宿主直接抛 `ACTIVATION_LIMIT_REACHED`，**没有等待/排队机制**；插件原样透传这个错误码，不重复实现容量控制，也不包成 `ADAPTER_FAILED`。
- **插件只保留全局额度**：`limits.maxParallelWritesTotal`（默认 4）只统计**本插件派发**的在跑任务，不按通道/项目拆分。额度在**首次异步操作前**（含建树）预占；超限**立即拒绝** `WRITE_LIMIT_TOTAL`，不排队，调用方稍后重试。
- `isolation:none` 与隔离任务**不得混跑**，同项目任一方向有活动任务就返回 `WRITE_CONFLICT`（正确性保护，不是额度）。
- 请求隔离但建树失败 / 服务缺失 → **拒绝派单**，绝不退回主工作区。
- 完成 / 失败 / 取消 / 卸载都**不删除**工作树与分支。
- **隔离是文件布局隔离，不是权限沙箱**（同账号、同文件系统、共享 git 元数据）。

## 2. `channels`（通道实例表）

一行 = 一个已配置好的 provider。**模型/强度写在这里**，因为宿主的子任务启动 spec 不接收这两个字段。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channelId` | string | ✅ | 实例 ID，角色通过 `channel.channelId` 引用 |
| `kind` | `in-process` \| `acp-cli` \| `codex` \| `claude-code` | | 通道类型 |
| `provider` | string | | provider 名（`spawn` / `acp` / `codex` / `claude-code`），省略时按 kind 推断 |
| `model` | string | | 该 provider 行实际使用的模型 |
| `reasoning` | string | | 该 provider 行实际的思考强度 |
| `description` | string | | 人类可读说明 |

**为什么要这层**（DD7 方案 B）：角色不能凭空指定模型。角色的声明必须与所引用实例一致，否则派单被拒（`MODEL_UNSUPPORTED`）——我们宁可报错，也不做"配置成功、执行没采用"。

> **本项目不提供只读通道**：宿主 subagent 启动 spec 没有权限字段，做不到绝对只读。因此这里没有 `permissionPreset`，角色上也没有；不要再实现（2026-11-11 用户决策）。

## 3. `roles`（角色表）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `roleId` | string | — | 稳定 ID，`^role-[a-z0-9][a-z0-9-]*$`，改名不变 |
| `name` | string | — | 显示名，同时参与解析 |
| `aliases` | string[] | `[]` | 别名；跨角色唯一（大小写/空白不敏感） |
| `description` | string | `''` | 职责说明 |
| `channel.kind` | 枚举 | `in-process` | 通道类型 |
| `channel.channelId` | string | | 引用通道实例 |
| `channel.model` / `channel.reasoning` | string | | 声明期望值，必须与实例一致 |
| `enabled` | boolean | `true` | 停用后不得派单 |
| `fallbackRoleId` | string | | 预留（第一版只提示，不自动接替） |
| `timeoutMs` | number | `1800000` | 单次派单超时 |

## 4. 项目级配置 `.meetingstone.json`

放在**项目根**（取 `exec.agent.session.header.cwd`）。

```json
{
  "version": 1,
  "defaultRoleId": "role-sashi",
  "roles": [{ "roleId": "role-scout", "name": "斥候", "channel": { "kind": "in-process" } }],
  "roleOverrides": { "role-sashi": { "description": "本项目里负责主力开发" } },
  "dispatchNotes": "只改 src/；动 docs/ 前先问。",
  "projectRules": ["未经确认不得修改数据库迁移文件"]
}
```

**合并规则**

1. 项目 > 全局（`roleOverrides` 按 roleId 打补丁；`roles` 里同 roleId 也是覆盖）。
2. `channel` 覆盖是**字段级合并**；但模型/强度仍要与实例一致。
3. 文件坏了（JSON 非法、版本不认识、字段类型错）→ **降级为空配置 + 把错误暴露在工具返回里**，绝不打断派单链路。

> 项目级配置**不提供 `limits`**：同项目串行开关 `serializeWrites` 只在插件全局配置（§1）里生效，项目文件里写 `limits` 会按未知字段忽略，不报错、不阻断派单。
> `permissionPreset` 已随只读通道移除；旧配置里写了也会被忽略，不报错、不阻断派单。

## 5. 解析与校验

| 场景 | 行为 |
| --- | --- |
| 名字/别名冲突 | 冲突 token 不参与解析；角色仍可用 `roleId`；`list_roles` 的 `errors` 里给 `ALIAS_CONFLICT` |
| 派单到歧义名字 | `ROLE_AMBIGUOUS`，提示里列出可选 roleId |
| 派单到停用角色 | `ROLE_DISABLED` |
| provider 未注册 | `PROVIDER_UNAVAILABLE`，附带原因 |
| 模型与实例不一致 | `MODEL_UNSUPPORTED`，给出双方取值 |
| `cwd` 越出项目根 | `PATH_OUTSIDE_PROJECT` |
| 拿不到项目根却指定 `cwd` | `PROJECT_ROOT_UNKNOWN` |
| 同项目已有任务（`isolation:none` + `serializeWrites`） | `WRITE_CONFLICT`（正确性保护，不是额度） |
| 同项目已有未隔离任务，或隔离任务遇到未隔离任务 | `WRITE_CONFLICT`（不得混跑） |
| 本插件并行写任务达全局上限 | `WRITE_LIMIT_TOTAL`（立即拒绝，不排队，稍后重试） |
| 宿主子 Agent 共享池已满（`maxActiveSubagents` 默认 8） | `ACTIVATION_LIMIT_REACHED`（原样透传，不排队，等现有任务结束） |
| 请求隔离但工作树服务缺失 | `WORKTREE_UNAVAILABLE` |
| 项目根不是 git 工作区 | `WORKTREE_NOT_GIT_REPOSITORY` |
| `base` 无法解析为 commit | `WORKTREE_BASE_INVALID` |
| 工作树路径已存在/已被 git 登记 | `WORKTREE_PATH_EXISTS` |
| `meetingstone/<operationId>` 分支已存在 | `WORKTREE_BRANCH_EXISTS` |
| 其他 git 失败 | `WORKTREE_GIT_FAILED` |
| git 命令超时（建树 30s / 计算改动 10s） | `WORKTREE_TIMEOUT` |
| 工作树实际路径逃出项目根 | `WORKTREE_PATH_OUTSIDE` |
| `isolation` 不是 `none`/`worktree` | `INVALID_ISOLATION` |
| 结构化 TaskSpec 缺关键字段（`title`；或声明了 `scope` 却没有 `acceptance`；或字段类型错误） | `TASKSPEC_INVALID`，`message` 说明缺什么，`fields` 列出字段名 |
| `meetingstone_get_run_artifact` 找不到记录 | `NOT_FOUND` |
| 记录文件不是合法 JSON | `CORRUPT` |
| `lineFrom/lineTo` 与 `headBytes/tailBytes` 同时使用、或范围非法 | `INVALID_RANGE` |
| 记录文件超过读取上限 | `TOO_LARGE` |
| 取消/卸载时宿主 `dispose()` 超时 | `ADAPTER_DISPOSE_TIMEOUT`：写终态（`stopConfirmed:false`）并**保留**并发槽位/隔离互斥，等 activation.result 落定后自动释放 |
| 取消/卸载时宿主 `dispose()` 抛错 | `ADAPTER_DISPOSE_FAILED`：写终态（`stopConfirmed:false`）并**保留**并发槽位/隔离互斥，等 activation.result 落定后自动释放 |
| 插件已卸载时仍有启动请求 | `ADAPTER_DISPOSED`：拒绝启动；启动中的 activation 在卸载后返回时先 dispose，确认停止才释放占位槽位。dispose 抛错/超时时**保留句柄与槽位**，写 `interrupted + stopConfirmed:false + error` 终态，等 result 落定后再释放；错误码原样透传，不归入 `ADAPTER_FAILED` |

## 6. 生命周期、runtimeId 与 interrupted

- 每次插件启动生成一个 `runtimeId`，写进每一条落盘记录（`.meetingstone/runs/<childId>.json`）。
- **取消顺序**：先 `abort` → `await activation.dispose()`（默认最多等 5 秒）→ **确认停止后**才释放并发槽位。
  dispose 超时或抛错时槽位与隔离互斥保留，先写 `cancelled + stopConfirmed:false` 终态；等
  `activation.result` 落定（可验证的停止证据）后**回填**：再写一条终态，把 `stopConfirmed` 改为 `true`、
  `diagnostic` 追加 `late settlement`，`status` 保持 `cancelled` 不被改写成 `completed`，这时才自动释放槽位。
  重复取消复用同一个收尾 promise。
- **落盘顺序**：同一 `childId` 的写入按 FIFO 串行，`running` 一定先于终态落地，终态不会被覆盖。
- **重启后的假 running**：读取时若 `status === 'running'` 且 `runtimeId` 不是当前进程的，投影为
  `status: 'interrupted'` + `interrupted: true`；只改返回值，不回写磁盘。
- **插件卸载**：对内存中仍存活的任务写 `interrupted` 终态（`stopReason: 'plugin-disposed'`），
  不会在磁盘留下假 `running`。每个句柄独立收尾：一个 `dispose` 阻塞不会拖住其他句柄的终态。
  `dispose` 未确认的任务保留槽位并记 `stopConfirmed:false`；等待期间 result 已落定的任务
  也照常写终态，并记 `stopConfirmed:true`。
  "启动中"（`startActivation` 尚未返回）的 activation 会被冻结；返回后确认 dispose 成功才释放
  占位槽位，绝不在卸载后登记为存活任务。
- **工作树记录**：终态记录包含 `worktree: { path, branch, baseSha, repositoryRoot, operationId }`、
  `changedFiles`、`changedFilesUnknown`、`changedFilesTruncated`、`changedFilesTotal`、`stopConfirmed`。
  `changedFiles` 最多写 5000 条（另有 2MB 字节预算），超出时 `changedFilesTruncated:true` 并保留总数。
  体积闸兜底时**同时**裁剪 `changedFiles` 与 `overlapWarnings`，避免写出自己读不回的记录。
  带 `worktree` 的记录**不参与** 100 条/30 天自动清理（保护未合并成果的元数据）；
  超大或无法解析的记录同样按 fail-safe **不删除**。工作树/分支本身一律不自动删除。
- **重叠预警**：`get_task` / `list_runs` 返回 `overlapWarnings: [{ childId, files }]`；
  终态写入时在**项目级异步互斥**内计算并回写：写当前记录后，把交集有界地回写到参与交集的
  历史记录，因此并发结束顺序任意，双方原始 JSON 都含交集。
  `overlapWarnings` 每对最多 50 个文件、整个字段最多 64KB（JSON 转义后），超限时写
  `overlapTruncated:true` / `overlapTotal:<原始文件总数>`。
  `changedFilesUnknown: true` 的记录不参与比较，但会在结果里标注未知。
- **失败上下文**：`WORKTREE_*` 失败结果保留 `path` / `branch` / `phase` / `residualPath`；
  带工作树的启动失败同样保留工作树路径与分支，便于人工定位残留。

## 7. 工具返回与任务契约（Token 优化，2026-11-11）

会话上下文是有限预算，以下默认值按审计结论收紧；需要完整内容时必须显式索取。

| 工具 | 默认返回 | 完整/详细模式 |
| --- | --- | --- |
| `meetingstone_get_task` | `status` / `stopReason` / `resultBytes` / `jobId` / `recordPath`；有结构化 `summary` 时只回 summary/resultStatus/openIssues/handoff（`resultOmitted:true`），否则回结果首 1KiB + 末 512B | `full:true` 返回完整 `result`；`output` 与 `result` 相同时只回一份（字段名统一为 `result`） |
| `meetingstone_get_run_artifact` | 完整结果文本（`.meetingstone/runs/<childId>.json` 的 `result`） | 用 `headBytes`/`tailBytes` 取首尾，或 `lineFrom`/`lineTo`（1 起、含端点）取行范围 |
| `meetingstone_dispatch` | 成功只回 `ok` / `taskRef`（`childId`、`name`、`provider`、`jobId`）/ `roleId` / `roleName` / `isolation` | 角色全量、prompt、工作树细节一律不回；需要时查 `meetingstone_list_runs` |
| `meetingstone_list_runs` | 记录索引：`title` / `status` / `resultStatus` / `summaryPreview` / `resultBytes` 等 | 需要正文用 `meetingstone_get_task` 或 `meetingstone_get_run_artifact` |
| `meetingstone_list_roles` | `roleId` / `name` / `aliases` / `enabled` / `availability` | `verbose:true` 追加 `description` / `channel` / `model` / `hasPrompt` / `source` |

- `meetingstone_get_task` 的 `recordPath` 指向 `.meetingstone/runs/<childId>.json`；`resultBytes` 是原始结果字节数（不是截断后长度）。
- 上下文重放上限从 64KiB 收紧到 **16KiB**（头 12KiB + 尾 4KiB）。带 `continuesFrom` 的派单会在落盘记录里写 `continuationBytes`（本次实际注入的重放块字节数）；没有重放则**省略该字段**。

### 7.1 TaskSpec（结构化任务简报，P0-B）

`meetingstone_dispatch` 仍接受**纯字符串** `role + task`（旧调用完全不受影响）。额外可选：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 短任务名；**使用任一结构化字段时必填**（Jobs / list_runs 展示） |
| `objective` | string | 要达成的结果；省略时任务正文即目标 |
| `scope` | `{ include: string[], exclude: string[] }` | 范围与边界 |
| `acceptance` | string[] | 验收标准；**声明了 scope 时必填** |
| `evidence` | string[] | 需要提交的证据 / 文件 / 测试 |
| `contextRefs` | string[] | 上下文包或文件引用 |
| `roleHint` | string | 建议角色/能力提示（不改变本次 `role` 路由） |
| `outputBudget` | `{ summaryTokens?: number, notes?: string }` | 摘要与产物预算；Provider 不支持硬上限时只作为指令 |
| `contextPack` | 见 §7.2 | 最小上下文 |

校验规则（**只有缺了就无法执行/验收才拒绝**，`TASKSPEC_INVALID`）：

- 结构化模式缺 `title` → 拒绝；
- 声明了 `scope`（include/exclude 非空）却没有 `acceptance` → 拒绝；
- 关键字段类型错误（如 `acceptance` 传字符串、`contextPack` 传数组）→ 拒绝；
- 简单查询只传 `task`，或只带 `title`，一律放行；不强制 `scope`/`evidence`。

### 7.2 ContextPack（最小必要上下文）

```json
{
  "knownFacts": ["已确认的技术结论/版本/配置"],
  "files": ["src/auth/callback.ts", "tests/auth/callback.test.ts"],
  "priorResults": [{ "summary": "正常路径已通过，取消路径未验证", "artifactRef": ".meetingstone/runs/<childId>.json" }],
  "doNotRepeat": ["不要重新扫描整个仓库", "不要重复测试正常完成路径"]
}
```

- TaskSpec + ContextPack 会渲染成**结构化文本块**，插在角色人设之后、任务正文之前；同时附带「不要重复探索 / 不要复述长文」约束。
- 不新增任何 AI 调用；不传 `taskSpec`/`contextPack` 时提示词与旧版一致（只多出固定的输出契约，见 §7.3）。
- 落盘记录里的 `taskSpec` / `contextPack` 是**截断后的摘要**（列表 ≤10 条、单条 ≤200 字符），用于 `list_runs` / `get_task` 展示标题。

### 7.3 结构化结果契约（P0-C）

派单提示词末尾固定包含输出契约，要求子 Agent 在回复最后给出 JSON：

```json
{
  "status": "completed | partial | blocked | failed",
  "summary": "结论摘要（约 300–500 token）",
  "evidence": [{ "file": "src/auth/callback.ts", "line": 84, "finding": "缺少租户归属校验" }],
  "artifacts": [".meetingstone/runs/task-123/review.md"],
  "changedFiles": [],
  "tests": ["静态检查完成；未运行集成测试"],
  "openIssues": ["需要确认旧租户兼容逻辑"],
  "nextAction": "交由沙僧修复后再由悟空复核"
}
```

解析规则（`src/result-contract.js`）：

- 支持整段 JSON、```json 代码块、文本中第一个平衡的 `{...}`；
- 提取不到（纯文本）→ `structuredResult:false`，`summary` = 原文；坏 JSON 同样退回原文；
- 子 Agent 自报的 `changedFiles` 落到 `reportedChangedFiles`，**不覆盖**记录里由 git 计算的 `changedFiles`（重叠检测依赖后者）；
- 记录新增：`summary`（≤8KiB，超出按首尾截断，带 `summaryBytes`/`summaryTruncated`）、`resultStatus`、`evidence`、`artifacts`、`resultTests`、`openIssues`、`nextAction`、`handoff`；
- 完整 `result` 仍然落盘（上限 256KiB），可用 `full:true` 或 `meetingstone_get_run_artifact` 取回。

`handoff` 字段（结论/证据/产物/未决/下一步）由解析结果生成，模板见 [handoff.md](handoff.md)。

### 7.4 按需读取完整结果

`meetingstone_get_run_artifact` 只读项目内 `.meetingstone/runs/<childId>.json`：

| 参数 | 说明 |
| --- | --- |
| `childId` | 必填，`meetingstone_dispatch` 返回的 `taskRef.childId` |
| `headBytes` / `tailBytes` | 取首尾字节窗口；两者不能与行参数同时使用 |
| `lineFrom` / `lineTo` | 1 起、含端点；省略 `lineTo` 读到末尾 |

返回 `content`（文本）、`bytes`（本次返回字节）、`resultBytes`（原始字节）、`truncated`、`range`、`recordPath`。

## 8. 宿主原生 Jobs（任务列表）

本插件不自造任务列表 UI。派单成功后，如果宿主提供 `ctx.jobs`，适配器会注册一个原生 Job：

- `kind`: `meetingstone-dispatch`
- `label`: `角色名 · 通道 · 任务摘要（≤40 字）`，例如 `悟空 · codex · 审核登录模块`
- `owner`: 本次派单的 parent Agent 对应 SessionId（宿主用 `agent.id === agent.session.id` 校验）
- `jobId`: 同时写入 `taskRef` 与 `.meetingstone/runs/<childId>.json`

行为边界：

- **Jobs 不可用时派单照常**：没有 `ctx.jobs`、或 `jobs.start` 抛错（例如当前 composition 没加载
  `@deepseek-ai/dsh-tool-jobs`，没有 controller 服务该 owner）时，只记一条 warning，不建 Job、不伪造 `jobId`。
- 任务终态（完成/失败/取消/插件卸载）会 resolve Job 的 `done`；`meetingstone_cancel_task` 优先走
  `ctx.jobs.kill()` → Job 的 `cancel`，再回落到适配器原路径，保证面板与工具停止的是同一个任务。
- 插件本身**不拥有** Jobs 面板；面板由宿主 `@deepseek-ai/dsh-tool-jobs` 提供。

## 9. 示例

- 全局五角色：[examples/meetingstone.desktop.yml](../examples/meetingstone.desktop.yml)
- 项目覆盖：[examples/project.meetingstone.json](../examples/project.meetingstone.json)
- 仓库自检角色：[examples/selftest.roles.json](../examples/selftest.roles.json)（`role-selftest*`，in-process / codex / acp 通道）
- 本仓库项目配置：根目录 `.meetingstone.json`（五角色 + 通道引用）
