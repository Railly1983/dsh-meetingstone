// @ts-check
/**
 * 会话级 Remote 的 Host 方法包装：把 `createSessionGuiApi` 的纯逻辑错误转成
 * 宿主 `RemoteError`（稳定 code 经 Gateway 原样回传），再做参数白名单校验。
 *
 * 为什么不直接把业务错误抛成普通 Error：Gateway 只识别带 `isDSHRemoteError`
 * 标记的 `RemoteError`，普通 Error 会降级成 `gateway/internal`
 * （`dsh-api-gateway/lib/index.js:1704-1722`）。
 */

/**
 * @param {{ getSessionConfig: Function, setSessionOverride: Function, clearSessionOverride: Function }} sessionApi
 * @param {{ RemoteError?: any }} [options] RemoteError 类；缺失时退回普通 Error
 */
export function createSessionRemoteHandlers(sessionApi, options = {}) {
  const RemoteError = options.RemoteError

  /** @param {unknown} error */
  function toRemoteError(error) {
    const code =
      error && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'string'
        ? /** @type {any} */ (error).code
        : 'MEETINGSTONE_GUI_REMOTE_FAILED'
    const message =
      error instanceof Error ? error.message : error === undefined ? 'unknown error' : String(error)
    if (typeof RemoteError === 'function') return new RemoteError(code, message, {})
    return Object.assign(new Error(message), { code })
  }

  /** @param {() => any} operation */
  async function call(operation) {
    try {
      return await operation()
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  return {
    /** @param {string} sessionId */
    getSessionConfig(sessionId) {
      return call(() => sessionApi.getSessionConfig(sessionId))
    },
    /**
     * @param {string} sessionId
     * @param {string} roleId
     * @param {string} field
     * @param {unknown} value
     */
    setSessionOverride(sessionId, roleId, field, value) {
      return call(() => sessionApi.setSessionOverride(sessionId, roleId, field, value))
    },
    /**
     * @param {string} sessionId
     * @param {string} roleId
     * @param {string | null | undefined} field
     */
    clearSessionOverride(sessionId, roleId, field) {
      // `field` 省略 = 整角色恢复继承。显式把 null 归一化为 undefined，
      // 不把两种写法漏给业务层（Host 的 strict 第三参是可选的）。
      return call(() => sessionApi.clearSessionOverride(sessionId, roleId, field === null ? undefined : field))
    },
  }
}
