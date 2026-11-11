// @ts-check
/**
 * GUI 数据提供者（Host half）：无参只读快照 + 三个 strict 会话方法。
 *
 * 数据链路（证据见 docs/gui-0.2.0.md §1/§8）：
 *   browser `ctx.remote.meetingstone.list()`
 *     → Typert Gateway `/api`（SRC marker 反射）
 *     → 本文件创建的 `TypertRemoteService`（namespace `meetingstone`, method `list`）
 *     → `createGuiState().fullSnapshot()`（同步快照 + 全局配置 + CLI 探测）
 *
 *   browser `ctx.remote.meetingstone.getSessionConfig()` 等
 *     → Typert Gateway `/api`（优先 Host strict 定义）
 *     → 同一 service 的会话方法
 *     → `createSessionRemoteHandlers` → `src/gui/session.js`（继承/白名单/落盘）
 *
 * 数据**不另建源**：
 *   - 角色：`registry.list()`（与 `meetingstone_list_roles` 同一份注册表）
 *   - 通道/默认模型：插件配置 `cfg.channels`（与派单器同一份）
 *   - 额度/并发、调度规则：插件配置 `cfg.limits` / `cfg.defaultRoleId` /
 *     `cfg.dispatchNotes` / `cfg.projectConfigFile`
 *   - CLI 连接：`probe.probeAll()`（与 `meetingstone_cli_status` 同一探测器和缓存）
 *   - 最近错误：注册表/项目配置错误 + 本进程最近一次派单失败/落盘失败
 *
 * 为什么这里懒加载 `@deepseek-ai/dsh-typert-protocol`：
 * 本地单测环境没有宿主包（与 src/index.js 的 defineTool 同一取舍）。拿不到宿主
 * 协议时**不注册** remote，只返回 `{ registered:false, reason }`，由入口记日志；
 * 绝不会因为 GUI 缺失而拖垮工具/派单。
 */

import { createRequire } from 'node:module'
import { roleAvailability } from '../dsh/register.js'
import { deriveRoleView } from './state-model.js'
import { CLI_SPECS } from '../cli/probe.js'
import { createSessionRemoteHandlers } from './session-remote.js'
import { registerSessionStrictRemotes } from './typert.js'

const require = createRequire(import.meta.url)

/** Remote namespace / Cordis 服务名；与 client half 的 `ctx.remote.<name>` 对齐。 */
export const GUI_REMOTE_SERVICE = 'meetingstone'

/** `@deepseek-ai/dsh-typert-protocol/remote-methods` 的版本。 */
const REMOTE_METHOD_DESCRIPTOR_VERSION = 1

/**
 * 暴露无参 `list` + 三个带参会话方法。
 *
 * 0.2.0 曾因手写带参 descriptor 被 Gateway 拒绝（`has no strict codec`）而移除
 * 三个会话方法；本版按官方生成物的写法恢复：
 *  - Host：真实 zod schema 构造 `{mode:"strict", typeSymbol, create}`，
 *    经 `createTypertRemoteInfo` 生成 descriptor，再由 `ctx.typert.register()`
 *    写入 Host 定义（`src/gui/typert.js`）；
 *  - Client：同一 typeSymbol 的 strict 参数 codec（`src/client/index.js`）；
 *  - 无参 `list` 继续走 SRC marker，不做改动。
 * 宿主缺少 typert/zod 时只跳过 strict 方法，`list` 与工具/派单不受影响。
 */

/**
 * 设置页打开时最多等 CLI 探测多久。探测有 5 分钟缓存（src/cli/probe.js TTL），
 * 首次冷启动在本机约 0.8s；超时则如实返回 `cli: null`，不编造状态。
 */
const CLI_PROBE_TIMEOUT_MS = 8000

/**
 * 读取最近一条注册表错误，作为首次快照的 lastError。
 * @param {any} registry
 * @returns {{ code: string, message: string, at: string | null, source: string } | null}
 */
function initialLastError(registry) {
  const errors = Array.isArray(registry?.errors) ? registry.errors : []
  const last = errors[errors.length - 1]
  if (!last || typeof last !== 'object') return null
  return normalizeError(last, 'registry', null)
}

/**
 * 把任意错误对象压成 JSON-safe 的 `{ code, message, at, source }`。
 * 不保留 stack / 原始对象：remote 返回值必须是无损 JSON。
 * @param {any} value
 * @param {string} source
 * @param {number} [now]
 */
function normalizeError(value, source, now = Date.now()) {
  const code =
    value && typeof value === 'object' && typeof value.code === 'string' && value.code
      ? value.code
      : 'UNKNOWN'
  const rawMessage =
    value && typeof value === 'object' && typeof value.message === 'string'
      ? value.message
      : value instanceof Error
        ? value.message
        : value === undefined || value === null
          ? ''
          : String(value)
  return {
    code,
    message: rawMessage.length > 2000 ? `${rawMessage.slice(0, 2000)}…` : rawMessage,
    at: now === null ? null : new Date(now).toISOString(),
    source,
  }
}

/**
 * 角色 → 只读视图。
 *
 * 三字段（`userPreference` / `readiness` / `quota`）与三色 `color` 由
 * `src/gui/state-model.js` 统一派生；`availability` 仍保留为旧字段的兼容投影，
 * 且继续复用 `roleAvailability` 的判定结果，保证 `meetingstone_list_roles`
 * 与自动路由看到的值不变。
 *
 * @param {any} role
 * @param {any} ctx
 * @param {any} [sources] `resolveEffectiveConfig(...).sources`（用于区分显式 enabled 与默认值）
 */
function roleView(role, ctx, sources = null) {
  const channel = role?.channel
  let subagents = null
  try {
    subagents = ctx?.subagents ?? null // 未 inject 时访问会抛，按"未知"处理
  } catch {
    subagents = null
  }
  const state = deriveRoleView(role, {
    subagents,
    availability: roleAvailability(role, ctx),
    sources,
  })
  return {
    roleId: typeof role?.roleId === 'string' ? role.roleId : '',
    name: typeof role?.name === 'string' ? role.name : '',
    aliases: Array.isArray(role?.aliases) ? role.aliases.map(String) : [],
    enabled: role?.enabled !== false,
    userPreference: state.userPreference,
    readiness: state.readiness,
    readinessReason: state.readinessReason,
    quota: state.quota,
    color: state.color,
    availability: state.availability,
    // 角色引用的通道：设置页「默认模型」用它把默认角色解析到模型。
    channelId: typeof channel?.channelId === 'string' ? channel.channelId : '',
    provider: typeof channel?.provider === 'string' ? channel.provider : '',
    model: typeof channel?.model === 'string' ? channel.model : '',
    reasoning: typeof channel?.reasoning === 'string' ? channel.reasoning : '',
  }
}

/**
 * 通道实例 → 只读视图（channelId + kind）。
 * @param {any} channel
 */
function channelView(channel) {
  return {
    channelId: typeof channel?.channelId === 'string' ? channel.channelId : '',
    kind: typeof channel?.kind === 'string' ? channel.kind : 'in-process',
  }
}

/** 通道实例的完整只读视图（设置页用，含模型/强度）。 */
function channelDetailView(channel) {
  return {
    channelId: typeof channel?.channelId === 'string' ? channel.channelId : '',
    description: typeof channel?.description === 'string' ? channel.description : '',
    kind: typeof channel?.kind === 'string' ? channel.kind : 'in-process',
    provider: typeof channel?.provider === 'string' ? channel.provider : '',
    model: typeof channel?.model === 'string' ? channel.model : '',
    reasoning: typeof channel?.reasoning === 'string' ? channel.reasoning : '',
  }
}

/** 并发/额度配置的只读视图；全部字段都保证 JSON-safe。 */
function limitsView(limits) {
  const source = limits && typeof limits === 'object' ? limits : {}
  const max =
    Number.isFinite(source.maxParallelWritesTotal) && source.maxParallelWritesTotal >= 1
      ? Math.trunc(source.maxParallelWritesTotal)
      : 4
  return {
    serializeWrites: source.serializeWrites !== false,
    maxParallelWritesTotal: max,
    defaultIsolation: source.defaultIsolation === 'none' ? 'none' : 'worktree',
  }
}

/** CLI 探测结果 → JSON-safe 的只读视图。 */
function cliView(result) {
  const source = result && typeof result === 'object' ? result : {}
  const cli = typeof source.cli === 'string' ? source.cli : ''
  const spec = /** @type {Record<string, any>} */ (CLI_SPECS)[cli]
  const notes = Array.isArray(source.notes) ? source.notes.map(String).slice(0, 8) : []
  return {
    cli,
    label: typeof spec?.label === 'string' ? spec.label : cli,
    // CLI 探测只覆盖外部 CLI（docs/design/global-config.md:41）；宿主本身不在此列表。
    category: 'external',
    installed: source.installed === true,
    path: typeof source.path === 'string' ? source.path : '',
    version: typeof source.version === 'string' ? source.version : '',
    source: typeof source.source === 'string' ? source.source : '',
    notes,
    checkedAt: typeof source.checkedAt === 'number' ? new Date(source.checkedAt).toISOString() : null,
  }
}

/**
 * 等待一个 promise，超时返回 `null`（调用方如实显示「未获取」）。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 创建 GUI 状态。纯闭包，无 I/O；remote 每次 list 调一次 `snapshot()`，
 * 因此页面重新打开/重新拉取时能读到最新错误。
 *
 * @param {object} [options]
 * @param {any} [options.ctx] Host 插件 ctx（用于 `ctx.subagents.getProvider`）
 * @param {any} [options.registry] 角色注册表 `{ list(), errors }`
 * @param {Array<any>} [options.channels] 插件配置里的通道实例表
 * @param {object} [options.config] 插件全局配置（默认角色/调度提示/并发策略）
 * @param {any} [options.sources] 全局配置的字段来源（`resolveEffectiveConfig().sources`）；
 *   用于区分「显式 enabled」与「schema 默认 enabled」，缺失时按默认值处理。
 * @param {{ probeAll?: (opts?: any) => Promise<any[]> }} [options.probe] CLI 探测器
 */
export function createGuiState({
  ctx = null,
  registry = null,
  channels = [],
  config = {},
  sources = null,
  probe = null,
} = {}) {
  /** @type {ReturnType<typeof normalizeError> | null} */
  let lastError = initialLastError(registry)

  /**
   * 记一条错误。后到的覆盖先到的；空错误忽略。
   * @param {any} value
   * @param {string} [source]
   */
  function recordError(value, source = 'runtime') {
    if (value === undefined || value === null) return
    lastError = normalizeError(value, source)
  }

  /**
   * 记录一次派单结果。只有失败才改 lastError；成功不覆盖历史错误
   * （"最近错误"语义，不是"最近一次结果"）。
   * @param {any} result dispatcher.dispatch() 的返回
   */
  function recordDispatch(result) {
    if (result && typeof result === 'object' && result.ok === false) {
      recordError(result, 'dispatch')
    }
  }

  /** @returns {{ roles: any[], channels: any[], lastError: any }} */
  function snapshot() {
    let roles = []
    try {
      roles = typeof registry?.list === 'function' ? registry.list() : []
    } catch {
      roles = []
    }
    return {
      roles: Array.isArray(roles) ? roles.map((role) => roleView(role, ctx, sources)) : [],
      channels: Array.isArray(channels) ? channels.map(channelView) : [],
      lastError: lastError ? { ...lastError } : null,
    }
  }

  /**
   * 全局配置视图。只投影插件自己的 `cfg`，不推断、不补造字段。
   * @param {any[] | null} cli
   * @param {string | null} cliError
   */
  function globalView(cli, cliError) {
    const source = config && typeof config === 'object' ? config : {}
    return {
      defaultRoleId: typeof source.defaultRoleId === 'string' ? source.defaultRoleId : '',
      dispatchNotes: typeof source.dispatchNotes === 'string' ? source.dispatchNotes : '',
      projectConfigFile:
        typeof source.projectConfigFile === 'string' && source.projectConfigFile
          ? source.projectConfigFile
          : '.meetingstone.json',
      limits: limitsView(source.limits),
      channels: Array.isArray(channels) ? channels.map(channelDetailView) : [],
      cli: Array.isArray(cli) ? cli.map(cliView) : null,
      cliError: cliError ?? null,
    }
  }

  /**
   * 设置页快照 = 同步快照 + 全局配置 + 本机 CLI 探测。
   * CLI 探测复用 `probe`（与 `meetingstone_cli_status` 同一缓存），失败/超时
   * 只记 `cliError`，不影响角色与通道列表。
   * @returns {Promise<ReturnType<typeof snapshot> & { global: any }>}
   */
  async function fullSnapshot() {
    let cli = null
    let cliError = null
    if (probe && typeof probe.probeAll === 'function') {
      try {
        const results = await withTimeout(probe.probeAll(), CLI_PROBE_TIMEOUT_MS)
        if (Array.isArray(results)) cli = results
        else cliError = 'CLI_PROBE_TIMEOUT'
      } catch (error) {
        cliError = error instanceof Error ? error.message : String(error)
      }
    }
    return { ...snapshot(), global: globalView(cli, cliError) }
  }

  return { snapshot, fullSnapshot, recordError, recordDispatch }
}

/**
 * 懒加载宿主 Typert 协议。拿不到返回 null（本地单测/无 GUI 宿主）。
 * @returns {any}
 */
function loadTypertProtocol() {
  try {
    return require('@deepseek-ai/dsh-typert-protocol')
  } catch {
    return null
  }
}

/**
 * 用宿主公开的 `Remote` 装饰器在方法上打 SRC marker。
 *
 * 这里**不写装饰器语法**（Node 20 不支持），而是复刻编译产物的调用顺序：
 * `Remote("list")` 返回一个 Stage-3 decorator，必须再以
 * `decorator(value, context)` 调用一次才会注册 initializer；
 * initializer 内部通过 `Object.getPrototypeOf(this)` 给原型打标记。
 * 与官方编译产物（dsh-host-plugin-inventory/lib/index.js:73-99）行为一致。
 *
 * @param {object} prototype
 * @param {string} method
 * @param {Function} Remote
 */
export function markRemoteMethod(prototype, method, Remote) {
  const decorator = Remote(method)
  if (typeof decorator !== 'function') {
    throw new TypeError(`typert Remote("${method}") did not return a decorator`)
  }
  /** @type {Function[]} */
  const initializers = []
  decorator(prototype[method], {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(fn) {
      if (typeof fn === 'function') initializers.push(fn)
    },
  })
  const receiver = Object.create(prototype)
  for (const init of initializers) init.call(receiver)
  if (initializers.length === 0) {
    throw new TypeError(`typert Remote("${method}") registered no marker initializer`)
  }
}

/**
 * 注册 GUI Remote 服务。返回 `{ registered, reason?, error?, stack? }`，**永不抛**。
 *
 * 宿主侧由 Gateway 的 SRC（source）模式发现 `list`；三个带参方法额外注册
 * strict Host 定义（`ctx.typert.register`），Gateway 会优先使用它
 * （`dsh-api-gateway/lib/index.js:1255-1259`）。strict 注册失败/不可用时，
 * 带参方法仍保留 SRC marker 作为降级（Host 侧可调用；客户端是否挂载由
 * strict codec 决定），不会拖垮 `list`、工具或派单。
 *
 * @param {any} ctx Host 插件 ctx
 * @param {{ snapshot: () => any, sessionApi?: any }} deps
 */
export function registerGuiRemote(ctx, deps) {
  if (!ctx || typeof deps?.snapshot !== 'function') {
    return { registered: false, reason: 'INVALID_DEPS' }
  }
  const protocol = loadTypertProtocol()
  if (!protocol || typeof protocol.TypertRemoteService !== 'function' || typeof protocol.Remote !== 'function') {
    return { registered: false, reason: 'TYPERT_UNAVAILABLE' }
  }

  try {
    const { TypertRemoteService, Remote, RemoteError } = protocol
    const handlers = deps.sessionApi
      ? createSessionRemoteHandlers(deps.sessionApi, { RemoteError })
      : null
    class MeetingStoneGuiRemote extends TypertRemoteService {
      constructor(context) {
        super(context, GUI_REMOTE_SERVICE)
      }

      /** 只读快照：不被调用的参数、无副作用；每次调用重新投影。 */
      async list() {
        return deps.snapshot()
      }

      /** 读取当前会话的角色配置视图（strict：sessionId）。 */
      async getSessionConfig(sessionId) {
        if (!handlers) throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '会话远程未装配')
        return handlers.getSessionConfig(sessionId)
      }

      /** 写一个字段级会话覆盖（strict：sessionId/roleId/field/value）。 */
      async setSessionOverride(sessionId, roleId, field, value) {
        if (!handlers) throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '会话远程未装配')
        return handlers.setSessionOverride(sessionId, roleId, field, value)
      }

      /** 恢复一个字段/整角色的继承（strict：sessionId/roleId/可省略 field）。 */
      async clearSessionOverride(sessionId, roleId, field) {
        if (!handlers) throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '会话远程未装配')
        return handlers.clearSessionOverride(sessionId, roleId, field)
      }
    }
    for (const method of ['list', 'getSessionConfig', 'setSessionOverride', 'clearSessionOverride']) {
      markRemoteMethod(MeetingStoneGuiRemote.prototype, method, Remote)
    }
    const instance = new MeetingStoneGuiRemote(ctx)

    // 真实 zod strict 契约（Host 定义）。失败只记日志，不影响上面的 SRC 服务。
    const strict = handlers
      ? registerSessionStrictRemotes(ctx, {
          log: (level, line) => {
            const logger = ctx.logger
            if (logger && typeof logger[level] === 'function') logger[level](line)
            else if (level === 'error') console.error(line)
            else console.log(line)
          },
        })
      : { registered: false, reason: 'SESSION_API_UNAVAILABLE' }

    return { registered: true, instance, strict }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack =
      error instanceof Error && error.stack ? String(error.stack).replace(/\s+/g, ' ').slice(0, 600) : ''
    return {
      registered: false,
      reason: 'REMOTE_REGISTER_FAILED',
      error: message,
      stack,
    }
  }
}

/** 供 stub harness 断言 marker 形状（不用于生产逻辑）。 */
export const GUI_REMOTE_DESCRIPTOR = Object.freeze({
  version: REMOTE_METHOD_DESCRIPTOR_VERSION,
  methods: Object.freeze(['list', 'getSessionConfig', 'setSessionOverride', 'clearSessionOverride']),
})

export default registerGuiRemote
