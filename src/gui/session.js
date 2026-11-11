// @ts-check
/**
 * 右侧栏「当前会话角色编辑」的 Host 侧远程方法（纯逻辑，无 I/O 之外的副作用）。
 *
 * ⚠️ 暂不接入客户端（2026-11-11）：本模块只保留纯逻辑与单测，**不再注册为
 * Remote 方法**。真机证据：手写带参 descriptor 被宿主 Gateway 拒绝——
 * `generated Remote meetingstone/getSessionConfig field "sessionId" has no
 * strict codec`；strict codec 需要 zod 类型符号，手写 host 无法伪造，
 * `src-json` 参数也被 `requireStrictInputs` 拒绝。等宿主提供生成式 Remote
 * （typert generator）后再接。右侧栏面板当前为只读 `list()` 渲染。
 */
import { resolveEffectiveConfig, normalizeFieldPath } from '../session/config.js'
import { isValidRoleId } from '../roles/ids.js'
import { isValidSessionId } from '../session/store.js'

/**
 * 右侧栏「当前会话角色编辑」的 Host 侧远程方法（纯逻辑，无 I/O 之外的副作用）。
 *
 * 三层继承（global → project → session）的解析复用 `resolveEffectiveConfig`
 * （src/session/config.js），这里只负责：
 *  - 解析出某个 session 的「生效角色表 + 来源 + 当前会话覆盖」
 *  - 把一次字段级覆盖写进会话层（只写差异：等于继承值即删除旧覆盖）
 *  - 把一次字段级「恢复继承」写进会话层
 *
 * 输入校验（白名单）在这里做，坏输入抛带 `code` 的错误，由 src/gui/host.js 的
 * Remote 方法转成 `{ ok:false, error }` 返回给浏览器 half。校验层次：
 *  - sessionId：路径安全（src/session/store.js 的 isValidSessionId）
 *  - roleId：角色白名单（isValidRoleId）
 *  - field：角色级字段 / 通道字段白名单（normalizeFieldPath）
 *
 * session 隔离由 `sessionStore` 按 sessionId 分文件保证；本模块不碰别的会话。
 *
 * @param {object} deps
 * @param {any} deps.cfg 插件全局配置（与 resolveRegistry 同源）
 * @param {{ get: (root: string, file?: string) => any }} deps.projectStore
 * @param {ReturnType<import('../session/store.js').createSessionOverrideStore>} deps.sessionStore
 * @param {(sessionId: string) => string | null} [deps.resolveProjectRoot]
 *   由调用方提供的 sessionId → 项目根解析（index.js 用派单时记录的映射）。
 *   返回 null 表示找不到该会话的项目根。
 */
export function createSessionGuiApi({ cfg, projectStore, sessionStore, resolveProjectRoot }) {
  const projectConfigFile = cfg && typeof cfg.projectConfigFile === 'string' ? cfg.projectConfigFile : undefined

  /** 构造一个带 code 的错误，便于 Remote 层转成结构化错误。 */
  function guiError(code, message) {
    return Object.assign(new Error(message), { code })
  }

  /** @param {string} sessionId */
  function resolveProjectRootFor(sessionId) {
    if (typeof resolveProjectRoot !== 'function') return null
    const root = resolveProjectRoot(sessionId)
    return typeof root === 'string' && root ? root : null
  }

  /**
   * 解析一个会话的「生效视图」。
   * @param {string} sessionId
   * @returns {{ projectRoot: string, project: any, resolved: any, sessionLoaded: any }}
   */
  function resolveView(sessionId) {
    const projectRoot = resolveProjectRootFor(sessionId)
    if (!projectRoot) {
      throw guiError(
        SESSION_GUI_ERRORS.SESSION_ROOT_UNKNOWN,
        `找不到会话 ${sessionId} 对应的项目根，无法定位会话级配置（请先在該会话内触发一次派单/工具调用）`,
      )
    }
    const project = projectStore.get(projectRoot, projectConfigFile).config
    const sessionLoaded = sessionStore.get(projectRoot, sessionId)
    const resolved = resolveEffectiveConfig({
      global: cfg,
      project,
      session: sessionLoaded.config,
    })
    return { projectRoot, project, resolved, sessionLoaded }
  }

  /**
   * 读取当前会话的角色配置视图。
   * @param {string} sessionId
   * @returns {{ effective: any, overrides: Record<string, any>, sources: any }}
   */
  function getSessionConfig(sessionId) {
    const { resolved, sessionLoaded } = resolveView(sessionId)
    return {
      effective: resolved.effective,
      overrides: sessionLoaded.config.roleOverrides ?? {},
      sources: resolved.sources,
    }
  }

  /**
   * 写一个字段级会话覆盖。只写差异：等于继承值 → 删除该键（恢复继承）。
   * @param {string} sessionId
   * @param {string} roleId
   * @param {string} field 角色级字段或通道字段（model/provider/reasoning/cli…）
   * @param {unknown} value
   * @returns {any} sessionStore.setOverride 的结果（含 written/patch/errors）
   */
  function setSessionOverride(sessionId, roleId, field, value) {
    if (!isValidSessionId(sessionId)) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_SESSION_ID, `会话 id 不合法：${sessionId}`)
    }
    if (!isValidRoleId(roleId)) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_ROLE_ID, `角色 id 不合法：${roleId}`)
    }
    const fieldPath = normalizeFieldPath(field)
    if (!fieldPath) {
      throw guiError(
        SESSION_GUI_ERRORS.INVALID_FIELD,
        `不支持的覆盖字段 ${String(field)}（可用：别名/描述/模型/提供商/思考强度等角色或通道字段）`,
      )
    }

    const { projectRoot, project } = resolveView(sessionId)
    // 继承层（global+project）的角色，用于 diffRoleOverride 计算差异。
    const inheritedResolved = resolveEffectiveConfig({ global: cfg, project, session: undefined })
    const inheritedRole = inheritedResolved.effective.roles.find((role) => role.roleId === roleId)
    if (!inheritedRole) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_ROLE_ID, `继承层不存在该角色，无法覆盖：${roleId}`)
    }

    const patch =
      fieldPath.startsWith('channel.')
        ? { channel: { [fieldPath.slice('channel.'.length)]: value } }
        : { [fieldPath]: value }

    return sessionStore.setOverride(projectRoot, sessionId, { roleId, patch, inherited: inheritedRole })
  }

  /**
   * 恢复一个字段（或全部）的继承。field 省略 → 整角色恢复继承。
   * @param {string} sessionId
   * @param {string} roleId
   * @param {string | undefined} field
   * @returns {any} sessionStore.clearOverride 的结果
   */
  function clearSessionOverride(sessionId, roleId, field) {
    if (!isValidSessionId(sessionId)) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_SESSION_ID, `会话 id 不合法：${sessionId}`)
    }
    if (!isValidRoleId(roleId)) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_ROLE_ID, `角色 id 不合法：${roleId}`)
    }
    if (field !== undefined && field !== null) {
      const fieldPath = normalizeFieldPath(field)
      if (!fieldPath) {
        throw guiError(
          SESSION_GUI_ERRORS.INVALID_FIELD,
          `不支持的覆盖字段 ${String(field)}（可用：别名/描述/模型/提供商/思考强度等角色或通道字段）`,
        )
      }
    }

    const { projectRoot } = resolveView(sessionId)
    return sessionStore.clearOverride(projectRoot, sessionId, { roleId, field })
  }

  return { getSessionConfig, setSessionOverride, clearSessionOverride }
}

/** 右侧栏远程方法的错误码（带中文 message，直接可展示）。 */
export const SESSION_GUI_ERRORS = Object.freeze({
  SESSION_ROOT_UNKNOWN: 'SESSION_GUI_SESSION_ROOT_UNKNOWN',
  INVALID_SESSION_ID: 'SESSION_GUI_INVALID_SESSION_ID',
  INVALID_ROLE_ID: 'SESSION_GUI_INVALID_ROLE_ID',
  INVALID_FIELD: 'SESSION_GUI_INVALID_FIELD',
})
