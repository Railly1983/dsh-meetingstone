// @ts-check
/**
 * 配置写 API 的 Host 侧业务层（P0-S2，**后端，不含 UI**）。
 *
 * 三类写入：
 * - 会话：`src/gui/session.js`（已有，P0-S0）
 * - 全局：`src/config/global-writer.js`（profile patch，经官方 `configEditor.edit`）
 * - 项目：`src/project/write.js`（`.meetingstone.json`，白名单 + 保留未知字段）
 *
 * 本模块把「CLI 显式偏好」与 preflight 串成一条强制门禁：
 * - 开启（false → true）必须先 preflight；`ready !== 'ready'` 时**不写任何配置**
 *   （保持关闭；若原本 unset 也不会被写成 disabled）
 * - 关闭立即写 `false`（持久化；运行故障是另一条路径，不会经这里回写）
 * - 已经是目标状态 → 幂等返回，不重复写
 *
 * 注意：P0-S2 只提供 Host 侧 API；strict Remote 端点留给 U1 接线（见 openIssues）。
 */

import { isValidRoleId } from '../roles/ids.js'
import {
  CLI_NAMES,
  CLI_PREFERENCE,
  deriveCliState,
  isKnownCli,
  preferenceOf,
} from '../cli/preferences.js'

/** 本层错误码（与底层 writer 的错误码区分：这里补充「门禁」语义）。 */
export const CLI_CONFIG_ERRORS = Object.freeze({
  INVALID_CLI: 'CLI_PREFERENCE_INVALID_CLI',
  INVALID_STATE: 'CLI_PREFERENCE_INVALID_STATE',
  PREFLIGHT_FAILED: 'CLI_PREFERENCE_PREFLIGHT_FAILED',
  WRITE_FAILED: 'CLI_PREFERENCE_WRITE_FAILED',
  INVALID_ROLE_ID: 'GLOBAL_CONFIG_INVALID_ROLE_ID',
  ROLE_WRITE_FAILED: 'GLOBAL_CONFIG_WRITE_FAILED',
  PROJECT_WRITE_FAILED: 'PROJECT_CONFIG_WRITE_FAILED',
})

/**
 * @param {{
 *   cfg: any,
 *   globalWriter?: { setCliPreference: Function, setRoleEnabled: Function, updateRole?: Function },
 *   projectWriter?: { update: Function, setRoleOverride?: Function },
 *   preflight?: { check: Function, checkAll: Function },
 * }} deps
 */
export function createConfigGuiApi({ cfg, globalWriter, projectWriter, preflight }) {
  /**
   * 本进程内的最新偏好覆盖。
   *
   * 生产环境里 profile 写入会触发插件重载并拿到新 `cfg`；但重载前（以及单测里）
   * `cfg` 仍是旧快照。这个 Map 只用于避免「刚写成功又按旧值判断」的假重复写，
   * 不落盘、不跨进程。
   * @type {Map<string, 'enabled' | 'disabled' | 'unset'>}
   */
  const localPreferences = new Map()

  /** @param {string} cli */
  function currentPreference(cli) {
    if (localPreferences.has(cli)) return /** @type {any} */ (localPreferences.get(cli))
    return preferenceOf(cfg, cli)
  }

  /** @param {string} cli @param {string} preference */
  function rememberPreference(cli, preference) {
    localPreferences.set(cli, /** @type {any} */ (preference))
  }

  /** @param {string} cli */
  function getCliPreference(cli) {
    if (!isKnownCli(cli)) {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_CLI, message: `未知的外部 CLI：${String(cli)}` }
    }
    return { ok: true, cli, preference: currentPreference(cli) }
  }

  /**
   * 读取所有外部 CLI 的「偏好 + preflight」派生状态。
   *
   * @param {{ force?: boolean }} [opts]
   */
  async function listCliStates(opts = {}) {
    const states = []
    for (const cli of CLI_NAMES) {
      const checked = await preflight.check(cli, opts)
      states.push(deriveCliState({ cli, preference: currentPreference(cli), preflight: checked }))
    }
    return states
  }

  /**
   * 只做检查，不写任何配置。
   * @param {string} cli
   * @param {{ force?: boolean }} [opts]
   */
  async function preflightCli(cli, opts = {}) {
    if (!isKnownCli(cli)) {
      return {
        ok: false,
        code: CLI_CONFIG_ERRORS.INVALID_CLI,
        message: `未知的外部 CLI：${String(cli)}`,
      }
    }
    const checked = await preflight.check(cli, opts)
    return { ok: true, preflight: checked }
  }

  /**
   * 用户开关一个外部 CLI。
   *
   * @param {string} cli
   * @param {boolean} enabled
   * @returns {Promise<any>}
   */
  async function setCliEnabled(cli, enabled) {
    if (!isKnownCli(cli)) {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_CLI, message: `未知的外部 CLI：${String(cli)}` }
    }
    if (typeof enabled !== 'boolean') {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_STATE, message: 'enabled 必须是布尔值' }
    }
    if (!globalWriter || typeof globalWriter.setCliPreference !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.WRITE_FAILED, message: '全局配置写入器不可用' }
    }

    const before = currentPreference(cli)

    // 关闭：立即持久化；不需要 preflight（关闭总是允许的）。
    if (enabled === false) {
      if (before === CLI_PREFERENCE.DISABLED) {
        return {
          ok: true,
          written: false,
          idempotent: true,
          preference: CLI_PREFERENCE.DISABLED,
          userPreference: CLI_PREFERENCE.DISABLED,
          enabled: false,
        }
      }
      const written = await globalWriter.setCliPreference(cli, CLI_PREFERENCE.DISABLED)
      if (!written?.ok) {
        return {
          ok: false,
          code: CLI_CONFIG_ERRORS.WRITE_FAILED,
          cause: written?.code ?? null,
          message: written?.message ?? '写 CLI 偏好失败',
          preference: before,
        }
      }
      rememberPreference(cli, CLI_PREFERENCE.DISABLED)
      return {
        ok: true,
        written: written.written === true,
        idempotent: written.written !== true,
        preference: CLI_PREFERENCE.DISABLED,
        userPreference: CLI_PREFERENCE.DISABLED,
        enabled: false,
        config: written.config,
      }
    }

    // 已经是开启：幂等返回，不重复写、不重复探测。
    if (before === CLI_PREFERENCE.ENABLED) {
      return {
        ok: true,
        written: false,
        idempotent: true,
        preference: CLI_PREFERENCE.ENABLED,
        userPreference: CLI_PREFERENCE.ENABLED,
        enabled: true,
      }
    }

    // 开启：强制 preflight；失败保持关闭，**不写 enabled**。
    if (!preflight || typeof preflight.check !== 'function') {
      return {
        ok: false,
        code: CLI_CONFIG_ERRORS.PREFLIGHT_FAILED,
        message: 'preflight 不可用，拒绝开启（不写配置）',
        preference: before,
        enabled: false,
        autoFix: false,
        manualSteps: [],
        retryable: true,
      }
    }
    /** @type {any} */
    let checked
    try {
      checked = await preflight.check(cli, { force: true })
    } catch (error) {
      // preflight 自己崩了也不能写 enabled；保持关闭并如实返回。
      return {
        ok: false,
        code: CLI_CONFIG_ERRORS.PREFLIGHT_FAILED,
        message: `preflight 执行失败，保持关闭：${error instanceof Error ? error.message : String(error)}`,
        preference: before,
        userPreference: before,
        enabled: false,
        blockedReason: 'evidence-missing',
        manualSteps: [],
        retryable: true,
        autoFix: false,
      }
    }
    if (checked?.ready !== 'ready') {
      return {
        ok: false,
        code: CLI_CONFIG_ERRORS.PREFLIGHT_FAILED,
        message: checked?.blockedReason
          ? `preflight 未通过（${checked.blockedReason}），保持关闭`
          : 'preflight 未通过，保持关闭',
        preference: before,
        userPreference: before,
        enabled: false,
        preflight: checked,
        blockedReason: checked?.blockedReason ?? 'evidence-missing',
        manualSteps: Array.isArray(checked?.manualSteps) ? checked.manualSteps : [],
        retryable: checked?.retryable === true,
        autoFix: false,
      }
    }

    const written = await globalWriter.setCliPreference(cli, CLI_PREFERENCE.ENABLED)
    if (!written?.ok) {
      return {
        ok: false,
        code: CLI_CONFIG_ERRORS.WRITE_FAILED,
        cause: written?.code ?? null,
        message: written?.message ?? '写 CLI 偏好失败',
        preference: before,
        preflight: checked,
      }
    }
    rememberPreference(cli, CLI_PREFERENCE.ENABLED)
    return {
      ok: true,
      written: written.written === true,
      idempotent: written.written !== true,
      preference: CLI_PREFERENCE.ENABLED,
      userPreference: CLI_PREFERENCE.ENABLED,
      enabled: true,
      preflight: checked,
      config: written.config,
    }
  }

  /**
   * 开/关一个全局角色（写 profile，保留未知字段）。
   * @param {string} roleId
   * @param {boolean} enabled
   */
  async function setGlobalRoleEnabled(roleId, enabled) {
    if (!isValidRoleId(roleId)) {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_ROLE_ID, message: `角色 id 不合法：${String(roleId)}` }
    }
    if (!globalWriter || typeof globalWriter.setRoleEnabled !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED, message: '全局配置写入器不可用' }
    }
    const result = await globalWriter.setRoleEnabled(roleId, enabled)
    if (!result?.ok) return { ...result, code: result?.code ?? CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED }
    return result
  }

  /**
   * 改一个全局角色的字段（字段级；`channel` 按字段合并）。
   * @param {string} roleId
   * @param {Record<string, any>} patch
   */
  async function updateGlobalRole(roleId, patch) {
    if (!isValidRoleId(roleId)) {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_ROLE_ID, message: `角色 id 不合法：${String(roleId)}` }
    }
    if (!globalWriter || typeof globalWriter.updateRole !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED, message: '全局配置写入器不可用' }
    }
    const result = await globalWriter.updateRole(roleId, patch)
    if (!result?.ok) return { ...result, code: result?.code ?? CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED }
    return result
  }

  /**
   * 新增一个全局角色（B1b；同一 global writer / configEditor.edit 路径）。
   * @param {Record<string, any>} role
   */
  async function createGlobalRole(role) {
    if (!globalWriter || typeof globalWriter.createRole !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED, message: '全局配置写入器不可用' }
    }
    const result = await globalWriter.createRole(role)
    if (!result?.ok) return { ...result, code: result?.code ?? CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED }
    return result
  }

  /**
   * 删除一个全局角色（B1b）。只删 profile 全局定义，不清理会话覆盖记录。
   * @param {string} roleId
   */
  async function deleteGlobalRole(roleId) {
    if (!isValidRoleId(roleId)) {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_ROLE_ID, message: `角色 id 不合法：${String(roleId)}` }
    }
    if (!globalWriter || typeof globalWriter.deleteRole !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED, message: '全局配置写入器不可用' }
    }
    const result = await globalWriter.deleteRole(roleId)
    if (!result?.ok) return { ...result, code: result?.code ?? CLI_CONFIG_ERRORS.ROLE_WRITE_FAILED }
    return result
  }

  /**
   * 写项目配置（白名单字段；保留未知字段）。
   * @param {string} projectRoot
   * @param {Record<string, any>} patch
   * @param {string} [fileName]
   */
  async function updateProjectConfig(projectRoot, patch, fileName) {
    if (!projectWriter || typeof projectWriter.update !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.PROJECT_WRITE_FAILED, message: '项目配置写入器不可用' }
    }
    const result = await projectWriter.update(projectRoot, patch, fileName)
    if (!result?.ok) return { ...result, code: result?.code ?? CLI_CONFIG_ERRORS.PROJECT_WRITE_FAILED }
    return result
  }

  /**
   * 改项目级角色覆盖。
   * @param {string} projectRoot
   * @param {string} roleId
   * @param {Record<string, any>} patch
   * @param {string} [fileName]
   */
  async function setProjectRoleOverride(projectRoot, roleId, patch, fileName) {
    if (!isValidRoleId(roleId)) {
      return { ok: false, code: CLI_CONFIG_ERRORS.INVALID_ROLE_ID, message: `角色 id 不合法：${String(roleId)}` }
    }
    if (!projectWriter || typeof projectWriter.setRoleOverride !== 'function') {
      return { ok: false, code: CLI_CONFIG_ERRORS.PROJECT_WRITE_FAILED, message: '项目配置写入器不可用' }
    }
    const result = await projectWriter.setRoleOverride(projectRoot, roleId, patch, fileName)
    if (!result?.ok) return { ...result, code: result?.code ?? CLI_CONFIG_ERRORS.PROJECT_WRITE_FAILED }
    return result
  }

  /** 同步视图：显式偏好（不触发探测）。 */
  function preferencesView() {
    /** @type {Record<string, string>} */
    const out = {}
    for (const cli of CLI_NAMES) out[cli] = currentPreference(cli)
    return out
  }

  /** 供测试确认入参形状。 */
  return {
    getCliPreference,
    listCliStates,
    preflightCli,
    setCliEnabled,
    setGlobalRoleEnabled,
    updateGlobalRole,
    createGlobalRole,
    deleteGlobalRole,
    updateProjectConfig,
    setProjectRoleOverride,
    preferencesView,
  }
}

export { CLI_NAMES, CLI_PREFERENCE }
