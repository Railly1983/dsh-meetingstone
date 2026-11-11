// @ts-check
/**
 * CLI preflight（P0-S2）：在「开启外部 CLI」之前做一次**只读**检查。
 *
 * 边界（勿破坏）：
 * - **不做任何自动修复**：不安装、不登录、不改 PATH / 配置 / 权限、不写任何文件
 * - 只复用 `src/cli/probe.js`（`--version` + 多源路径解析），必要时可注入额外的
 *   宿主集成 / 登录证据检查；**拿不到证据就是 `unknown`，不猜 ready**
 * - 分类只来自真实证据（probe 的 `blockedReason`、注入检查的布尔值）
 *
 * 三层证据：
 * 1. `installed` / `version`：probe 是否找到并跑通 `--version`
 * 2. `hostIntegration`：宿主是否注册了对应 provider（`ctx.subagents.getProvider`）
 * 3. `login`：可选的登录/授权证据；**当前生产没有可靠来源**，缺省为 `unknown`
 *
 * `ready` 策略：
 * - probe 失败 → `blocked`（分类透传：未安装 / 权限 / 路径 / 启动失败…）
 * - 宿主集成明确不可用 → `blocked`
 * - 登录证据明确为 false → `blocked`（需要登录）
 * - 宿主集成没有证据 → `unknown`（不伪造 ready）
 * - 其余 → `ready`；登录未知时**仍标记 `login:'unknown'`**，由调用方决定是否展示，
 *   不声称「已登录」。
 *
 * 这些规则对应 Kimi 拆解 §B「installed 不等于已登录或 ready」与 §C P0-S2 的
 * 「失败分类/人工步骤/重检，不做自动修复」。
 */

import { CLI_NAMES, CLI_PROVIDER } from './preferences.js'
import { CLI_SPECS, PROBE_FAILURES } from './probe.js'

/** preflight 总体状态。 */
export const PREFLIGHT_STATUS = Object.freeze({
  READY: 'ready',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
})

/** 失败分类（与 probe 的 `PROBE_FAILURES` 合并；多一个「证据不足」）。 */
export const PREFLIGHT_REASONS = Object.freeze({
  ...PROBE_FAILURES,
  HOST_INTEGRATION_DISABLED: 'host-integration-disabled',
  EVIDENCE_MISSING: 'evidence-missing',
})

/** 每类失败的人工步骤（只提示，不执行）。 */
export const PREFLIGHT_MANUAL_STEPS = Object.freeze({
  [PREFLIGHT_REASONS.NOT_INSTALLED]: [
    '安装对应 CLI（本项目不自动安装）',
    '安装后点「重新检测」；本项目不改 PATH、不写安装目录',
  ],
  [PREFLIGHT_REASONS.LOGIN_REQUIRED]: [
    '在该 CLI 中完成登录/授权（本项目不代登录、不读取凭据）',
    '完成后点「重新检测」',
  ],
  [PREFLIGHT_REASONS.HOST_INTEGRATION_DISABLED]: [
    '在 DSH 插件/Provider 设置中启用该 CLI 对应的 provider（本项目不自动改宿主配置）',
    '重载插件后点「重新检测」',
  ],
  [PREFLIGHT_REASONS.PERMISSION_DENIED]: [
    '用当前 Windows 账号为 CLI 可执行文件补上读取/执行权限（本项目不提升权限、不改 ACL）',
    '完成后点「重新检测」',
  ],
  [PREFLIGHT_REASONS.PATH_INVALID]: [
    '检查 CLI 是否被移动、删除或升级换了路径（本项目不改 PATH）',
    '修复后点「重新检测」',
  ],
  [PREFLIGHT_REASONS.STARTUP_FAILED]: [
    '手动运行 `<cli> --version` 查看报错（本项目不自动修复）',
    '修复后点「重新检测」',
  ],
  [PREFLIGHT_REASONS.EVIDENCE_MISSING]: [
    '点「重新检测」获取最新证据',
    '确认宿主已注册对应 provider；无法确认的状态不会当作 ready',
  ],
  [PREFLIGHT_REASONS.UNKNOWN_CLI]: ['只支持 codex / codebuddy / claude'],
})

/** 可以重检的分类：`unknown-cli` 不是运行环境问题，重检无意义。 */
const NON_RETRYABLE = new Set([PREFLIGHT_REASONS.UNKNOWN_CLI])

/** @param {unknown} cli */
function labelOf(cli) {
  const spec = /** @type {Record<string, any>} */ (CLI_SPECS)[String(cli)]
  return typeof spec?.label === 'string' ? spec.label : String(cli)
}

/** @param {unknown} reason */
function normalizeReason(reason) {
  const value = typeof reason === 'string' ? reason : ''
  return Object.values(PREFLIGHT_REASONS).includes(/** @type {any} */ (value))
    ? value
    : PREFLIGHT_REASONS.EVIDENCE_MISSING
}

/**
 * 调用一个可能返回 `true | false | undefined` 的证据检查。
 * 抛错/超时都按 `undefined`（未知）处理，绝不当成 true。
 *
 * @param {((cli: string) => any) | undefined} check
 * @param {string} cli
 * @returns {Promise<boolean | undefined>}
 */
async function runCheck(check, cli) {
  if (typeof check !== 'function') return undefined
  try {
    const value = await check(cli)
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 创建 preflight。`probe` 必须提供 `probe(cli, {force})`。
 *
 * @param {{
 *   probe: { probe: (cli: string, opts?: any) => Promise<any> },
 *   hostIntegration?: (cli: string) => boolean | undefined | Promise<boolean | undefined>,
 *   login?: (cli: string) => boolean | undefined | Promise<boolean | undefined>,
 *   now?: () => number,
 * }} deps
 */
export function createPreflight(deps) {
  const probe = deps?.probe
  const hostIntegration = deps?.hostIntegration
  const login = deps?.login
  const now = deps?.now ?? (() => Date.now())

  if (!probe || typeof probe.probe !== 'function') {
    throw new TypeError('createPreflight 需要 probe.probe(cli, opts)')
  }

  /**
   * 检查单个 CLI。
   * @param {string} cli
   * @param {{ force?: boolean }} [opts]
   */
  async function check(cli, opts = {}) {
    const known = typeof cli === 'string' && CLI_NAMES.includes(cli)
    if (!known) {
      return {
        cli: String(cli),
        label: labelOf(cli),
        installed: false,
        version: null,
        path: null,
        source: null,
        ready: PREFLIGHT_STATUS.BLOCKED,
        blockedReason: PREFLIGHT_REASONS.UNKNOWN_CLI,
        retryable: false,
        autoFix: false,
        manualSteps: [...PREFLIGHT_MANUAL_STEPS[PREFLIGHT_REASONS.UNKNOWN_CLI]],
        login: 'unknown',
        hostIntegration: 'unknown',
        notes: [],
        checkedAt: now(),
      }
    }

    const probed = await probe.probe(cli, opts)
    const installed = probed?.installed === true
    const notes = Array.isArray(probed?.notes) ? probed.notes.map(String) : []
    const base = {
      cli,
      label: labelOf(cli),
      provider: CLI_PROVIDER[cli] ?? null,
      installed,
      version: typeof probed?.version === 'string' ? probed.version : null,
      path: typeof probed?.path === 'string' ? probed.path : null,
      source: typeof probed?.source === 'string' ? probed.source : null,
      notes,
      checkedAt: now(),
      autoFix: false,
    }

    /** @type {{ status: string, reason: string | null, login: any, hostIntegration: any }} */
    let verdict = { status: PREFLIGHT_STATUS.BLOCKED, reason: null, login: 'unknown', hostIntegration: 'unknown' }

    if (!installed) {
      verdict = {
        status: PREFLIGHT_STATUS.BLOCKED,
        reason: normalizeReason(probed?.blockedReason ?? PREFLIGHT_REASONS.NOT_INSTALLED),
        login: 'unknown',
        hostIntegration: 'unknown',
      }
    } else {
      // probe 只证明「可启动」；继续查宿主集成与登录证据。
      const host = await runCheck(hostIntegration, cli)
      const auth = await runCheck(login, cli)
      verdict = {
        status: PREFLIGHT_STATUS.READY,
        reason: null,
        login: auth === true ? true : auth === false ? false : 'unknown',
        hostIntegration: host === true ? true : host === false ? false : 'unknown',
      }

      if (host === false) {
        verdict.status = PREFLIGHT_STATUS.BLOCKED
        verdict.reason = PREFLIGHT_REASONS.HOST_INTEGRATION_DISABLED
      } else if (auth === false) {
        verdict.status = PREFLIGHT_STATUS.BLOCKED
        verdict.reason = PREFLIGHT_REASONS.LOGIN_REQUIRED
      } else if (host !== true) {
        // 宿主集成没有正向证据：不伪造 ready。
        verdict.status = PREFLIGHT_STATUS.UNKNOWN
        verdict.reason = PREFLIGHT_REASONS.EVIDENCE_MISSING
      }
    }

    const reason = verdict.reason ? normalizeReason(verdict.reason) : null
    return {
      ...base,
      ready: verdict.status,
      blockedReason: reason,
      retryable: reason === null ? false : !NON_RETRYABLE.has(reason),
      autoFix: false,
      manualSteps: reason ? [...(PREFLIGHT_MANUAL_STEPS[reason] ?? PREFLIGHT_MANUAL_STEPS[PREFLIGHT_REASONS.EVIDENCE_MISSING])] : [],
      login: verdict.login,
      hostIntegration: verdict.hostIntegration,
    }
  }

  /**
   * 检查全部外部 CLI（顺序与 `CLI_NAMES` 一致）。
   * @param {{ force?: boolean }} [opts]
   */
  async function checkAll(opts = {}) {
    /** @type {any[]} */
    const out = []
    for (const cli of CLI_NAMES) out.push(await check(cli, opts))
    return out
  }

  return { check, checkAll }
}

export { CLI_NAMES, CLI_PROVIDER, PROBE_FAILURES }
