// @ts-check
import { SESSION_CONFIG_ERRORS, resolveEffectiveConfig, normalizeFieldPath } from '../session/config.js'
import { isValidRoleId } from '../roles/ids.js'
import { isValidSessionId } from '../session/store.js'

/**
 * 右侧栏「当前会话角色编辑」的 Host 侧远程方法（纯逻辑，无 I/O 之外的副作用）。
 *
 * 传输层（0.2.0 P0-S0）：三个方法经 `src/gui/typert.js` 的 strict Host 定义
 * 暴露给客户端；本文件仍只做业务校验与继承解析，不感知 Typert/zod。
 *
 * 三层继承（global → project → session）的解析复用 `resolveEffectiveConfig`
 * （src/session/config.js），这里只负责：
 *  - 解析出某个 session 的「生效角色表 + 来源 + 当前会话覆盖」
 *  - 把一次字段级覆盖写进会话层（只写差异：等于继承值即删除旧覆盖）
 *  - 把一次字段级「恢复继承」写进会话层
 *
 * 输入校验（白名单）在这里做，坏输入抛带 `code` 的错误，由
 * `src/gui/session-remote.js` 转成宿主 `RemoteError` 返回给浏览器 half。校验层次：
 *  - sessionId：路径安全（src/session/store.js 的 isValidSessionId）
 *  - roleId：角色白名单（isValidRoleId）
 *  - field：角色级字段 / 通道字段白名单（normalizeFieldPath）
 *
 * session 隔离由 `sessionStore` 按 sessionId 分文件保证；本模块不碰别的会话。
 *
 * @param {object} deps
 * @param {any} deps.cfg 插件全局配置（与 resolveRegistry 同源）
 * @param {any} [deps.globalRaw] 规范化前的全局原始配置；用于区分显式 enabled 与
 *   schema 默认值（不传时来源可能把默认值误标成 global）
 * @param {{ get: (root: string, file?: string) => any }} deps.projectStore
 * @param {ReturnType<import('../session/store.js').createSessionOverrideStore>} deps.sessionStore
 * @param {(sessionId: string) => string | null} [deps.resolveProjectRoot]
 *   由调用方提供的 sessionId → 项目根解析（生产环境见 src/gui/session-root.js：
 *   优先 live `ctx.sessions`/`ctx.agents` 的 header.cwd，派单映射只作兜底）。
 *   返回 null 表示找不到该会话的项目根。
 */
export function createSessionGuiApi({ cfg, globalRaw, projectStore, sessionStore, resolveProjectRoot }) {
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
        `无法从宿主会话服务定位 ${sessionId} 的项目根（session/agent 未激活或缺少 header.cwd）`,
      )
    }
    const project = projectStore.get(projectRoot, projectConfigFile).config
    const sessionLoaded = sessionStore.get(projectRoot, sessionId)
    const resolved = resolveEffectiveConfig({
      global: cfg,
      globalRaw,
      project,
      session: sessionLoaded.config,
    })
    return { projectRoot, project, resolved, sessionLoaded }
  }

  /**
   * 读取当前会话的角色配置视图。
   * @param {string} sessionId
   * @returns {{ effective: any, overrides: Record<string, any>, sources: any, warnings: any[] }}
   */
  function getSessionConfig(sessionId) {
    const { resolved, sessionLoaded } = resolveView(sessionId)
    return {
      effective: resolved.effective,
      overrides: sessionLoaded.config.roleOverrides ?? {},
      sources: resolved.sources,
      // 读取层的非致命告警（未知字段、坏字段等）；不改变 effective 的降级语义。
      warnings: Array.isArray(sessionLoaded.errors) ? sessionLoaded.errors : [],
    }
  }

  /**
   * 给 store 的结果补一层稳定元数据：
   * - `scope`：本次是字段级还是整角色
   * - `idempotent`：没有真正落盘（重复设置/重复恢复）
   * - `code`：首个错误码（成功且无错误时为 null），便于 Remote 调用方直接分支
   *
   * @param {any} result
   * @param {'field' | 'role'} scope
   */
  function withResultMeta(result, scope) {
    const errors = Array.isArray(result?.errors) ? result.errors : []
    // 写被拒绝时优先报 CORRUPT：调用方最需要知道的是「文件坏了，先修/删」，
    // 而不是最外层的 JSON 解析细节。
    const corrupt = errors.find((error) => error?.code === SESSION_CONFIG_ERRORS.CORRUPT)
    const firstCode = typeof errors[0]?.code === 'string' ? errors[0].code : null
    return {
      ...result,
      scope,
      idempotent: result?.written !== true,
      code:
        typeof result?.code === 'string' && result.code
          ? result.code
          : corrupt?.code ?? firstCode,
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
    const inheritedResolved = resolveEffectiveConfig({ global: cfg, globalRaw, project, session: undefined })
    const inheritedRole = inheritedResolved.effective.roles.find((role) => role.roleId === roleId)
    if (!inheritedRole) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_ROLE_ID, `继承层不存在该角色，无法覆盖：${roleId}`)
    }

    const patch =
      fieldPath.startsWith('channel.')
        ? { channel: { [fieldPath.slice('channel.'.length)]: value } }
        : { [fieldPath]: value }

    // 注意：本函数**不是 async**。参数/白名单错误必须同步 throw（Remote 层才能
    // 统一转成 RemoteError）；只有落盘是异步的。
    return Promise.resolve(
      sessionStore.setOverride(projectRoot, sessionId, {
        roleId,
        patch,
        inherited: inheritedRole,
      }),
    ).then((result) => withResultMeta(result, 'field'))
  }

  /**
   * 恢复一个字段（或全部）的继承。field 省略 → 整角色恢复继承。
   *
   * ⚠️ 「省略 field」的坑（Host 把缺失当缺失）：
   * 这里把 `undefined` / `null` 统一归一化为「整角色」，并且**显式传**
   * `{ roleId, field: undefined }`。不要依赖对象字面量里省略键的隐式语义，
   * 也不要把 `undefined` 序列化成缺参——strict Remote 的第三参是可选的，
   * 两种写法在 Host 侧必须落到同一个分支。
   *
   * @param {string} sessionId
   * @param {string} roleId
   * @param {string | null | undefined} field
   * @returns {any} sessionStore.clearOverride 的结果（带 scope/idempotent/code）
   */
  function clearSessionOverride(sessionId, roleId, field) {
    if (!isValidSessionId(sessionId)) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_SESSION_ID, `会话 id 不合法：${sessionId}`)
    }
    if (!isValidRoleId(roleId)) {
      throw guiError(SESSION_GUI_ERRORS.INVALID_ROLE_ID, `角色 id 不合法：${roleId}`)
    }

    const hasField = field !== undefined && field !== null
    let fieldPath
    if (hasField) {
      fieldPath = normalizeFieldPath(field)
      if (!fieldPath) {
        throw guiError(
          SESSION_GUI_ERRORS.INVALID_FIELD,
          `不支持的覆盖字段 ${String(field)}（可用：别名/描述/模型/提供商/思考强度等角色或通道字段）`,
        )
      }
    }

    const { projectRoot } = resolveView(sessionId)
    // 显式传 field 键（即使值为 undefined）：语义是「清整个角色覆盖」。
    return Promise.resolve(
      sessionStore.clearOverride(projectRoot, sessionId, {
        roleId,
        field: fieldPath,
      }),
    ).then((result) => withResultMeta(result, hasField ? 'field' : 'role'))
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
