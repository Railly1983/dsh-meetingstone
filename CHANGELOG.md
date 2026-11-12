# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [SemVer](https://semver.org/)。

## [0.1.0-alpha.9] - 2026-11-12

### Fixed

- **`spawn_teammate_as` 在 alpha.8 里实际没注册上**（工具列表里查无此名）。根因：
  工具的注册 scope 用错了 —— 挂到了插件的 ctx 上。
  宿主 `@deepseek-ai/dsh-experimental-tool-agent-team` 的 `install()` 实现是
  `const scoped = agent.ctx; scoped.tools.register(...)`，也就是**必须挂到具体 Agent
  的 scope**，挂插件 ctx 只有插件自己可见、模型看不到。
  alpha.9 改为跟随宿主同样的模式：
  - `ctx.on('agent/created')` + `ctx.agents.list()`，对每个 agent 判断 `tryMembership(agent).role`，
    只给 **Lead** 装（teammate 自己不是 Lead，装了没意义还可能重复）
  - `registerTeamRoleTool(agent.ctx, ...)`
- 拿服务改为 `readService(ctx, name)`：先试 `ctx[name]`、再试 `ctx.get(name)`，
  两者都被注入守卫拒绝时返回 undefined 并**静默降级**（未启用 Agent Teams 的 profile
  不该因此启动失败），但注册结果与失败原因**写进日志**，不再静默吞掉。

### 测试

- 589 → 590 tests（+1），并补两条反证测试：
  - 不得把 `ctx.agentTeams` 当主路径（只能作为一次兜底）
  - 注册目标必须是 `agent.ctx`，且必须用 `tryMembership` 过滤 Lead

## [0.1.0-alpha.8] - 2026-11-12

### Added

- **`spawn_teammate_as` 工具**：按角色创建 Agent Teams teammate，并把它钉在
  该角色配置的模型上，而不是继承当前会话的模型。
  - `role` 收中文角色名（如「沙僧」）或拼音（`shaseng`），内部映射成
    lower-kebab-case 成员名（宿主 `MEMBER_NAME` 正则硬编码，面板仍显示拼音）。
  - 路由取角色绑定的 in-process 通道 `llmProvider`/`llmModel`/`reasoning`，
    与派单路径 `buildChildAgentOptions` 同源。
  - 建完成员立刻调 `agent.model.select()`，首轮请求即生效，不浪费一轮继承模型的调用。
  - **只新增、不接管**官方 `spawn_teammate`：同 scope 同名注册会被 `dsh-tools` 拒绝，
    且官方工具原样保留可避免行为差异。

### Fixed

- 修正了「teammate 无法指定模型」这一能力缺口。底层早已支持
  （`dsh-subagent-spawn-in-process` 的 `capabilities.agentOptions = true`），
  只是内置工具层没有透传 `agentOptions`。

### 已知限制

- **不能挂 `agent/request` 覆写路由**：`dsh-agent-loop` 的 `prepareRequest()` 有硬断言，
  改了直接抛 `use agent.model.select() before step preparation`。已加反证测试锁住。
- 成员名仍只能用拼音，不能改名、不能删除（宿主无 `removeMember`，名字 once-used 永不回收）。
- 角色若绑定外部 CLI 通道（codebuddy/codex/claude），本工具会拒绝 ——
  teammate 跑在宿主进程内，不能挂外部 CLI 子进程。

### 测试

- 551 → 589 tests（+38），无删测。

## [0.1.0-alpha.7] - 2026-11-12

### Fixed
- **dsh（DeepSeek Harness）的模型永远为空、「刷新能力」必失败**（D1 阻塞缺陷 1）。
  两个叠加成因：
  - `refreshCli` / `setCliEnabled` 的 `cli` 枚举只有 3 个外部 CLI，
    而 B2b 已把 CLI 扩到 4 个（多了 `dsh`）→ 网关侧直接拒绝。
    且仅加枚举不够：业务层 `isKnownCli()` 用 `CLI_NAMES` 会二次拦截。
    现 dsh 跳过 preflight（宿主内置 in-process 通道没有外部可执行文件，
    “检测”本身不成立），只刷能力目录；外部 CLI 仍走 preflight + 能力刷新。
  - 能力目录完全不读插件 channels，只读 provider 行 `--model`；
    而 in-process 通道的模型声明在 `channel.llmModel` 里（不在 args）。
    而派单侧 `adapter.js` 认的正是 `llmModel` → 目录与派单两套读法不一致。
    新增 `channelsToCatalog()`（与派单侧同源）与 `mergeCatalogs()`，
    channels 优先、provider 行补充。
- **5 处文案仍教用户去已被删除的右侧栏「本对话角色」**（D1 阻塞缺陷 2）。
  最严重一条在角色管理面板顶部常驻，用户照做找不到对应面板。
  根因：`globalRolesNote` 未随 B3 清理；`renderRoleDetail` 的 `scopeGlobal*`
  提示块在 `showScope:false` 时仍无条件渲染。现提示块服从 `showScope`。
- 清理 16 个会话/右侧栏概念的死翻译键（zh/en 各一套共 32 行），
  字典 164 → 148 键，两语言仍逐键对称。

### Changed
- 契约护栏加强：原先只比较两侧 `typeSymbol`，**枚举取值漂移测不出来** ——
  这正是本次缺陷逃逸的原因。现增加取值一致性断言。

### Removed
- 会话覆盖的契约残留：`SESSION_REMOTE_TYPES` 的 4 个会话专用键与 6 个只服务
  它们的局部函数（两侧同步删除）。remote descriptor 仍为 5 个配置方法。
- `src/session/config.js` 的 4 个死导出（`diffRoleOverride` / `mergeRolePatch` /
  `isEmptyPatch` / `removePatchField`）与同源死代码 `normalizeFieldPath`，
  唯一消费方是已随 B3 删除的 `src/session/store.js`。
  **注意该文件本身不可删** —— 它有 4 个生产调用方。

### 测试
- 541 → 551 tests（+10），无删除任何测试用例。
- 每条新测试都验证过修复前会红（stash 掉修复后 4 failing / 3 failing）。

## [0.1.0-alpha.6] - 2026-11-12

### Changed
- **去掉会话级角色配置**（用户决定：只有全局角色设定）。会话级覆盖的读写路径、
  右侧栏「本对话角色」面板、对话页头角色入口全部移除，仅保留设置页内联的全局角色管理。
  旧 `.meetingstone/sessions/*.json` 不再读取，文件保留不迁移不清除。
- 角色配置收敛为**全局单层**：项目级 `.meetingstone.json` 的 roleOverrides 不再生效。
- 能力目录新增 `config` 数据源：只读解析 profile 的 `cordis.patch.yml` provider 行，
  读取真实 `--model` / `--effort`；优先级 discovered > config > static > unknown。

### Added
- 设置页角色区返回按钮。

### Fixed
- **P0 计费事故**：派单静默继承父会话模型路由，导致角色配置的 CLI 完全不生效、
  实际按父会话的按量计费 provider 扣费。现在 in-process 派单显式下发 `agentOptions`
  （provider/model/reasoningEffort），外部 CLI 通道不传。
  安装后实测：43 次调用全部走 workbuddy，deepseek-account 零调用。

## [0.1.0-alpha] - 2026-11-11

V1 范围冻结（docs/V1-SCOPE.md）：四个工作包 + 不做清单。

### Added
- 四 CLI 接入：Codex / CodeBuddy(ACP) / Claude Code / in-process
- 角色派单：按名称与简称，显式优先；未指定报 `ROLE_REQUIRED`
- 原生 Jobs 集成：任务名称、状态、耗时、停止
- `meetingstone_wait`：一次等待多个任务，不轮询
- 只读 GUI：设置页三区、对话顶部入口、右侧栏会话角色编辑
- 三级配置继承：全局 → 项目 → 当前对话，只存差异、可恢复
- 统一任务/结果协议；基础重复派单保护；基础失败分类

### Changed
- `get_task` 默认摘要、`dispatch` 紧凑回执、`list_roles` 默认紧凑
- 上下文重放上限 16 KiB
- 模型由角色定义决定，设置页不再展示默认模型/通道模型

### Added (U2/U3)
- 设置页最终两区：外部 CLI 开关（原生风格）+ 默认角色配置
- 角色列表三色二态：灰=关闭/阻断、黄=额度耗尽、绿=正常/未知
- 角色二级详情可编辑（名称/简称/描述/通道/模型/思考强度/prompt），逐字段来源与恢复继承

### Fixed
- 设置页与对话顶部集合石入口不显示：slot 注册不再阻塞在 `ctx.inject(['remote.meetingstone'])` 回调里，改为立即注册 + `ctx.get()` 惰性取服务
- 右侧栏无法打开：改用 `ctx.sidebarRight.openTab(kind, { params })`，keyed seat 使用 `key`
- 会话角色面板改为**只读**：手写 Typert 带参远程无法满足宿主 strict codec（zod 类型符号），编辑能力待生成式 Remote 支持

### Known limitations
- 自动路由、效率账本为实验/开发工具，不属于 V1 卖点
- Subagents 面板 Token 为累计值（含 fork 继承），不可用于成本/额度
- WorkBuddy 与 Codex 跨宿主 POC 暂缓

## [0.0.4] - 2026-11-10

### Added
- **派单结果落盘**：`.meetingstone/runs/<childId>.json`，原子写、结果 256 KiB 上限、错误 16 KiB、保留 100 条/30 天；
  `get_task` 内存优先、磁盘兜底（DSH 重启后仍可查终态）；写盘失败只附 `persistenceWarning`，不篡改真实结果
- **上下文重放**：`dispatch` 新增 `continuesFrom`，把上次结果作为不可信上下文重放（64 KiB，头 48K + 尾 16K）；
  找不到结果直接失败（`CONTINUATION_NOT_FOUND`），不静默降级
- `list_roles` 返回 `description` / `hasPrompt` / `channelId` / `model`，配置可自证

### Changed
- 版本 0.0.4；测试 173 项
- Codex provider 可换新版二进制（运维步骤见 docs/installation.md），0.167 下支持 gpt-6.1-sol 等 4 个模型

## [Unreleased]

### Fixed
- 并行多任务经悟空三轮独立复核，修复：停止未确认仍释放槽位、启动中卸载漏追踪、同目录别名绕过同项目判定、
  超大记录失去淘汰保护、并发 overlap 未落盘、overlap 撑爆记录、错误上下文未贯通、两个可假通过的弱断言
- 已知限制见 docs/worktree-isolation.md「已知限制」

### Added
- **P0-D 进行中重复任务去重**：`dispatch` 按指纹（项目 / 角色 ID / provider / 规范化任务内容 /
  含 TaskSpec 结构化字段 / `git rev-parse HEAD` 版本 / 状态桶 / isolation 等关键参数）只对进行中
  任务去重；命中返回既有 `taskRef` + `deduplicated:true` + 当前状态，不创建第二个子任务、不占额度、
  不建工作树。版本取不到或信息不足时正常新建（宁可重复也不误合）；索引仅内存、终态清理、
  并发「先占位再启动」用受控 pending promise 保证只创建一个。规则与误判边界见
  [配置参考 §7.5](configuration.md)；新增 `tests/dedup.test.mjs`（16 项）
- **并行多任务（任务级工作树隔离）**（2026-11-11 悟空裁决，路 2）：
  - 新增 `src/worktree.js`：自建 `git worktree`（literal argv、清 `GIT_*`、`GIT_TERMINAL_PROMPT=0`、
    30s 超时、输出上限、按 git common-dir 进程内互斥）；路径
    `.meetingstone/worktrees/<operationId>`、分支 `meetingstone/<operationId>`
  - `meetingstone_dispatch` 新增 `isolation: 'none' | 'worktree'`，默认 `worktree`
  - 并发额度（2026-11-11 修订）：宿主 `maxActiveSubagents` 默认 **8**，进程内共享池
    （宿主子 Agent + 本插件都算），池满直接抛 `ACTIVATION_LIMIT_REACHED`，**无等待/队列**；
    本插件只保留**全局** `maxParallelWritesTotal`（默认 4，仅统计本插件任务），
    在首次异步操作前预占，超限**立即拒绝** `WRITE_LIMIT_TOTAL`，不排队
  - `ACTIVATION_LIMIT_REACHED` 原样透传（不归入 `ADAPTER_FAILED`）；删除
    `maxParallelWritesPerProject` / `WRITE_LIMIT_PROJECT` 按项目额度模型
  - 同项目"隔离/未隔离互斥"与 `serializeWrites` 保留为**正确性保护，不是并发额度**
  - 失败关闭：建树失败/服务缺失 → 拒绝派单，绝不退回主工作区；`isolation:none` 与隔离任务不得混跑
  - 工作树/分支**一律不自动删除**（完成/失败/取消/卸载都不删）
  - 记录新增 `worktree` / `changedFiles` / `changedFilesUnknown` / `operationId` / `stopConfirmed`；
    `list_runs` 不再丢 `worktree` 字段
  - `get_task` / `list_runs` 返回 `overlapWarnings`（同项目改动文件交集）；`changedFilesUnknown`
    的记录不参与比较但标注未知
  - 淘汰保护：带 `worktree` 的记录不参与 100 条/30 天清理
  - 新增测试 `tests/worktree.test.mjs`（真实 git 建树/冲突/超时/computeChangedFiles）与
    `tests/parallel.test.mjs`（额度、跨项目、失败关闭、取消/卸载、重叠、淘汰）
- 新错误码 `WORKTREE_*` / `WRITE_LIMIT_TOTAL` / `INVALID_ISOLATION`（见 `docs/configuration.md` §5）；
  宿主 `ACTIVATION_LIMIT_REACHED` 原样透传
- `docs/plan/2026-11-11-parallel-plan.md` 写入悟空裁决；`docs/worktree-isolation.md` 改为
  「自动隔离 + 手动流程并列」，明确**文件布局隔离 ≠ 权限沙箱**
- **生命周期正确性（P0）**：取消改为「先 `dispose()`（默认 5s 超时兜底）再释放槽位」；
  落盘按 `childId` 串行（running 一定先于终态）；新增 `runtimeId`，重启后把旧 `running`
  投影为 `interrupted`；插件卸载时为存活任务写 `interrupted` 终态
- 新错误码 `ADAPTER_DISPOSE_TIMEOUT` / `ADAPTER_DISPOSE_FAILED`（见 `docs/configuration.md` §5）
- 角色注册表：别名解析、冲突降级（标记 `ambiguous` 而非整表失败）
- 项目级配置 `.meetingstone.json`：mtime 缓存、坏文件降级、与全局配置合并
- 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录），带版本试跑与缓存
- 派单编排：同项目任务串行（`serializeWrites`）、工作树隔离、失败回滚、`onFinish` 幂等释放
- DSH 接线层：`ctx.subagents` 适配器 + 八个工具（`meetingstone_list_roles` / `_dispatch` / `_list_runs` / `_get_task` / `_cancel_task` / `_cli_status`）
- 通道实例表 `channels`：模型/强度由 provider 行承载，角色声明必须一致（DD7 方案 B）
- 发布门禁 `npm run verify`：全量测试 + 宿主/模型 API 契约校验
- **工作树隔离（手动流程）**：`docs/worktree-isolation.md` + `examples/worktree-dispatch.jsonc`，说明用宿主
  `create_worktree` 建隔离工作树、派单 `cwd` 指向它、人工 merge / cherry-pick / patch 合并与
  `git worktree remove` / `prune` 清理。
- **协作效率规范文档**：新增 `docs/efficiency.md`，落地派单简报 / 输出 / 收口 / 失败标注
  四条协作约定（纯提示词 / 文档，0 代码、不进配置、不做门禁）；明确不做重复任务去重、
  角色自动路由、冷却 / 自动换模型。中文 README 加链接，`docs/architecture.md` 补「协作效率机制」小节

### Changed
- **并发模型改为「宿主 8 共享 + 插件全局 4」**（2026-11-11 用户决策）：宿主池满直接抛
  `ACTIVATION_LIMIT_REACHED`（无等待/队列），插件原样透传；插件只保留全局
  `maxParallelWritesTotal`（默认 4，仅统计本插件任务），超限立即拒绝 `WRITE_LIMIT_TOTAL`；
  删除按项目额度。同项目隔离互斥/`serializeWrites` 明确为正确性保护而非额度
- **迟到结算回填 `stopConfirmed`**：取消/卸载时 dispose 超时或抛错先写
  `cancelled + stopConfirmed:false` 并保留槽位；`activation.result` 落定后再写一条终态，
  把 `stopConfirmed` 回填为 `true`、`diagnostic` 追加 `late settlement`，`status` 保持
  `cancelled` 不被覆盖，这时才释放槽位
- `limits` 新增 `defaultIsolation`（默认 `worktree`）；`serializeWrites` 仅在 `isolation:none` 时生效
- 当前开发线：8 个工具；`node scripts/run-tests.mjs` 214 项全绿；`node scripts/verify-host-schema.mjs` PASS
- `docs/configuration.md` / `docs/security.md` / `examples/worktree-dispatch.jsonc` 同步并行隔离与失败关闭语义
- 文档校准：`permissionPreset` / `readOnly` / `READONLY_*` / `maxParallelReadonly` 等只读旧表述统一标注
  「已移除 / 不做（已移除）」；审计文档保留历史并加"已移除"声明；`docs/audit/15` 能力对照补
  「并行多任务：已实现」；`docs/worktree-isolation.md` 链接进中英文 README。

### Fixed
- **Windows 并发读取时的终态丢失**：记录文件被 `readFile` 占用时 `rename` 偶发 `EPERM/EBUSY`，
  导致终态退回 `running`；`run-store` 对 `EPERM` / `EACCES` / `EBUSY` 做短重试
- **2026-11-10 事故**：工具 `parameters` 未编译成合法 JSON Schema，导致 DeepSeek 对全部会话每轮返回 400。
  现改为按宿主契约编译，并在注册前 fail-fast 校验；见 `docs/audit/13-incident-tool-schema.md`
- 并发写任务在占槽前就启动（两个写任务可同时成功）；槽位在任务结束后不释放
- 歧义角色提示"请用 roleId"但 roleId 也被拒
- `channel` 字段级覆盖会把 `kind` 重置成默认值

### Removed
- **只读通道彻底移除**（2026-11-11 用户决策）：`meetingstone_dispatch.readOnly` 参数、`readOnlyEnforced`、
  `permissionPreset`（角色与通道实例）、`READONLY_UNENFORCEABLE` / `READONLY_LIMIT`、只读并发计数与
  `limits.maxParallelReadonly` 全部删除。原因：宿主 subagent spec 没有权限字段，做不到绝对只读，就整个不提供。
  **不要再实现**；`docs/audit/14`、`docs/audit/15` 里保留的是历史记录。
- **项目级 `limits` 死配置移除**：`.meetingstone.json` 不再解析/校验/导出 `limits`；`serializeWrites` 只在插件
  全局配置（`src/config.js`）里生效。旧项目配置里写了 `limits` 会按未知字段忽略，不报错、不阻断派单。

### Security
- 派单 `cwd` 必须落在项目根内；拿不到项目根则失败关闭
- 并行隔离是**文件布局隔离，不是权限沙箱**：同账号、同文件系统、共享 git 元数据
- 工作树建树前后都做 realpath 校验，防 junction/symlink 逃出项目根
- 不读取/复制/注入任何 CLI 凭据；探测只报文件是否存在
