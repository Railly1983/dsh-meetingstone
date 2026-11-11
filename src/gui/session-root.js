// @ts-check
/**
 * sessionId → 项目根（cwd）的官方解析。
 *
 * 背景（Kimi 拆解 §E.2）：原实现只在工具/派单执行时把 sessionId→cwd 记进
 * `sessionRoots`，导致「新会话尚未派单」时右侧栏读不到会话配置。
 *
 * 官方路径（app.asar，DSH 0.2.2-rc.1）：
 *  - `ctx.sessions.get(id)` 返回 live Session，`session.header.cwd` 是创建时的
 *    绝对 cwd（`dsh-session/lib/index.js:1993-2000`；`dsh-session/README.md:32-38`）；
 *  - `ctx.agents.get(id)` 返回 live Agent，`agent.session.header.cwd` 同源
 *    （`dsh-agent/README.md:28-35`）；
 *  - 新会话由 `session.create` 创建 Agent（`dsh-api-session-controller/lib/index.js:265-355`
 *    `claim` → `createAgent`），因此**不需要先派单**。
 *
 * 不用 `ctx.sessionController.resolveAgent()`：它会对冷会话执行 resume（创建 Agent），
 * 属于写副作用；侧栏读取不应触发。
 *
 * 读取服务用 `ctx.reflect.get(name)`——Cordis 官方无 inject 读取入口
 * （`@deepseek-ai/cordis/lib/index.js:1337-1352`），避免把 `sessions`/`agents`
 * 声明成硬依赖而拖垮非 GUI composition。
 */

/** @param {any} ctx @param {string} name */
function readService(ctx, name) {
  try {
    if (ctx && typeof ctx.reflect?.get === 'function') return ctx.reflect.get(name)
    // 兼容旧/测试 ctx：显式 get 只用于无注入读取。
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    /* 服务未就绪 */
  }
  return null
}

/** @param {any} value */
function cwdOf(value) {
  const cwd = value?.header?.cwd ?? value?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : null
}

/**
 * @param {object} [options]
 * @param {any} [options.ctx] Host 插件 ctx
 * @param {(sessionId: string) => string | null | undefined} [options.fallback]
 *   派单时记录的 sessionRoots 映射（兼容路径）。
 * @returns {(sessionId: string) => string | null}
 */
export function createSessionRootResolver({ ctx = null, fallback = null } = {}) {
  return function resolveProjectRoot(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null

    const sessions = readService(ctx, 'sessions')
    if (sessions && typeof sessions.get === 'function') {
      try {
        const cwd = cwdOf(sessions.get(sessionId))
        if (cwd) return cwd
      } catch {
        /* live Session 查询失败：继续尝试 agents/兜底 */
      }
    }

    const agents = readService(ctx, 'agents')
    if (agents && typeof agents.get === 'function') {
      try {
        const cwd = cwdOf(agents.get(sessionId))
        if (cwd) return cwd
      } catch {
        /* live Agent 查询失败：继续兜底 */
      }
    }

    if (typeof fallback === 'function') {
      try {
        const cwd = fallback(sessionId)
        if (typeof cwd === 'string' && cwd) return cwd
      } catch {
        /* 兜底映射失败：按未找到处理 */
      }
    }
    return null
  }
}
