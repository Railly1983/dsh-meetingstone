// @ts-check
/**
 * 外部 CLI 的**显式用户偏好**（P0-S2）与「偏好 × 就绪」派生。
 *
 * 配置形状（插件全局配置 `src/config.js`）：
 *
 * ```yaml
 * cliPreferences:
 *   codex: true        # 用户显式开启
 *   codebuddy: false   # 用户显式关闭（持久化，重启/升级保持）
 *   # claude 缺失 = unset
 * ```
 *
 * 语义（与 Kimi 拆解 §B/§C P0-S2 一致）：
 * - **缺省 = unset**：没有显式记录，不等于关闭；第一次 preflight 通过时视为启用
 *   （只在派生层生效，**不写盘**，避免把默认值钉进 profile）。
 * - **enabled**：用户显式开启；仍要求 preflight 就绪，否则 UI 显示「启用意图保留」。
 * - **disabled**：用户显式关闭；持久化在 profile，重启/升级后保持。运行时故障
 *   **不得**把 enabled 回写成 false（那是另一条路径，本模块不会写任何东西）。
 *
 * 边界：
 * - 纯函数：不读文件、不探测、不写盘
 * - 只认布尔值：`true`/`false` 之外一律按 unset 处理，不猜
 * - 不把 `ready` 的来源混进偏好：`userPreference` 只来自配置
 */

/** 支持显式偏好的外部 CLI（与 `src/cli/probe.js` 的 `CLI_SPECS` 对齐）。 */
export const CLI_NAMES = Object.freeze(['codex', 'codebuddy', 'claude'])

/** 外部 CLI 对应的宿主 provider 注册名（用于 preflight 的宿主集成检查）。 */
export const CLI_PROVIDER = Object.freeze({
  codex: 'codex',
  codebuddy: 'acp',
  claude: 'claude-code',
})

/** 偏好取值。`unset` 在配置里表现为「键缺失」。 */
export const CLI_PREFERENCE = Object.freeze({
  UNSET: 'unset',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
})

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} cli */
export function isKnownCli(cli) {
  return typeof cli === 'string' && CLI_NAMES.includes(cli)
}

/**
 * 清洗配置里的 `cliPreferences`：只保留已知 CLI 的布尔值。
 *
 * 用于 `normalizeConfig()` 的**容错预处理**：手写配置里把值写成字符串时，
 * 不应该让整个角色表跟着配置一起回落到默认值。未知键 / 非法值直接丢弃。
 *
 * @param {unknown} raw
 * @returns {Record<string, boolean> | undefined} 非对象输入返回 undefined（调用方删除该键）
 */
export function sanitizeCliPreferences(raw) {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) return {}
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const cli of CLI_NAMES) {
    const value = /** @type {Record<string, unknown>} */ (raw)[cli]
    if (typeof value === 'boolean') out[cli] = value
  }
  return out
}

/**
 * 读一个 CLI 的显式偏好。
 *
 * 非法值（字符串、数字等）按 unset 处理：**不把脏数据猜成用户意图**。
 *
 * @param {any} config 已规范化的插件配置（含 `cliPreferences`）
 * @param {string} cli
 * @returns {'unset' | 'enabled' | 'disabled'}
 */
export function preferenceOf(config, cli) {
  if (!isKnownCli(cli)) return CLI_PREFERENCE.UNSET
  const prefs = isPlainObject(config) ? config.cliPreferences : undefined
  if (!isPlainObject(prefs)) return CLI_PREFERENCE.UNSET
  const value = /** @type {Record<string, unknown>} */ (prefs)[cli]
  if (value === true) return CLI_PREFERENCE.ENABLED
  if (value === false) return CLI_PREFERENCE.DISABLED
  return CLI_PREFERENCE.UNSET
}

/**
 * 生成一个只改 `cliPreferences[cli]` 的**新配置对象**。
 *
 * 关键：保留 `currentConfig` 里的所有未知顶层字段与其他 CLI 的偏好——
 * profile patch 是**整值替换**，少写一个字段就会把未来字段抹掉。
 *
 * @param {any} currentConfig 原始（未经 schema 裁剪）配置
 * @param {string} cli
 * @param {'enabled' | 'disabled' | 'unset'} preference
 * @returns {Record<string, any>} 新对象；不修改入参
 */
export function applyCliPreference(currentConfig, cli, preference) {
  if (!isKnownCli(cli)) {
    throw Object.assign(new Error(`未知的外部 CLI：${String(cli)}`), {
      code: 'CLI_PREFERENCE_INVALID_CLI',
    })
  }
  if (!Object.values(CLI_PREFERENCE).includes(/** @type {any} */ (preference))) {
    throw Object.assign(new Error(`非法的 CLI 偏好：${String(preference)}`), {
      code: 'CLI_PREFERENCE_INVALID_STATE',
    })
  }

  const current = isPlainObject(currentConfig) ? /** @type {Record<string, any>} */ (currentConfig) : {}
  /** @type {Record<string, any>} */
  const next = { ...current }
  /** @type {Record<string, unknown>} */
  const prefs = isPlainObject(current.cliPreferences)
    ? { .../** @type {Record<string, unknown>} */ (current.cliPreferences) }
    : {}

  if (preference === CLI_PREFERENCE.ENABLED) prefs[cli] = true
  else if (preference === CLI_PREFERENCE.DISABLED) prefs[cli] = false
  else delete prefs[cli]

  if (Object.keys(prefs).length === 0) delete next.cliPreferences
  else next.cliPreferences = prefs
  return next
}

/**
 * 偏好 × preflight 的派生状态。
 *
 * `userPreference` 只来自配置；`enabled` 是**生效开关**：
 * - 显式关闭 → false（无论 preflight 如何）
 * - 非关闭且 preflight ready → true（unset 的"首次检测通过"自动启用）
 * - 其他 → false，但 `userPreference=enabled` 仍保留"启用意图"（运行故障不回写）
 *
 * @param {{ cli: string, preference?: unknown, preflight?: any }} input
 */
export function deriveCliState({ cli, preference, preflight }) {
  const userPreference = Object.values(CLI_PREFERENCE).includes(/** @type {any} */ (preference))
    ? /** @type {'unset' | 'enabled' | 'disabled'} */ (preference)
    : CLI_PREFERENCE.UNSET
  const ready = preflight && typeof preflight === 'object' ? preflight.ready : undefined
  const readyState = ready === 'ready' || ready === 'blocked' || ready === 'unknown' ? ready : 'unknown'
  const enabled = userPreference !== CLI_PREFERENCE.DISABLED && readyState === 'ready'
  const blockedReason =
    readyState === 'ready'
      ? null
      : typeof preflight?.blockedReason === 'string' && preflight.blockedReason
        ? preflight.blockedReason
        : 'evidence-missing'

  return {
    cli,
    userPreference,
    enabled,
    ready: readyState,
    blockedReason,
    firstDetection: userPreference === CLI_PREFERENCE.UNSET && readyState === 'ready',
    retryable: preflight?.retryable === true,
    autoFix: false,
    manualSteps: Array.isArray(preflight?.manualSteps)
      ? preflight.manualSteps.map(String)
      : [],
    installed: preflight?.installed === true,
    version: typeof preflight?.version === 'string' ? preflight.version : null,
    path: typeof preflight?.path === 'string' ? preflight.path : null,
    source: typeof preflight?.source === 'string' ? preflight.source : null,
    login: preflight?.login === true || preflight?.login === false ? preflight.login : 'unknown',
    hostIntegration:
      preflight?.hostIntegration === true || preflight?.hostIntegration === false
        ? preflight.hostIntegration
        : 'unknown',
    notes: Array.isArray(preflight?.notes) ? preflight.notes.map(String) : [],
    checkedAt: typeof preflight?.checkedAt === 'number' ? preflight.checkedAt : null,
  }
}
