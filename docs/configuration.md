# 配置参考

> 任务/结果的最小协议见 [task-protocol.md](./task-protocol.md)；高级字段均为可选增强。

> 第一版没有 UI：配置写在 profile 的 `cordis.patch.yml`（全局）、项目根的
> `.meetingstone.json`（项目级）与 `.meetingstone/sessions/<sessionId>.json`（会话级）。
> 改完**重启 DSH** 生效（全局配置在插件加载时读取；项目/会话配置按调用读取，改完下一次工具调用即生效）。

## 1. 全局配置（profile 的 `cordis.patch.yml`）

```yaml
- id: meetingstone
  name: dsh-meetingstone
  config:
    channels: [...]      # 通道实例表（见 §2）
    roles: [...]         # 角色表（见 §3）
    defaultRoleId: role-sashi
    routingRules: []     # 自动路由规则表（空 = 用内置表；见 §1.2）
    cliPreferences:      # 外部 CLI 显式偏好（见 §1.3；缺省 = unset）
      codex: true
      codebuddy: false
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

### 1.2 自动角色路由（实验能力，V1 默认不使用）

> 按 [V1-SCOPE.md](./V1-SCOPE.md)：V1 不做自动路由；本节保留为 `autoRoute:true` 实验开关。


`meetingstone_dispatch` 的 `role` 现在是**可选**的；但“不指定角色”必须显式开关：

| 调用方式 | 行为 |
| --- | --- |
| 传 `role`（旧用法） | **显式指定优先**，完全不走规则路由；回执 `routing:{roleId, auto:false}`，不写 reason |
| 不传 `role` + `autoRoute:true` | 按下面规则表选角色；回执 `routing:{roleId, reason, auto:true}`，reason 同时落盘 |
| 不传 `role` + 未开 `autoRoute` | 明确报 `ROLE_REQUIRED`，不会偷偷用 `defaultRoleId` |

内置规则表（`src/dispatch/routing.js` 的 `DEFAULT_ROUTING_RULES`）：

| 任务类型 | 判定关键词（示例） | 目标角色（按角色标识匹配） | reason 标签 |
| --- | --- | --- | --- |
| `architecture` | architecture / architect / 架构 / 决策 / 选型 / 技术方案 | roleId/name/aliases/description 含架构、决策、设计、lead、领导 | 评审/决策 |
| `review` | review / 审查 / 评审 / 复核 / 审核 / 审计 / 验收 | 含 review、reviewer、审查、评审、复核、审核、审计、验收 | 评审 |
| `research` | research / investigate / 调研 / 研究 / 调查 / 探索 / 分析 | 含 research、researcher、scout、调研、研究、调查、探索、分析 | 调研 |
| `edit` | edit / implement / fix / refactor / 实现 / 修复 / 修改 / 开发 / 重构 / 改 | 含 implement、developer、执行、实现、修复、开发、主力、骨干 | 执行 |

确定性规则：

1. **先看关键词首次出现的位置**：任务里 `修复 review 指出的问题` 归执行，`review 并修复` 归评审；同位置时按规则表顺序。
2. **只从 `enabled !== false` 且 `availability === 'available'` 的角色中选**。停用、provider 未安装、别名歧义的角色都不参与；可用角色为 0 → `AUTO_ROUTE_FAILED`。
3. **角色匹配顺序**：规则 `roleIds` 显式指定 → `roleId`/`name`/`aliases` 命中 → `description` 命中 → `prompt` 命中（弱信号兜底）→ 角色表顺序。整段 prompt 只用来找关键词，reason 也只会回显命中的关键词。
4. **兜底**：任务类型没有匹配到可用角色、或完全没命中关键词时，使用生效配置的 `defaultRoleId`（按“全局 → 项目 → 会话”继承）；默认角色本身不可用则 `AUTO_ROUTE_FAILED`。
5. **不改执行面**：路由只决定“用哪个角色”，provider/model/reasoning/权限继续由该角色的 `channel` 决定；不切更高成本模型、不提升权限、不调用任何 AI 分类器。

成功回执示例（自动路由）：

```json
{
  "ok": true,
  "taskRef": { "childId": "child-1", "provider": "acp" },
  "roleId": "role-wukong",
  "roleName": "悟空",
  "isolation": "worktree",
  "routing": {
    "roleId": "role-wukong",
    "reason": "任务含关键词「审查」→ 评审规则（review），选择「悟空」（role-wukong；角色描述含「审核」）",
    "auto": true
  }
}
```

手动指定角色时 `routing` 只有 `{ "roleId": "role-wukong", "auto": false }`（无 `reason`）。
`meetingstone_get_task` / `meetingstone_list_runs` 读到的落盘记录同样带 `routing`；手动派单的
旧记录没有该字段（不伪造）。

自定义规则表（可覆盖内置表；只来自插件全局配置，项目/会话层不支持）：

```yaml
routingRules:
  - taskType: docs
    label: 文档
    keywords: [文档, 手册, 校对]
    roleKeywords: [文档, writer, 文书]
  # - taskType: review
  #   keywords: [审查, review]
  #   roleIds: [role-wukong]   # 也可直接钉死角色 ID
```

> 自定义表是**整体替换**而非追加；非法条目（缺 `taskType` 或 `keywords`）会被跳过。
> 只配 `docs` 时，其它任务类型不再命中内置规则，只能走 `defaultRoleId` 或报错——这是有意为之，避免“配置了一半却偷偷用内置表”。

### 1.3 CLI 显式偏好（`cliPreferences`）与 preflight（P0-S2）

外部 CLI（`codex` / `codebuddy` / `claude`）的开关**只由用户显式偏好 + preflight 证据**决定，
不再把「探测到已安装」直接当成「已启用」。

```yaml
cliPreferences:
  codex: true        # 用户显式开启（仍要 preflight 通过才生效）
  codebuddy: false   # 用户显式关闭：持久化，重启/升级保持
  # claude 缺失 = unset
```

| 配置值 | 语义 | 生效条件 | 是否写盘 |
| --- | --- | --- | --- |
| 键缺失（`unset`） | 没有用户意图（**不是关闭**） | 首次 preflight `ready` 时视为启用 | 不写（避免把默认值钉进 profile） |
| `true`（`enabled`） | 用户显式开启 | preflight `ready`；否则保留「启用意图」但当前不生效 | 开启成功后才写 |
| `false`（`disabled`） | 用户显式关闭 | 永不在本次会话启用 | 立即写，重启/升级保持 |

规则（实现见 `src/cli/preferences.js`、`src/gui/config-api.js`）：

1. **显式关闭跨重启保持**：值写在 profile 的 `meetingstone` 行，插件重载/升级后仍读到 `false`。
2. **首次检测通过才自动启用**：`unset` + preflight `ready` → 派生为启用（`firstDetection`），但**不落盘**。
3. **开启前必须 preflight**：`false`/`unset` → `true` 的写操作先跑 preflight；`ready !== 'ready'` 时
   **不写任何配置**（保持关闭；不会把 `unset` 顺手写成 `false`），返回分类、人工步骤、`retryable`。
4. **运行故障不回写 disabled**：运行中失败/检查失败只影响派生显示，不修改 `cliPreferences`；
   已 `enabled` 的角色/CLI 继续保留「启用意图」（`userPreference` 不变）。
5. **未知状态不伪造**：拿不到宿主集成/登录证据时 `ready:'unknown'`、`blockedReason:'evidence-missing'`，
   不当作 `ready`，也不猜「需要登录」。
6. **不做自动修复**：不安装、不登录、不改 PATH、不改配置、不提权。`autoFix` 恒为 `false`，
   `manualSteps` 只给人工操作提示。

preflight 结果字段（`src/cli/preflight.js`）：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `installed` | boolean | 是否解析到可执行文件 |
| `version` | string \| null | `--version` 解析出的版本 |
| `ready` | `ready` / `blocked` / `unknown` | 是否允许开启 |
| `blockedReason` | 见下表 | `ready` 时为 `null` |
| `retryable` | boolean | 人工修复后能否重检；`unknown-cli` 为 `false` |
| `autoFix` | `false` | 恒为 false：本模块不做自动修复 |
| `manualSteps` | string[] | 人工步骤（不自动执行） |
| `login` | `true` / `false` / `unknown` | 登录证据；生产当前无可靠来源，缺省 `unknown` |
| `hostIntegration` | `true` / `false` / `unknown` | 宿主是否注册对应 provider |

失败分类（`blockedReason`）：

| 分类 | 触发证据 | 人工步骤（摘要） |
| --- | --- | --- |
| `not-installed` | 所有解析源都没有候选 | 安装 CLI 后重检；不改 PATH |
| `permission-denied` | `--version` stderr 含 Access denied/EACCES/EPERM，或 spawn 抛 EACCES/EPERM | 补读/执行权限后重检；不提权、不改 ACL |
| `path-invalid` | ENOENT / no such file / not found | 检查安装路径/升级变化；不改 PATH |
| `login-required` | `--version` 输出或注入的登录检查明确为未登录 | 在 CLI 内登录后重检；不代登录、不读凭据 |
| `host-integration-disabled` | 宿主 `ctx.subagents.getProvider` 对对应 provider 返回空 | 启用宿主 provider 后重载/重检；不改宿主配置 |
| `startup-failed` | 退出码非 0 且无更具体线索；版本输出无法解析 | 手动跑 `<cli> --version` 后重检；不自动修复 |
| `evidence-missing` | 宿主集成没有正向证据（`ready:'unknown'`） | 重检、确认 provider 已注册；不伪造 ready |
| `unknown-cli` | 不是 codex/codebuddy/claude | 只支持这三个外部 CLI；不可重检 |

> 登录/权限/额度**没有证据时一律 unknown**，不会用 429、refusal、`failureClass` 或
> 「安装成功」推断「已登录/ready」。凭据不读取、不落盘、不进日志。

相关 Host 侧 API（P0-S2 只做后端，UI 由 U1 接）：

| API | 作用 |
| --- | --- |
| `configApi.preflightCli(cli)` | 只检查、不写 |
| `configApi.listCliStates()` | 偏好 + preflight 派生状态（`enabled`/`ready`/`blockedReason`/`manualSteps`） |
| `configApi.setCliEnabled(cli, boolean)` | 开启前强制 preflight；失败不写；关闭立即写 |
| `configApi.setGlobalRoleEnabled(roleId, boolean)` | 写全局角色 `enabled`（profile，保留未知字段） |
| `configApi.updateProjectConfig(projectRoot, patch)` | 写项目配置白名单字段（保留未知字段） |

**全局写实现**：`src/config/global-writer.js` 经官方 `ctx.get('configEditor').edit(ctx.fiber.entry, change)`
写入（API 证据见 [audit/07 §3.4](./audit/07-config-extension.md)）。`change(current)` 的 `current`
是当前 raw config；本模块以它为底合并，**整值替换时不丢未知字段**。高层覆盖 / entry 失效会返回
`GLOBAL_CONFIG_OVERRIDDEN` / `GLOBAL_CONFIG_ENTRY_STALE` / `GLOBAL_CONFIG_ENTRY_INACTIVE`，不静默。

**项目写实现**：`src/project/write.js` 只允许顶层 `defaultRoleId` / `dispatchNotes` / `projectRules` /
`roles` / `roleOverrides`，角色/通道字段复用会话层白名单；文件里的未知顶层键、角色/覆盖对象里的
未知键原样保留。坏 JSON / 非对象**拒绝覆盖**（`PROJECT_WRITE_INVALID_JSON` / `PROJECT_WRITE_NOT_OBJECT`）。

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

### 4.1 三层继承（global → project → session）

生效配置按 **全局 → 项目 → 会话** 合并，后者覆盖前者；只影响各自的作用域：

| 层 | 位置 | 作用域 |
| --- | --- | --- |
| global | profile `cordis.patch.yml` 的 `meetingstone` 行 | 所有项目/会话 |
| project | `<项目根>/.meetingstone.json` | 当前项目 |
| session | `<项目根>/.meetingstone/sessions/<sessionId>.json` | **仅当前对话**（`exec.agent.session.id`） |

合并规则（`src/session/config.js` 的 `resolveEffectiveConfig`）：

1. 同 `roleId` 按字段覆盖；`channel` 也是字段级合并（只写 `model` 不会把 `kind` / `provider` 抹掉）。
2. `aliases` 是**整体替换**，不是追加；`alias` 是单值/数组的简写。
3. **只保存差异**：会话值与继承值相同 → 该键不落盘；把一个字段改回继承值 → 删除旧覆盖（恢复继承）。
4. 未知字段**拒绝并报错**（顶层、角色、`channel` 三层都按白名单校验），不会静默生效。
5. 会话层只改配置，不改变项目隔离：不同 `sessionId` 用不同文件，互不影响。
6. `resolveEffectiveConfig({ global, project, session })` 返回 `{ effective, sources, errors }`；
   `sources.roles[roleId]` 给出 `layer` 与逐字段来源（`global` / `project` / `session` / `default`），
   `sources.defaultRoleId` / `sources.dispatchNotes` / `sources.projectRules` 同样标注，供 UI 显示"继承/覆盖"。
7. 别名冲突不在这里判定：调用方在**最终生效角色表**上建注册表
   （`createRegistry({ globalRoles: effective.roles })`），冲突由注册表的 `errors` 统一报告。

会话覆盖文件示例（`.meetingstone/sessions/<sessionId>.json`，`.meetingstone/` 已在 `.gitignore`）：

```json
{
  "version": 1,
  "roleOverrides": {
    "role-sashi": {
      "alias": ["SSS"],
      "description": "本对话里负责实现",
      "prompt": "本对话的额外规则",
      "channel": { "cli": "acp", "model": "m-2", "reasoning": "high" }
    }
  },
  "roles": [{ "roleId": "role-temp", "name": "临时", "channel": { "kind": "in-process" } }],
  "defaultRoleId": "role-sashi",
  "dispatchNotes": "本对话优先短回复",
  "projectRules": ["本对话只改 src/"]
}
```

字段白名单：

| 层 | 允许字段 |
| --- | --- |
| 顶层 | `version` / `roles` / `roleOverrides` / `defaultRoleId` / `dispatchNotes` / `projectRules` |
| 角色 | `roleId` / `name` / `alias`（或 `aliases`）/ `description` / `prompt` / `channel` / `enabled` / `fallbackRoleId` / `timeoutMs` |
| 通道 | `kind` / `channelId` / `provider` / `cli` / `model` / `reasoning` |

新增/改字段的宿主侧 API（`src/session/store.js` + `src/gui/session.js`，无 UI）：

- `store.setOverride(projectRoot, sessionId, { roleId, patch, inherited })`：只写差异；
  等于继承值的字段会从旧覆盖里删除。
- `store.clearOverride(projectRoot, sessionId, { roleId, field })`：`field` 省略 = 恢复整个角色；
  支持 `channel.model`，也接受 `model` / `reasoning` 等通道简写。
- `store.get(projectRoot, sessionId)`：永不抛异常；文件不存在 → 空配置，坏 JSON / 版本不认识 →
  空配置 + `SESSION_CONFIG_INVALID_JSON` / `SESSION_CONFIG_UNSUPPORTED_VERSION`。

GUI Host 方法（strict Remote 的三个方法，P0-S0/S2）：

- 返回值统一补 `scope`（`field` / `role`）、`idempotent`（未真正落盘）与 `code`
  （首个错误码；写被拒绝时优先 `SESSION_CONFIG_CORRUPT`）。
- `clearSessionOverride(sessionId, roleId)` 省略 `field` 与显式传 `null`/`undefined` 等价：
  **清整个角色覆盖**。Host 侧显式传 `{ roleId, field: undefined }`，不依赖「键缺失」的隐式语义。
- 非法 sessionId / roleId / field 仍**同步抛**带 `code` 的错误（由 Remote 层转 `RemoteError`）；
  坏会话文件返回 `ok:false` + `SESSION_CONFIG_CORRUPT`，**不覆盖**用户手写内容。
- 重复设置同值 / 重复恢复 → `written:false`、`idempotent:true`；`getSessionConfig` 新增
  `warnings`（读取层非致命告警），不改变 `effective` 的降级语义。

> **为什么不用宿主的 session 级存储**（2026-11-11 查 0.2.2-rc.1 实际包）：
> `@deepseek-ai/dsh-session` 的 `SessionHeader` 是创建时深冻结的元数据（仅 `cwd` 等），
> 没有插件可写的 per-session KV；会话日志是事件溯源，`appendPluginRecord()` 明确只允许
> 仓库内 experimental 包调用。`@deepseek-ai/dsh-storage-domain` 需要 `defineDomain` + zod，
> 本插件是零依赖的，且该服务不是所有 composition 都挂载。故退化为项目内文件。
>
> 局限：文件不随宿主会话归档/删除而清理；换项目路径后看不到旧覆盖；多进程同时写同一
> session 文件没有跨进程锁（最后写入者胜出）。

## 5. 解析与校验

| 场景 | 行为 |
| --- | --- |
| 未指定 `role` 且未开 `autoRoute`（或 `role` 不是字符串） | `ROLE_REQUIRED`（不会隐式使用 `defaultRoleId`） |
| 开了 `autoRoute` 但没有 `enabled + available` 的角色；或任务类型无匹配角色且 `defaultRoleId` 未配置/不可用 | `AUTO_ROUTE_FAILED`，`message` 说明失败在“无可用角色”还是“无匹配角色/兜底” |
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
| 会话写 API：非法 sessionId / roleId / 字段白名单 | `SESSION_GUI_INVALID_SESSION_ID` / `SESSION_GUI_INVALID_ROLE_ID` / `SESSION_GUI_INVALID_FIELD` |
| 会话写 API：找不到会话项目根 | `SESSION_GUI_SESSION_ROOT_UNKNOWN` |
| 会话写 API：坏会话文件拒绝改写 | `SESSION_CONFIG_CORRUPT`（写被拒；文件保持原样） |
| CLI 偏好：未知 CLI / 非布尔开关 | `CLI_PREFERENCE_INVALID_CLI` / `CLI_PREFERENCE_INVALID_STATE` |
| CLI 偏好：开启前 preflight 未通过（未写配置） | `CLI_PREFERENCE_PREFLIGHT_FAILED`（附 `manualSteps` / `retryable` / `autoFix:false`） |
| CLI 偏好：写 profile 失败 | `CLI_PREFERENCE_WRITE_FAILED`（`cause` 为底层码） |
| 全局写：宿主无 configEditor / entry 不可用 | `GLOBAL_CONFIG_EDITOR_UNAVAILABLE` / `GLOBAL_CONFIG_ENTRY_UNAVAILABLE` |
| 全局写：非法 CLI / 偏好 / roleId / 角色补丁 | `GLOBAL_CONFIG_INVALID_CLI` / `GLOBAL_CONFIG_INVALID_PREFERENCE` / `GLOBAL_CONFIG_INVALID_ROLE_ID` / `GLOBAL_CONFIG_INVALID_ROLE_PATCH` |
| 全局写：角色不存在 | `GLOBAL_CONFIG_ROLE_NOT_FOUND` |
| 全局写：被 home patch/命令行覆盖、entry 失效、插件不活跃 | `GLOBAL_CONFIG_OVERRIDDEN` / `GLOBAL_CONFIG_ENTRY_STALE` / `GLOBAL_CONFIG_ENTRY_INACTIVE` |
| 全局写：其他写入失败 | `GLOBAL_CONFIG_WRITE_FAILED` |
| 项目写：项目根未知 / 读取失败 / 坏 JSON / 非对象 | `PROJECT_WRITE_PATH_UNKNOWN` / `PROJECT_WRITE_READ_FAILED` / `PROJECT_WRITE_INVALID_JSON` / `PROJECT_WRITE_NOT_OBJECT` |
| 项目写：非白名单字段 / 非法值 / 写盘失败 | `PROJECT_WRITE_UNKNOWN_FIELD` / `PROJECT_WRITE_INVALID_VALUE` / `PROJECT_WRITE_WRITE_FAILED` |
| `meetingstone_wait` 的 `childIds` 不是非空字符串数组 | `INVALID_CHILD_IDS` |
| `meetingstone_wait` 的 `timeoutMs` 不是正数 | `INVALID_TIMEOUT` |
| `meetingstone_wait` 的 childId 在本进程查不到（含 DSH 重启前的任务） | `UNKNOWN_CHILD`：立即返回，不阻塞，`unknownChildIds` 列出 |
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
| `meetingstone_dispatch` | 成功只回 `ok` / `taskRef`（`childId`、`name`、`provider`、`jobId`）/ `roleId` / `roleName` / `isolation` / `routing`（`roleId` + 自动路由时的 `reason`） | 角色全量、prompt、工作树细节一律不回；需要时查 `meetingstone_list_runs` |
| `meetingstone_list_runs` | 记录索引：`title` / `status` / `resultStatus` / `summaryPreview` / `resultBytes` 等 | 需要正文用 `meetingstone_get_task` 或 `meetingstone_get_run_artifact` |
| `meetingstone_list_roles` | `roleId` / `name` / `aliases` / `enabled` / `availability` | `verbose:true` 追加 `description` / `channel` / `model` / `hasPrompt` / `source` |
| `meetingstone_wait` | 每个任务的 `childId` / `status` / `stopReason` / `resultBytes` / `summary?` / `timedOut` | 超时未完成的任务标 `status:'running'`、`timedOut:true`；未知 `childId` 立即返回 `UNKNOWN_CHILD` |

- `meetingstone_wait` 用于**收口**（一次等一组任务全部到达终态），不要高频调用、不要拿它轮询：默认最多等 300000ms、上限 600000ms；已完成的立即返回，未完成的只等宿主结算通知（不忙等）；同一任务被多次 wait 复用同一监听。只认本进程内存记录，DSH 重启前的任务视为未知。

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

### 7.5 进行中重复任务去重（P0-D）

`meetingstone_dispatch` 只对**完全相同、且仍在进行中**（`queued` / `running`）的任务去重：
命中时返回**既有**任务的 `taskRef`（原 `childId` / `jobId`）与当前状态，回执在 §7 成功回执
基础上附 `deduplicated: true`、`status`、可选 `deduplicatedFrom`；**不**创建第二个子任务、不占
新额度、不建新工作树。依据 `docs/reference/efficiency-v1.0.md` §3.5 / §5 表 8 / §8。

#### 指纹组成（必须确认「完全相同」，绝不仅 hash Prompt）

判定用 `src/dispatch/dispatcher.js` 的 `fingerprintParts` / `computeFingerprint`：对规范化对象做
稳定序列化（键排序）后取 sha256。参与判定的信息：

| 组成 | 字段 | 变化后 |
| --- | --- | --- |
| 项目 / 工作区身份 | realpath 归一化后的 `projectKey` | 不同项目不合并 |
| 角色 ID 与 provider / CLI | `roleId`、`channel.kind/provider/channelId/model/reasoning`、`prompt/description/timeoutMs` | 执行能力不同不合并 |
| 规范化任务内容 | `task.trim()`；有 TaskSpec 时用结构化字段（title/objective/scope/acceptance/evidence/contextRefs/outputBudget/permissionPreset），含 ContextPack | 目标或范围不同不合并 |
| 版本指纹 | `git rev-parse HEAD`（worktree 隔离下等同 `baseSha`） | 代码变化后允许重新执行 |
| 状态 | 固定状态桶 `in-progress`；索引只存进行中条目 | 终态即移出索引 |
| 关键参数 | `isolation`、权限档位、输出预算、`continuesFrom` 重放 | 执行条件不同不合并 |

命中时的回执示例：

```json
{
  "ok": true,
  "taskRef": { "childId": "child-1", "jobId": "job-1", "provider": "acp" },
  "roleId": "role-sashi",
  "roleName": "沙僧",
  "isolation": "worktree",
  "deduplicated": true,
  "status": "running",
  "deduplicatedFrom": "child-1"
}
```

#### 误判边界（宁可重复也不误合）

- **只对进行中任务去重**：任务终态（`onFinish` / `cancel` 确认停止 / 启动失败）即从内存索引
  移除；**不复用已完成 / 失败 / 取消任务的旧结果**。完成后再次派相同任务会正常创建新任务。
- **版本指纹取不到标 `unknown` 且不参与判定**：非 git 项目、无项目根、`git` 不在 PATH 或超时
  时，该请求既不进索引也不命中索引，一律正常创建（不因无法确认版本而误合）。
- **信息不足以证明完全相同**：任何参与字段缺失或无法确认时按「不相同」处理，创建新任务。
- **索引仅内存**：`Map`，插件 / DSH 重启即失效；不建库、不落盘、不跨进程共享。
- **并发安全**：相同请求同时到达时**先占位再启动**——占额度与写去重索引在同一同步块内完成，
  第二个请求命中占位后等待首个任务拿到 `taskRef`（受控 pending promise），只创建一个任务。
- **权限 / 模型 / 隔离档位差异都参与指纹**：本项目不提供逐任务权限档位，但 `isolation` 与
  `channel` 配置不同一律不合并；去重不会擅自提升权限、切换模型或改隔离方式。
- **不做**：不复用过期结果、不建任务队列 / 数据库 / 全量任务历史、不对「疑似相同」做模糊
  合并（不做语义相似度、不调用额外 AI 判定）。

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
