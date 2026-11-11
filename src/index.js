// @ts-check
/**
 * dsh-meetingstone — 集合石 / MeetingStone
 *
 * 入口：装配「配置 → 角色注册表 → 派单器 → 工具」，其余全部复用 DSH 原生。
 *
 * 设计约束（来自阶段 0 审计，勿改）：
 * - 不自建任务队列 / 会话 / 数据库（复用 DSH 原生）
 * - 不自研 CLI 启动器（派单经宿主 provider，docs/audit/03-native-capabilities.md）
 * - 任何资源都挂在 ctx.effect() 上，dispose 必须幂等且串行等待
 * - 本项目**不提供只读通道**：宿主 subagent spec 没有权限字段，做不到绝对只读就明说
 */
import { Config } from './config.js'
import { createRegistry } from './roles/registry.js'
import { createDispatcher } from './dispatch/dispatcher.js'
import { createProbe } from './cli/probe.js'
import { createDefaultResolvers, runCommand } from './cli/resolvers.js'
import { createDshAdapter } from './dsh/adapter.js'
import { inject as toolsInject, registerTools } from './dsh/register.js'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createNodeProjectConfigStore } from './project/load.js'
import { resolveEffectiveConfig } from './session/config.js'
import { createNodeSessionOverrideStore } from './session/store.js'
import { createRunStore } from './run-store.js'
import { createWorktreeManager } from './worktree.js'
import { createGuiState, registerGuiRemote } from './gui/host.js'

/**
 * 宿主运行时把 `@deepseek-ai/dsh-tools` 作为 shared package 提供。
 * `defineTool` 会把「字段 spec 字典」编译成模型可见的 JSON Schema，并在
 * execute 前校验 args；缺了它，`ctx.tools.register` 收到的是未编译的字典，
 * 其中字段名会被当成 JSON Schema 的保留注解（要求 boolean），
 * DeepSeek API 直接返回 `Invalid schema for function ... is not of type "boolean"`。
 *
 * 本地单测环境只装了 schemastery，故用同步探测 + 容错：拿不到宿主包时
 * 由 register.js 走等价的本地编译（见该文件 compileToolSpec），绝不降级为
 * 「原样注册」。刻意不用顶层 await 动态 import——插件可能被宿主以同步
 * require(ESM) 方式加载，含 TLA 的模块会抛 ERR_REQUIRE_ASYNC_MODULE。
 * 本地编译路径只保证 schema 合法，不含运行时 args 校验。
 */
const require = createRequire(import.meta.url)
let hostDefineTool
try {
  ({ defineTool: hostDefineTool } = require('@deepseek-ai/dsh-tools'))
} catch {
  hostDefineTool = undefined
}

/**
 * 注意：这里**不导出** `Config`。
 *
 * 原因（2026-11-10 真机定位）：宿主的 profile loader 会对插件导出的 `Config`
 * 做 Schemastery → JSON Schema 的静态投影（`dsh-app-boot` 里的 `validator.validate`），
 * 我们的零依赖 schema 不具备那套结构，导致 profile 启动时该行直接
 * `fiberPhase: failed`（diagnostic: "Cannot read properties of undefined (reading 'validate')"），
 * 插件整个不加载、工具全部消失。
 *
 * 因此配置由 `apply()` 内部校验，宿主侧不再参与投影。
 * 代价：没有自动生成的设置表单（第一版本来就不做 UI）。
 */
// 需要的宿主服务：
// - tools：工具注册（dsh-tools 的 defineTool 走这一层）
// - subagents：派单通道与可用性查询（Cordis 里不声明就访问会抛 "cannot get property ... without inject"）
export const inject = [...toolsInject, 'subagents']

/** 插件名，同时作为 Loader 行 id 的默认值。 */
export const name = 'meetingstone'

/** 包名，与 package.json 的 name 一致（补丁按包名解析入口）。 */
export const PACKAGE_NAME = 'dsh-meetingstone'

export const PLUGIN_VERSION = '0.0.16'

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 原始配置（宿主不再按导出的 schema 校验，见上方说明）
 */
export function apply(ctx, config = {}) {
  // 配置校验在这里做。**坏配置不能拖垮整个插件**：记一条告警、回落到默认值，
  // 让工具仍然可用（角色表为空时 list_roles 会如实返回空，而不是插件消失）。
  let cfg
  try {
    cfg = Config(/** @type {any} */ (config) ?? {})
  } catch (err) {
    cfg = Config({})
    const line = `[${name}] config invalid, falling back to defaults: ${
      err instanceof Error ? err.message : String(err)
    }`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
    else console.warn(line)
  }

  // 角色来源：全局配置 + 当前项目根的 `.meetingstone.json` + 当前会话覆盖
  // （`.meetingstone/sessions/<sessionId>.json`，按 mtime 缓存项目文件）。
  const projectStore = createNodeProjectConfigStore()
  const sessionStore = createNodeSessionOverrideStore()

  /** @type {import('./roles/registry.js').RoleRegistry} */
  const globalRegistry = createRegistry({ globalRoles: cfg.roles ?? [] })

  // 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录）。
  // 设置在 GUI 之前创建：设置页「CLI 连接」直接复用同一探测器与 5 分钟缓存。
  const probe = createProbe({
    resolvers: createDefaultResolvers({ run: runCommand }),
    runner: runCommand,
  })

  // GUI 只读数据（Host half）：与工具共用同一份 registry / channels / cfg，不另建数据源。
  // 最近错误由注册表错误初始化，随后由项目配置加载、派单失败、落盘失败更新。
  const gui = createGuiState({
    ctx,
    registry: globalRegistry,
    channels: cfg.channels ?? [],
    config: {
      defaultRoleId: cfg.defaultRoleId,
      dispatchNotes: cfg.dispatchNotes,
      projectConfigFile: cfg.projectConfigFile,
      limits: cfg.limits,
    },
    probe,
  })

  /**
   * 按当前执行上下文构造项目级注册表。
   * 项目根取 `exec.agent.session.header.cwd`（docs/audit/07-config-extension.md §4.2）；
   * 会话 id 取 `exec.agent.session.id`（宿主保证 `agent.id === session.id`）。
   * @param {any} exec
   */
  async function resolveRegistry(exec) {
    const projectRoot = exec?.agent?.session?.header?.cwd
    const sessionId = exec?.agent?.session?.id
    const loaded = projectStore.get(projectRoot, cfg.projectConfigFile)
    // 没有会话 id 时不应用会话覆盖（宁可不生效，也不张冠李戴到别的会话）。
    const sessionLoaded =
      typeof sessionId === 'string' && sessionId
        ? sessionStore.get(projectRoot, sessionId)
        : { config: undefined, errors: [] }
    const resolved = resolveEffectiveConfig({
      global: cfg,
      project: loaded.config,
      session: sessionLoaded.config,
    })
    // 生效角色表已经合并完毕；注册表只负责解析与别名冲突判定。
    const registry = createRegistry({ globalRoles: resolved.effective.roles })
    // 项目文件解析错误 + 会话文件错误 + 继承/覆盖错误 + 注册表语义错误
    const projectErrors = [
      ...(loaded.errors ?? []),
      ...(sessionLoaded.errors ?? []),
      ...(resolved.errors ?? []),
      ...(registry.errors ?? []),
    ]
    // 设置页的“最近错误”也反映项目/会话配置问题；只记录，不改变返回结构。
    for (const error of projectErrors) gui.recordError(error, 'project-config')
    return {
      registry,
      projectErrors,
      // P1-B：自动路由的兜底角色按「全局 → 项目 → 会话」继承；规则表只来自插件全局配置。
      defaultRoleId: resolved.effective.defaultRoleId ?? cfg.defaultRoleId,
      routingRules: Array.isArray(cfg.routingRules) ? cfg.routingRules : [],
      // 供后续 UI 显示“继承/覆盖”；工具当前不返回，避免扩大回执。
      sources: resolved.sources,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
    }
  }

  // parent 由每次工具执行的 context.agent 传入（不再用全局 holder）
  // 通道实例表承载模型/强度：宿主的启动 spec 不接收这两个字段（DD7 方案 B）
  //
  // 派单结果落盘（P0）：一个项目根一个 store，按需创建并缓存。
  // 写盘失败**不篡改**真实结果——失败的 store 记在工具层，作为 persistenceWarning 返回。
  //
  // runtimeId：每次插件启动生成一次。磁盘里 status=running 但 runtimeId 不是当前值的记录，
  // 读取时投影成 interrupted（见 run-store.projectInterrupted），不把上一进程的假 running 当真。
  const runtimeId = randomUUID()
  /** @type {Map<string, any>} */
  const runStores = new Map()

  /** @param {string | null | undefined} projectRoot */
  function storeFor(projectRoot) {
    if (typeof projectRoot !== 'string' || !projectRoot) return null
    let store = runStores.get(projectRoot)
    if (!store) {
      store = createRunStore({ root: projectRoot, runtimeId })
      runStores.set(projectRoot, store)
    }
    return store
  }

  /** @type {Map<string, { code: string, message: string }>} */
  const persistenceWarnings = new Map()
  /**
   * 每个 childId 一条 promise 链：保证 running 先写、终态后写，终态不会被慢的 running 覆盖。
   * @type {Map<string, Promise<void>>}
   */
  const persistQueues = new Map()

  // 任务级工作树隔离（路 2）：只接管 git 工作树，不碰父会话 cwd。
  // 建树/计算改动都由 dispatcher 与落盘层共用同一个管理器。
  const worktrees = createWorktreeManager()

  /**
   * 真正写一次盘。永不 reject：失败只记 `persistenceWarning`，不影响任务真实结果。
   *
   * 终态记录若带工作树，先计算相对 baseSha 的改动文件（`changedFiles`）。
   * 计算失败时写 `changedFilesUnknown: true`，**绝不伪装成无改动**——重叠检测依赖这个区分。
   * @param {any} record
   * @returns {Promise<void>}
   */
  async function writeRunNow(record) {
    const store = storeFor(record?.projectRoot)
    if (!store) return
    const childId = String(record?.childId ?? '')
    let enriched = record
    if (
      record?.worktree &&
      record.status !== 'running' &&
      record.changedFiles === undefined &&
      typeof record.worktree.path === 'string' &&
      typeof record.worktree.baseSha === 'string'
    ) {
      try {
        const changed = await worktrees.computeChangedFiles(
          record.worktree.path,
          record.worktree.baseSha,
        )
        enriched = changed.unknown
          ? { ...record, changedFiles: [], changedFilesUnknown: true }
          : { ...record, changedFiles: changed.files ?? [], changedFilesUnknown: false }
      } catch {
        enriched = { ...record, changedFiles: [], changedFilesUnknown: true }
      }
    }
    try {
      await store.writeRun(enriched)
      persistenceWarnings.delete(childId)
    } catch (err) {
      const warning = {
        code: err?.code ?? 'RUN_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
      persistenceWarnings.set(childId, warning)
      gui.recordError(warning, 'persistence')
    }
  }

  /**
   * 把记录写到项目目录，按 childId 串行。
   *
   * 为什么必须串行：`onRunStart` / `onRunFinish` 原来各自由 `void persistRun()` 触发，
   * 两个 `fs.writeFile` 并发时完成顺序不确定；快速任务的 running 可能晚于 completed 落地，
   * 磁盘最终变成 running。这里用 promise 链把同一 childId 的写入排成 FIFO。
   *
   * @param {any} record
   * @returns {Promise<void>}
   */
  function persistRun(record) {
    const childId = String(record?.childId ?? '')
    if (!childId) return Promise.resolve()
    const previous = persistQueues.get(childId) ?? Promise.resolve()
    const next = previous.then(() => writeRunNow(record))
    persistQueues.set(childId, next)
    const forget = () => {
      if (persistQueues.get(childId) === next) persistQueues.delete(childId)
    }
    void next.then(forget, forget)
    return next
  }

  const adapter = createDshAdapter(ctx, {
    channels: cfg.channels ?? [],
    // 返回 promise：适配器在 cancel/卸载时会 await，确保终态真正写盘后才结束
    onRunStart: (record) => persistRun(record),
    onRunFinish: (record) => persistRun(record),
  })

  /**
   * 内存查不到时的磁盘兜底（DSH 重启后仍能读到终态）。
   * @param {any} exec
   * @param {string} childId
   */
  async function loadPersistedRun(exec, childId) {
    const store = storeFor(exec?.agent?.session?.header?.cwd)
    if (!store) return null
    try {
      const record = await store.loadRun(childId)
      const warning = persistenceWarnings.get(childId)
      return warning ? { ...record, persistenceWarning: warning } : record
    } catch (err) {
      return {
        status: 'unknown',
        childId,
        reason: err instanceof Error ? err.message : String(err),
        ...(err?.code ? { code: err.code } : {}),
      }
    }
  }

  /**
   * 列出当前项目最近的派单记录（工具 `meetingstone_list_runs` 用）。
   * @param {any} exec
   * @param {{ limit?: number }} [options]
   */
  async function listPersistedRuns(exec, options = {}) {
    const root = exec?.agent?.session?.header?.cwd
    const store = storeFor(root)
    if (!store) return { runs: [], reason: '当前执行上下文没有项目根，无法定位派单记录' }
    const runs = await store.listRuns({ limit: options.limit })
    return { runs, dir: store.dir }
  }

  /**
   * 磁盘记录路径（供 get_task 默认返回 recordPath）。
   * 拿不到项目根/childId 不合法时返回 null，交给工具如实省略。
   * @param {any} exec
   * @param {string} childId
   */
  function recordPathFor(exec, childId) {
    const store = storeFor(exec?.agent?.session?.header?.cwd)
    if (!store || typeof childId !== 'string' || !childId) return null
    try {
      return store.pathFor(childId)
    } catch {
      return null
    }
  }

  const dispatcher = createDispatcher({
    registry: globalRegistry,
    adapter,
    limits: cfg.limits ?? {},
    // 路 2：插件自己管理 git worktree（不调用宿主 ctx.worktrees，避免切走父会话 cwd）
    worktrees,
  })

  /**
   * 工具层用的派单器：只是给 dispatch 加一个“最近错误”观察，不改变任何返回值。
   * cancel/getTask/stats 等原样透传。GUI 只读页因此能看到真实的派单失败。
   */
  const toolDispatcher = {
    ...dispatcher,
    async dispatch(input) {
      const result = await dispatcher.dispatch(input)
      gui.recordDispatch(result)
      return result
    },
  }

  let registered = false

  ctx.effect(() => {
    registerTools(ctx, {
      registry: globalRegistry,
      dispatcher: toolDispatcher,
      probe,
      resolveRegistry,
      // P1-B：自动路由的全局兜底（项目/会话配置可覆盖 defaultRoleId；规则表只来自全局）
      defaultRoleId: cfg.defaultRoleId,
      routingRules: Array.isArray(cfg.routingRules) ? cfg.routingRules : [],
      loadPersistedRun,
      listPersistedRuns,
      recordPathFor,
      ...(typeof hostDefineTool === 'function' ? { defineTool: hostDefineTool } : {}),
    })
    registered = true

    // GUI 只读 Remote：宿主注册 `meetingstone/list`（SRC marker），浏览器 half 用
    // ctx.remote.meetingstone.list() 取快照。宿主没有 Typert 协议时静默跳过，
    // 不影响工具与派单（设置页会显示“读取失败”，不会假装有数据）。
    const guiRemote = registerGuiRemote(ctx, { snapshot: () => gui.fullSnapshot() })
    if (guiRemote.registered !== true) {
      const detail = `[${name}] GUI remote unavailable: ${guiRemote.reason}${
        guiRemote.error ? ` (${guiRemote.error})` : ''
      }`
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(detail)
      else console.log(detail)
    }

    const line = `[${name}] loaded v${PLUGIN_VERSION} (roles=${globalRegistry.list().length})`
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(line)
    else console.log(line)

    // 卸载/停用：幂等。工具与探测缓存由宿主 effect 体系回收，这里只做显式清理。
    return () => {
      if (!registered) return
      registered = false
      probe.invalidate()
      projectStore.invalidate()
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[${name}] disposed`)
      else console.log(`[${name}] disposed`)

      // 刚落盘队列里可能还有刚结束任务的终态：等它们写完再真正卸载，
      // 避免「任务已 completed、磁盘还停在 running」（与适配器的存活任务收尾互补）。
      const pending = [...persistQueues.values()]
      if (pending.length === 0) return
      return Promise.all(pending).then(() => {})
    }
  }, `${name}: lifecycle`)
}
