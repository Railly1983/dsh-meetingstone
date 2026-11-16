// @ts-check
/**
 * 角色状态模型（P0-S1）：偏好 / 就绪 / 额度 三字段 + 两色派生（绿 / 灰）。
 *
 * 边界（勿破坏）：
 * - 纯函数：不读文件、不探测 CLI、不写盘；所有输入由调用方注入
 * - **不伪造状态**：拿不到证据一律 `unknown`，绝不默认 `ready` / `available`
 * - `userPreference` 只看三级配置里**显式**写过的 `enabled`；schema 默认值
 *   （RoleSchema 的 `enabled: true`）必须映射为 `unset`，不能当成用户偏好
 * - `quota` 在 V1 没有可靠额度源 → 默认 `unknown`；只有按量付费角色可
 *   `not_applicable`。**不得**用 429 / refusal / `failureClass=quota` 推断
 *   `exhausted`——那是失败分类，不是额度事实（docs/efficiency.md §失败分类）
 *
 * 颜色语义（**V1 两色**，2026-11-12 唐僧裁决）：
 * - 灰：`userPreference=disabled` 或 `readiness!=ready`
 * - 绿：非 disabled + ready。**不声明额度充足，也不表示实时额度。**
 *
 * 黄色与 `quota=exhausted` 已删除：宿主没有额度查询 API，
 * 用 `failureClass=quota` 推断颜色会把「历史某次失败」伪装成「当前无额度」，
 * 违反「额度未知不得伪装」的边界。
 * 见 `docs/plan/2026-11-12-yellow-state-verdict.md`。
 *
 * `availability` 是旧字段的兼容投影，取值仍是
 * `disabled | ambiguous | available | provider-unavailable | unknown`，
 * 供 `meetingstone_list_roles` / 自动路由等旧调用方继续使用。
 */

import { CHANNEL_KINDS } from '../roles/registry.js'
import { buildCliCapabilities, effortOptionsFor, modelOptionsFor } from '../roles/capabilities.js'
import { fieldSource } from '../session/config.js'

/** 用户偏好：来自显式 enabled 配置；默认值 -> unset。 */
export const USER_PREFERENCE = Object.freeze({
  UNSET: 'unset',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
})

/** 运行时就绪：角色配置完整 + 有效通道 + provider 可用。 */
export const READINESS = Object.freeze({
  READY: 'ready',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
})

/**
 * 额度状态：V1 默认 unknown，不做任何推断。
 *
 * **2026-11-12 裁决（唐僧，用户授权）**：删除 `EXHAUSTED`。
 * 宿主没有额度查询 API，只有错误分类常量（`QUOTA_EXCEEDED_CODE` 等）与
 * `isQuotaExceededError()` —— 那是**失败诊断**，不是余额事实。
 * 见 `docs/plan/2026-11-12-yellow-state-verdict.md`。
 */
export const QUOTA = Object.freeze({
  AVAILABLE: 'available',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable',
})

/**
 * 角色颜色语义：**V1 只有两色**。
 *
 * 2026-11-12 裁决：取消黄色及「确认无额度」的产品承诺。
 * 原因：没有可信的实时额度源；用 `failureClass=quota` 推断颜色会让
 * 「历史某次失败」伪装成「当前无额度」，违反「额度未知不得伪装」的边界。
 *
 * 语义：
 * - 绿 = 未关闭且依赖就绪。**不声明额度充足，也不表示实时额度。**
 * - 灰 = 已关闭，或依赖阻断 / 就绪状态未知。
 *
 * 未来只有取得可信、实时的额度事实源，才可重新评审第三色。
 */
export const ROLE_COLOR = Object.freeze({
  GRAY: 'gray',
  GREEN: 'green',
})

/** 颜色的中文标签（展示层可直接用，避免各处硬编码）。 */
export const ROLE_COLOR_LABEL = Object.freeze({
  gray: '灰',
  green: '绿',
})

/** 旧 availability 的合法取值（保持与 src/dsh/register.js 的枚举一致）。 */
export const LEGACY_AVAILABILITY = Object.freeze([
  'disabled',
  'ambiguous',
  'available',
  'provider-unavailable',
  'unknown',
])

const USER_PREFERENCE_VALUES = Object.freeze(Object.values(USER_PREFERENCE))
const READINESS_VALUES = Object.freeze(Object.values(READINESS))
const QUOTA_VALUES = Object.freeze(Object.values(QUOTA))

/**
 * kind -> 宿主 `ctx.subagents` 注册名。
 * 与 src/dsh/adapter.js 的 `PROVIDER_BY_KIND` 保持一致（测试会断言两者相同）。
 */
export const DEFAULT_PROVIDER_BY_KIND = Object.freeze({
  'in-process': 'spawn',
  'acp-cli': 'acp',
  codex: 'codex',
  'claude-code': 'claude-code',
})

/** 就绪判定失败/成功的证据码（稳定字符串，便于日志与测试）。 */
export const READINESS_REASON = Object.freeze({
  AVAILABLE: 'PROVIDER_AVAILABLE',
  ROLE_INVALID: 'ROLE_INVALID',
  CHANNEL_MISSING: 'CHANNEL_MISSING',
  CHANNEL_KIND_INVALID: 'CHANNEL_KIND_INVALID',
  PROVIDER_MISSING: 'PROVIDER_MISSING',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  AMBIGUOUS: 'AMBIGUOUS',
  EVIDENCE_MISSING: 'PROVIDER_EVIDENCE_MISSING',
})

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** @param {any} role */
function roleIdOf(role) {
  return role && typeof role.roleId === 'string' ? role.roleId : ''
}

/**
 * 解析角色实际要查询的 provider 名：显式 `channel.provider` 优先，
 * 否则按 kind 取宿主的注册名。
 * @param {any} role
 * @returns {string | null}
 */
function providerFor(role) {
  const channel = role && typeof role === 'object' ? role.channel : null
  if (!channel || typeof channel !== 'object') return null
  if (typeof channel.provider === 'string' && channel.provider.trim()) {
    return channel.provider.trim()
  }
  if (typeof channel.kind !== 'string') return null
  return /** @type {Record<string, string>} */ (DEFAULT_PROVIDER_BY_KIND)[channel.kind] ?? null
}

/**
 * 查询 provider 是否注册在宿主上。
 * 返回值：true=可用，false=不可用，undefined=没有查询能力 / 查询失败。
 *
 * 2026-11-16（用户裁决）：回到官方语义 —— provider 必须真实注册。
 * codex 的模型固定在 provider 配置行上（官方不支持按任务选模型），
 * 因此「角色声明的 provider 名没有对应配置行」就是真不可用（开关变灰是正确反馈，
 * 用户按官方方式补一行配置即可），不再用克隆机制掩饰。
 *
 * @param {string} provider
 * @param {any} ctx
 * @returns {boolean | undefined}
 */
function providerEvidence(provider, ctx) {
  if (typeof ctx?.isProviderAvailable === 'function') {
    try {
      const result = ctx.isProviderAvailable(provider)
      return typeof result === 'boolean' ? result : undefined
    } catch {
      return undefined
    }
  }

  let subagents = null
  try {
    subagents = ctx?.subagents ?? null
  } catch {
    subagents = null // 未 inject 时访问会抛，按"未知"处理
  }
  if (subagents && typeof subagents.getProvider === 'function') {
    try {
      return Boolean(subagents.getProvider(provider))
    } catch {
      return undefined
    }
  }

  // 调用方已用旧实现算过 availability：只把它当作 provider 证据，
  // 不把 disabled / ambiguous 混进 readiness（那是偏好/解析问题）。
  if (ctx?.availability === 'available') return true
  if (ctx?.availability === 'provider-unavailable') return false
  return undefined
}

/**
 * 判定用户偏好。
 *
 * @param {any} role 生效角色（可来自注册表或三层解析）
 * @param {{ sources?: any }} [ctx] `{ sources: resolveEffectiveConfig(...).sources }`
 * @returns {'unset' | 'enabled' | 'disabled'}
 */
export function deriveUserPreference(role, ctx = {}) {
  // enabled=false 只可能来自显式配置（schema 默认是 true），直接承认。
  if (role?.enabled === false) return USER_PREFERENCE.DISABLED

  const source = fieldSource(ctx.sources, roleIdOf(role), 'enabled')
  // 来源缺失或为 default：schema 默认值 ≠ 用户偏好。
  if (source === 'default') return USER_PREFERENCE.UNSET
  if (!source || !['global', 'project', 'session'].includes(source)) return USER_PREFERENCE.UNSET
  return USER_PREFERENCE.ENABLED
}

/**
 * 判定运行时就绪。
 *
 * 检查顺序固定：角色形状 → 通道 → provider → 解析歧义 → provider 证据。
 * 任何一步缺证据就返回 unknown，不猜 ready。
 *
 * @param {any} role
 * @param {any} [ctx]
 * @returns {{ readiness: 'ready' | 'blocked' | 'unknown', reason: string }}
 */
export function inspectReadiness(role, ctx = {}) {
  if (!isPlainObject(role)) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.ROLE_INVALID }
  }
  if (!roleIdOf(role) || !role.roleId.trim()) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.ROLE_INVALID }
  }
  if (typeof role.name !== 'string' || !role.name.trim()) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.ROLE_INVALID }
  }

  const channel = role.channel
  if (!isPlainObject(channel)) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.CHANNEL_MISSING }
  }
  if (!CHANNEL_KINDS.includes(/** @type {any} */ (channel.kind))) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.CHANNEL_KIND_INVALID }
  }

  const provider = providerFor(role)
  if (!provider) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.PROVIDER_MISSING }
  }
  if (role.ambiguous === true) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.AMBIGUOUS }
  }

  const evidence = providerEvidence(provider, ctx)
  if (evidence === true) return { readiness: READINESS.READY, reason: READINESS_REASON.AVAILABLE }
  if (evidence === false) {
    return { readiness: READINESS.BLOCKED, reason: READINESS_REASON.PROVIDER_UNAVAILABLE }
  }
  return { readiness: READINESS.UNKNOWN, reason: READINESS_REASON.EVIDENCE_MISSING }
}

/**
 * 判定的简写形式。
 * @param {any} role
 * @param {any} [ctx]
 * @returns {'ready' | 'blocked' | 'unknown'}
 */
export function deriveReadiness(role, ctx = {}) {
  return inspectReadiness(role, ctx).readiness
}

/**
 * 判定额度状态。
 *
 * V1 生产环境不注入 `ctx.quota`，因此结果为 unknown；按量付费角色可标
 * not_applicable。显式注入的 `ctx.quota` 会被采纳；但 `quotaSource` 为
 * `failure` / `inferred` / `guess` / `estimated` 时一律拒绝，从机制上防止把
 * 429、refusal 或 `failureClass=quota` 误当额度事实。
 *
 * @param {any} role
 * @param {any} [ctx]
 * @returns {'available' | 'unknown' | 'not_applicable'}（`exhausted` 已删除）
 */
export function deriveQuota(role, ctx = {}) {
  const rejectedSources = ['failure', 'inferred', 'guess', 'estimated']
  if (!rejectedSources.includes(ctx?.quotaSource) && QUOTA_VALUES.includes(ctx?.quota)) {
    return /** @type {any} */ (ctx.quota)
  }

  const billing = ctx?.billingMode ?? role?.billingMode
  if (billing === 'pay-as-you-go' || billing === 'payg') return QUOTA.NOT_APPLICABLE
  return QUOTA.UNKNOWN
}

/**
 * 两色派生（纯函数，矩阵可穷举）。
 *
 * **2026-11-12 裁决**：V1 只有绿 / 灰。黄色与 `quota=exhausted` 已删除 ——
 * 没有可信的实时额度源，用失败记录推断颜色会把「历史某次失败」
 * 伪装成「当前无额度」。
 *
 * `quota` 参数仍保留（调用方可能传），但**不再影响颜色** ——
 * 它只作为诊断信息存在，绝不参与状态投影。
 *
 * @param {{ userPreference: string, readiness: string, quota?: string }} state
 * @returns {'gray' | 'green'}
 */
export function deriveRoleColor({ userPreference, readiness } = /** @type {any} */ ({})) {
  // 2026-11-16（用户裁决）：**颜色只反映开关**。
  //
  // 用户原话：「只有开关两个状态就行吧，为什么要设 打开-但灰色不可用 这个状态」。
  //
  // 之前的实现是「禁用 或 readiness!=ready 都判灰」，导致配置正确但 provider
  // 名对不上时显示成灰色 —— 那是我自己发明的状态，会给用户错误暗示
  // （「角色坏了」），而实际上派单才知道能不能跑。
  //
  // 现在的语义：开关打开 = 绿，关闭 = 灰。能不能跑由派单结果如实反馈。
  if (userPreference === USER_PREFERENCE.DISABLED) return ROLE_COLOR.GRAY
  return ROLE_COLOR.GREEN
}

/**
 * 旧 `availability` 字段的兼容投影。
 *
 * 取值域保持 `disabled | ambiguous | available | provider-unavailable | unknown`，
 * 但**从新状态推导**而不是回抄旧值：这样 blocked/unknown 永远不会被投影成
 * available，避免旧字段与三色语义互相矛盾。调用方传入的旧 availability 只作为
 * provider 证据参与 readiness 判定（见 providerEvidence）。
 *
 * @param {any} role
 * @param {string} userPreference
 * @param {string} readiness
 * @param {string} reason
 * @param {any} ctx
 */
function legacyAvailability(role, userPreference, readiness, reason) {
  if (userPreference === USER_PREFERENCE.DISABLED) return 'disabled'
  if (role?.ambiguous === true) return 'ambiguous'
  if (readiness === READINESS.READY) return 'available'
  if (reason === READINESS_REASON.PROVIDER_UNAVAILABLE) return 'provider-unavailable'
  return 'unknown'
}

/**
 * 派生角色视图：三字段 + 颜色 + 旧 availability 投影。
 *
 * 返回值全部是字符串，保证可以进 Remote 的无损 JSON。
 *
 * @param {any} role
 * @param {any} [ctx] 可含 `sources` / `subagents` / `availability` / `quota` 等证据
 * @returns {{
 *   roleId: string,
 *   name: string,
 *   userPreference: 'unset' | 'enabled' | 'disabled',
 *   readiness: 'ready' | 'blocked' | 'unknown',
 *   readinessReason: string,
 *   quota: 'available' | 'unknown' | 'not_applicable',
 *   color: 'gray' | 'green',
 *   availability: string,
 * }}
 */
export function deriveRoleView(role, ctx = {}) {
  const state = ctx && typeof ctx === 'object' ? ctx : {}
  const userPreference = deriveUserPreference(role, state)
  const { readiness, reason } = inspectReadiness(role, state)
  const quota = deriveQuota(role, state)
  const color = deriveRoleColor({ userPreference, readiness, quota })

  return {
    roleId: roleIdOf(role),
    name: role && typeof role.name === 'string' ? role.name : '',
    userPreference,
    readiness,
    readinessReason: reason,
    quota,
    color,
    availability: legacyAvailability(role, userPreference, readiness, reason),
  }
}

/** 供测试/诊断确认枚举没有漂移。 */
export const STATE_MODEL_VALUES = Object.freeze({
  userPreference: USER_PREFERENCE_VALUES,
  readiness: READINESS_VALUES,
  quota: QUOTA_VALUES,
})

// ─── B2：角色编辑器的「CLI → 模型 → 思考强度」联动（PDF 第 2 条） ──────────────
//
// 用户只面对 CLI/模型/强度；选项只来自已配置的执行组合（channels），
// 没有声明的项标记「不支持」，不伪造能力。

/**
 * CLI 能力矩阵（给编辑器渲染下拉用）。
 * @param {any[]} channels
 * @returns {ReturnType<typeof buildCliCapabilities>}
 */
export function deriveCliOptions(channels = []) {
  return buildCliCapabilities(channels)
}

/**
 * 某 CLI 的模型选项（只来自已配置组合）。
 * @param {string} cli
 * @param {any[]} channels
 * @returns {string[]}
 */
export function deriveModelOptions(cli, channels = []) {
  return modelOptionsFor(cli, channels)
}

/**
 * 某 CLI（+模型）的思考强度选项；`supported=false` 表示当前组合不支持。
 * @param {string} cli
 * @param {string | null | undefined} model
 * @param {any[]} channels
 */
export function deriveEffortOptions(cli, model, channels = []) {
  return effortOptionsFor(cli, model, channels)
}

/**
 * 角色编辑器的字段视图：单一「设定」+ CLI/模型/强度（不再暴露「通道」）。
 * @param {any} role
 * @param {any[]} channels
 */
export function deriveRoleEditorFields(role, channels = []) {
  const channel = role && typeof role === 'object' && role.channel && typeof role.channel === 'object' ? role.channel : {}
  const cli = typeof channel.kind === 'string' ? channel.kind : ''
  const model = typeof channel.model === 'string' ? channel.model : ''
  const effort = typeof channel.reasoning === 'string' ? channel.reasoning : ''
  const setting =
    typeof role?.setting === 'string' && role.setting
      ? role.setting
      : typeof role?.prompt === 'string' && role.prompt
        ? role.prompt
        : typeof role?.description === 'string'
          ? role.description
          : ''
  return {
    setting,
    cli,
    model,
    effort,
    models: deriveModelOptions(cli, channels),
    efforts: deriveEffortOptions(cli, model, channels),
  }
}
