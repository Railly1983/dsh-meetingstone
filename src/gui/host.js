// @ts-check
/**
 * GUI 数据提供者（Host half）：无参只读快照 + 五个 strict 配置方法。
 *
 * 数据链路（证据见 docs/gui-0.2.0.md §1/§8）：
 *   browser `ctx.remote.meetingstone.list()`
 *     → Typert Gateway `/api`（SRC marker 反射）
 *     → 本文件创建的 `TypertRemoteService`（namespace `meetingstone`, method `list`）
 *     → `createGuiState().fullSnapshot()`（同步快照 + 全局配置 + CLI 探测）
 *
 *   五个 strict 配置方法（`setCliEnabled` / `refreshCli` / `updateGlobalRole` /
 *   `createGlobalRole` / `deleteGlobalRole`）由 `src/gui/typert-spec.js` 构造 spec，
 *   经 `src/gui/typert.js` 用宿主的 `createTypertRemoteInfo` 变成 descriptor 后注册；
 *   设置页写操作走这条链路，不再是会话级覆盖。
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
import { createCliCapabilityCatalog, createDefaultProbes } from '../cli/capabilities.js'
import { CLI_SPECS } from '../cli/probe.js'
import { deriveCliState } from '../cli/preferences.js'
import { registerSessionStrictRemotes } from './typert.js'

const require = createRequire(import.meta.url)

/** Remote namespace / Cordis 服务名；与 client half 的 `ctx.remote.<name>` 对齐。 */
export const GUI_REMOTE_SERVICE = 'meetingstone'

/** `@deepseek-ai/dsh-typert-protocol/remote-methods` 的版本。 */
const REMOTE_METHOD_DESCRIPTOR_VERSION = 1

/**
 * 角色字段来源键（与 `src/session/config.js` 的 `sources.roles[].fields` 键一致）。
 * B1：设置页内联全局角色管理按字段展示来源；未知/缺失一律 default，不猜。
 */
const ROLE_SOURCE_FIELDS = Object.freeze([
  'name',
  'aliases',
  'description',
  'prompt',
  'enabled',
  'channel.channelId',
  'channel.kind',
  'channel.provider',
  'channel.cli',
  'channel.model',
  'channel.reasoning',
])

/**
 * 本插件暴露的全部 Remote 方法（SRC marker 与 strict 定义共用）。
 * 顺序固定：list → 五个配置方法（测试断言顺序）；B3 起无会话方法。
 */
export const GUI_REMOTE_METHODS = Object.freeze([
  'list',
  'setCliEnabled',
  'refreshCli',
  'updateGlobalRole',
  'createGlobalRole',
  'deleteGlobalRole',
])

/**
 * 暴露无参 `list` + 五个带参配置方法。
 *
 * 0.2.0 曾因手写带参 descriptor 被 Gateway 拒绝（`has no strict codec`）而移除
 * 带参方法；本版按官方生成物的写法恢复（配置 5）：
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
export function roleView(role, ctx, sources = null) {
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
  const roleId = typeof role?.roleId === 'string' ? role.roleId : ''
  const sourceEntry =
    sources && typeof sources === 'object' && sources.roles && typeof sources.roles === 'object'
      ? sources.roles[roleId]
      : null
  const rawFields =
    sourceEntry && typeof sourceEntry === 'object' && sourceEntry.fields && typeof sourceEntry.fields === 'object'
      ? sourceEntry.fields
      : {}
  /** 字段级来源（B1：设置页全局角色管理展示用；未知一律 default，不猜）。 */
  const fieldSources = {}
  for (const field of ROLE_SOURCE_FIELDS) {
    const value = rawFields[field]
    fieldSources[field] = value === 'global' || value === 'project' || value === 'session' ? value : 'default'
  }
  const sourceLayer = sourceEntry && typeof sourceEntry === 'object' && typeof sourceEntry.layer === 'string'
    ? sourceEntry.layer
    : 'default'
  return {
    roleId,
    name: typeof role?.name === 'string' ? role.name : '',
    aliases: Array.isArray(role?.aliases) ? role.aliases.map(String) : [],
    // B1：设置页「全局角色管理」内联编辑要读到这些字段（之前只投影展示/通道字段）。
    // B2：description+prompt 已合并为单一 setting；旧字段保留为兼容镜像。
    setting:
      typeof role?.setting === 'string'
        ? role.setting
        : typeof role?.prompt === 'string' && role.prompt
          ? role.prompt
          : typeof role?.description === 'string'
            ? role.description
            : '',
    description: typeof role?.description === 'string' ? role.description : '',
    prompt: typeof role?.prompt === 'string' ? role.prompt : '',
    enabled: role?.enabled !== false,
    userPreference: state.userPreference,
    readiness: state.readiness,
    readinessReason: state.readinessReason,
    quota: state.quota,
    color: state.color,
    availability: state.availability,
    // 角色引用的通道：设置页「默认模型」用它把默认角色解析到模型。
    channelId: typeof channel?.channelId === 'string' ? channel.channelId : '',
    kind: typeof channel?.kind === 'string' ? channel.kind : '',
    provider: typeof channel?.provider === 'string' ? channel.provider : '',
    model: typeof channel?.model === 'string' ? channel.model : '',
    reasoning: typeof channel?.reasoning === 'string' ? channel.reasoning : '',
    sourceLayer,
    fieldSources,
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

/** 通道实例的完整只读视图（设置页/详情页用，含模型/强度）。 */
export function channelDetailView(channel) {
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

/**
 * CLI「偏好 × preflight」派生状态 → JSON-safe 的只读视图（P0-S2）。
 *
 * 与 `cliView` 的差别：多了 `userPreference` / `enabled` / `ready` /
 * `blockedReason` / `manualSteps` / `retryable` / `login` / `hostIntegration`。
 * 这些字段只来自 `src/cli/preferences.js` 与 `src/cli/preflight.js` 的派生，
 * 不会在这里二次猜测。
 *
 * @param {any} state
 */
function cliStateView(state) {
  const source = state && typeof state === 'object' ? state : {}
  const cli = typeof source.cli === 'string' ? source.cli : ''
  const spec = /** @type {Record<string, any>} */ (CLI_SPECS)[cli]
  return {
    cli,
    label: typeof spec?.label === 'string' ? spec.label : cli,
    category: 'external',
    userPreference:
      source.userPreference === 'enabled' || source.userPreference === 'disabled'
        ? source.userPreference
        : 'unset',
    enabled: source.enabled === true,
    ready: source.ready === 'ready' || source.ready === 'blocked' ? source.ready : 'unknown',
    blockedReason: typeof source.blockedReason === 'string' ? source.blockedReason : null,
    manualSteps: Array.isArray(source.manualSteps) ? source.manualSteps.map(String).slice(0, 6) : [],
    retryable: source.retryable === true,
    autoFix: false,
    installed: source.installed === true,
    path: typeof source.path === 'string' ? source.path : '',
    version: typeof source.version === 'string' ? source.version : '',
    source: typeof source.source === 'string' ? source.source : '',
    login: source.login === true || source.login === false ? source.login : 'unknown',
    hostIntegration:
      source.hostIntegration === true || source.hostIntegration === false
        ? source.hostIntegration
        : 'unknown',
    firstDetection: source.firstDetection === true,
    notes: Array.isArray(source.notes) ? source.notes.map(String).slice(0, 8) : [],
    checkedAt: typeof source.checkedAt === 'number' ? new Date(source.checkedAt).toISOString() : null,
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
 * @param {() => Promise<any[]>} [options.cliStates] P0-S2：返回已合并偏好 + preflight 的
 *   CLI 状态（由 `src/gui/config-api.js` 提供）。提供时优先于 `probe.probeAll()`。
 * @param {import('../cli/capabilities.js').CapabilityCatalog} [options.capabilities]
 *   CLI 能力目录（B2b）。未提供时按默认探测（codex app-server / DSH host llm）创建。
 */
export function createGuiState({
  ctx = null,
  registry = null,
  channels = [],
  config = {},
  sources = null,
  probe = null,
  cliStates = null,
  capabilities = null,
} = {}) {
  /** @type {ReturnType<typeof normalizeError> | null} */
  let lastError = initialLastError(registry)

  // B2b：CLI 能力目录（4 CLI × 模型 × 强度）——GUI 的唯一能力事实源。
  // 默认探测：codex app-server model/list；DSH host ctx.llm.listModels；不可得则静态/unknown。
  // `channels` 与派单侧同源：in-process 通道的模型声明在 `llmModel`（不在 provider 行），
  // 能力目录必须从同一处取，否则「下拉能选的模型」与「派单实际用的模型」会分叉。
  const capabilityCatalog =
    capabilities ??
    createCliCapabilityCatalog({
      channels: () => (Array.isArray(channels) ? channels : []),
      // 角色实际绑定的模型也要进目录：外部 CLI 通道行通常没有 model 字段，
      // 模型声明在角色行上（如唐僧→ch-acp-kimi + model=kimi-k3.1-pro）。
      // 不补这一项，编辑器里那些模型根本看不到，用户会以为「刷新不出模型」。
      roles: () => (typeof registry?.list === 'function' ? registry.list() : []),
      probes: createDefaultProbes({
        ctx,
        resolveExecutable: async (/** @type {string} */ cli) => {
          try {
            if (!probe || typeof probe.probe !== 'function') return null
            const result = await probe.probe(cli)
            return result && typeof result.path === 'string' && result.path ? result.path : null
          } catch {
            return null
          }
        },
      }),
    })

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
   *
   * `cliStates`（P0-S2）提供时，`cli` 改为「偏好 + preflight」视图，并额外给出
   * `cliPreferences`（显式偏好投影）。未提供时保持旧形状，避免破坏旧消费者。
   *
   * @param {any[] | null} cli 原始 probe 结果（旧路径）
   * @param {string | null} cliError
   * @param {any[] | null} [states] 已合并偏好 + preflight 的 CLI 状态
   */
  function globalView(cli, cliError, states = null) {
    const source = config && typeof config === 'object' ? config : {}
    const usingStates = Array.isArray(states)
    // B2b：4 CLI 能力目录（动态发现 > 静态已知表 > unknown），GUI 的唯一能力来源。
    const capabilitySnapshot = capabilityCatalog.snapshot()
    return {
      defaultRoleId: typeof source.defaultRoleId === 'string' ? source.defaultRoleId : '',
      dispatchNotes: typeof source.dispatchNotes === 'string' ? source.dispatchNotes : '',
      projectConfigFile:
        typeof source.projectConfigFile === 'string' && source.projectConfigFile
          ? source.projectConfigFile
          : '.meetingstone.json',
      limits: limitsView(source.limits),
      channels: Array.isArray(channels) ? channels.map(channelDetailView) : [],
      capabilities: capabilitySnapshot.capabilities,
      capabilitiesRefreshedAt: capabilitySnapshot.refreshedAt,
      capabilitiesErrors: capabilitySnapshot.errors,
      cli: usingStates ? states.map(cliStateView) : Array.isArray(cli) ? cli.map(cliView) : null,
      // 只有新路径才追加，旧快照的 deepEqual 契约保持不变。
      ...(usingStates
        ? {
            cliPreferences: Object.fromEntries(
              states.map((state) => [
                String(state?.cli ?? ''),
                state?.userPreference === 'enabled' || state?.userPreference === 'disabled'
                  ? state.userPreference
                  : 'unset',
              ]),
            ),
          }
        : {}),
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
    let states = null
    if (typeof cliStates === 'function') {
      // P0-S2 路径：偏好 + preflight 一次算完，避免再单独 probe 一遍。
      try {
        const results = await withTimeout(cliStates(), CLI_PROBE_TIMEOUT_MS)
        if (Array.isArray(results)) states = results
        else cliError = 'CLI_PREFLIGHT_TIMEOUT'
      } catch (error) {
        cliError = error instanceof Error ? error.message : String(error)
      }
    } else if (probe && typeof probe.probeAll === 'function') {
      try {
        const results = await withTimeout(probe.probeAll(), CLI_PROBE_TIMEOUT_MS)
        if (Array.isArray(results)) cli = results
        else cliError = 'CLI_PROBE_TIMEOUT'
      } catch (error) {
        cliError = error instanceof Error ? error.message : String(error)
      }
    }
    return { ...snapshot(), global: globalView(cli, cliError, states) }
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
 * @param {{ snapshot: () => any, configApi?: any }} deps
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
    const configApi = deps.configApi && typeof deps.configApi === 'object' ? deps.configApi : null

    /**
     * 把 `deriveCliState` 的结果转成 Remote 可透传的视图。
     * @param {string} cli
     * @param {any} preflight
     */
    function cliStateOf(cli, preflight) {
      const preference = configApi && typeof configApi.getCliPreference === 'function'
        ? configApi.getCliPreference(cli)
        : null
      const state = deriveCliState({
        cli,
        preference: preference?.ok === true ? preference.preference : 'unset',
        preflight,
      })
      return cliStateView(state)
    }

    class MeetingStoneGuiRemote extends TypertRemoteService {
      constructor(context) {
        super(context, GUI_REMOTE_SERVICE)
      }

      /** 只读快照：不被调用的参数、无副作用；每次调用重新投影。 */
      async list() {
        return deps.snapshot()
      }




      /**
       * 开关外部 CLI（strict：cli/enabled）。
       * 开启前强制 preflight；失败时**不写配置**（保持关闭），并把人工步骤一并返回。
       */
      async setCliEnabled(cli, enabled) {
        if (!configApi || typeof configApi.setCliEnabled !== 'function') {
          throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '配置远程未装配')
        }
        const result = await configApi.setCliEnabled(cli, enabled)
        // 只有真正跑过 preflight 才回传派生状态；关闭/幂等没有新证据，不回传假 ready。
        const state = result && result.preflight ? cliStateOf(cli, result.preflight) : null
        return { ...result, state }
      }

      /**
       * 重新检测一个 CLI（strict：cli/force）。
       *
       * 两类 CLI 语义不同（B2b 起 CLI 扩到 4 个，其中 `dsh` 是宿主内置、不是外部 CLI）：
       * - **外部 CLI**（codex / codebuddy / claude）：先 preflight（只读证据，不写配置），
       *   再刷新该 CLI 的能力缓存；
       * - **`dsh`（DeepSeek Harness，in-process）**：没有外部可执行文件，"检测"没有意义，
       *   因此**跳过 preflight**，只刷新能力目录（模型来自宿主 `ctx.llm.listModels()`）。
       *   这与设置页「刷新能力」按钮的实际意图一致：它要的是模型/强度，不是安装状态。
       *
       * 旧实现对所有 cli 一律走 preflight，导致 `refreshCli('dsh')` 被
       * `isKnownCli` 判为 `INVALID_CLI` 而必然失败（D1 验收缺陷 1 成因 A）。
       */
      async refreshCli(cli, force) {
        if (!configApi || typeof configApi.preflightCli !== 'function') {
          throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '配置远程未装配')
        }
        const capabilityRefresh = await capabilityCatalog.refresh(cli, { force: true })
        // dsh：宿主内置通道，无外部 CLI 可 preflight；只回能力目录。
        if (cli === 'dsh') {
          return {
            ok: true,
            cli: null,
            capabilities: capabilityCatalog.snapshot().capabilities,
            capabilityRefresh,
          }
        }
        const checked = await configApi.preflightCli(cli, { force: force === true })
        if (!checked || checked.ok !== true) return checked
        return {
          ok: true,
          cli: cliStateOf(cli, checked.preflight),
          capabilities: capabilityCatalog.snapshot().capabilities,
          capabilityRefresh,
        }
      }

      /**
       * 改全局角色的字段（strict：roleId/patch）。
       * 只走 S2 的 global writer（profile patch，保留未知字段）；前端负责二次确认。
       */
      async updateGlobalRole(roleId, patch) {
        if (!configApi || typeof configApi.updateGlobalRole !== 'function') {
          throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '配置远程未装配')
        }
        return configApi.updateGlobalRole(roleId, patch)
      }

      /**
       * 新增一个全局角色（strict：role）。
       * 与 updateGlobalRole 共用 global writer / configEditor.edit；失败原样返回错误码。
       */
      async createGlobalRole(role) {
        if (!configApi || typeof configApi.createGlobalRole !== 'function') {
          throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '配置远程未装配')
        }
        return configApi.createGlobalRole(role)
      }

      /**
       * 删除一个全局角色（strict：roleId）。
       * 只删 profile 全局定义；会话覆盖记录不清理（前端二次确认并提示）。
       */
      async deleteGlobalRole(roleId) {
        if (!configApi || typeof configApi.deleteGlobalRole !== 'function') {
          throw new RemoteError('MEETINGSTONE_GUI_REMOTE_UNAVAILABLE', '配置远程未装配')
        }
        return configApi.deleteGlobalRole(roleId)
      }
    }
    for (const method of GUI_REMOTE_METHODS) {
      markRemoteMethod(MeetingStoneGuiRemote.prototype, method, Remote)
    }
    const instance = new MeetingStoneGuiRemote(ctx)

    // 真实 zod strict 契约（Host 定义）。失败只记日志，不影响上面的 SRC 服务。
    const strict = registerSessionStrictRemotes(ctx, {
      log: (level, line) => {
        const logger = ctx.logger
        if (logger && typeof logger[level] === 'function') logger[level](line)
        else if (level === 'error') console.error(line)
        else console.log(line)
      },
    })

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
  methods: GUI_REMOTE_METHODS,
})

export default registerGuiRemote
