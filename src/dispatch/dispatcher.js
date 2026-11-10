// @ts-check
/**
 * 派单编排（C3）。纯逻辑 + 可注入适配器，便于单测；真实 DSH 调用在 dsh-adapter.js。
 *
 * 职责边界（勿扩大）：
 * - 只做「角色 → 通道 → 一次委派」的路由与并发纪律
 * - 不建任务队列、不存会话、不做重试策略、不渲染 UI
 * - 真正的生命周期（job、取消、进程树）归宿主 provider / ctx.jobs
 *
 * 依据：
 * - docs/开发计划.md §7.2（工具语义）
 * - docs/audit/03-native-capabilities.md（provider 通道）
 * - docs/audit/08-sandbox.md（权限不能靠 Prompt，必须显式封装）
 */

/** 派单错误码。 */
export const DISPATCH_ERRORS = Object.freeze({
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_DISABLED: 'ROLE_DISABLED',
  ROLE_AMBIGUOUS: 'ROLE_AMBIGUOUS',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  WRITE_CONFLICT: 'WRITE_CONFLICT',
  READONLY_LIMIT: 'READONLY_LIMIT',
  INVALID_TASK: 'INVALID_TASK',
  ADAPTER_FAILED: 'ADAPTER_FAILED',
})

/**
 * @typedef {object} DispatchRequest
 * @property {string} role 角色引用（roleId / name / 别名）
 * @property {string} task 任务内容
 * @property {string} [cwd] 目标目录；必须由调用方校验在项目内
 * @property {boolean} [readOnly] 覆盖角色的只读判定（只能在更严方向覆盖）
 * @property {object} [context] 宿主上下文（如 exec.agent），原样透传给适配器
 */

/**
 * @typedef {object} AdapterStartInput
 * @property {object} role 已解析的角色
 * @property {string} task
 * @property {string} [cwd]
 * @property {boolean} readOnly
 * @property {number} timeoutMs
 * @property {object} [context] 由调用方透传的宿主上下文
 */

/**
 * @typedef {object} DispatchAdapter
 * @property {(input: AdapterStartInput) => Promise<{ taskRef: object }>} start
 * @property {(taskRef: object) => Promise<void>} [cancel]
 * @property {(role: object) => { ok: boolean, reason?: string }} [canStart]
 */

/**
 * @typedef {{ ok: true, taskRef: object, role: object, readOnly: boolean, startedAt: number }
 *   | { ok: false, code: string, message: string, role?: object }} DispatchResult
 */

/**
 * @param {{ registry: { resolve: (ref: string) => any, list: () => any[] },
 *           adapter: DispatchAdapter,
 *           limits?: { maxParallelReadonly?: number, serializeWrites?: boolean },
 *           now?: () => number }} deps
 */
export function createDispatcher({ registry, adapter, limits = {}, now = () => Date.now() }) {
  const maxParallelReadonly = Math.max(1, Math.floor(limits.maxParallelReadonly ?? 3))
  const serializeWrites = limits.serializeWrites !== false

  /** @type {Map<object, { role: any, readOnly: boolean, startedAt: number }>} */
  const active = new Map()

  const countWrites = () => {
    let n = 0
    for (const v of active.values()) if (!v.readOnly) n++
    return n
  }
  const countReadonly = () => {
    let n = 0
    for (const v of active.values()) if (v.readOnly) n++
    return n
  }

  /**
   * 派发一次任务。
   * @param {DispatchRequest} req
   * @returns {Promise<DispatchResult>}
   */
  async function dispatch(req) {
    if (!req || typeof req.role !== 'string' || !req.role.trim()) {
      return fail(DISPATCH_ERRORS.ROLE_NOT_FOUND, '必须提供角色名、别名或 roleId')
    }
    if (typeof req.task !== 'string' || !req.task.trim()) {
      return fail(DISPATCH_ERRORS.INVALID_TASK, '任务内容不能为空')
    }

    // 1. 解析角色
    const role = registry.resolve(req.role)
    if (!role) {
      return fail(DISPATCH_ERRORS.ROLE_NOT_FOUND, `找不到角色：${req.role}`)
    }
    if (role.ambiguous === true) {
      return fail(DISPATCH_ERRORS.ROLE_AMBIGUOUS, `角色「${role.name}」的名称或别名与其他角色冲突，请先用 roleId 指定`)
    }
    if (role.enabled === false || role.disabled === true) {
      return fail(DISPATCH_ERRORS.ROLE_DISABLED, `角色「${role.name}」已停用，不能派单`)
    }

    // 2. 只读判定：只允许往更严的方向覆盖
    const roleReadonly = role.permissionPreset === 'read-only'
    const readOnly = roleReadonly || req.readOnly === true

    // 3. 通道可用性（provider 未安装时给出可诊断的错误，而不是崩）
    if (adapter.canStart) {
      let probe
      try {
        probe = adapter.canStart(role)
      } catch (err) {
        probe = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      if (!probe.ok) {
        return fail(
          DISPATCH_ERRORS.PROVIDER_UNAVAILABLE,
          `角色「${role.name}」的通道不可用：${probe.reason ?? '未知原因'}`,
        )
      }
    }

    // 4. 并发纪律：写串行、只读限流
    if (!readOnly) {
      if (serializeWrites && countWrites() > 0) {
        return fail(
          DISPATCH_ERRORS.WRITE_CONFLICT,
          '同一项目已有写任务在执行；写任务默认串行（可在项目配置里调整）',
        )
      }
    } else if (countReadonly() >= maxParallelReadonly) {
      return fail(
        DISPATCH_ERRORS.READONLY_LIMIT,
        `只读任务已达并发上限 ${maxParallelReadonly}，请等其中一个完成`,
      )
    }

    // 5. 交给宿主适配器
    let started
    try {
      started = await adapter.start({
        role,
        task: req.task,
        cwd: req.cwd,
        readOnly,
        timeoutMs: role.timeoutMs,
        // 透传宿主上下文（如 exec.agent）：dispatcher 不解释它，只负责送到适配器
        context: req.context,
      })
    } catch (err) {
      return fail(
        DISPATCH_ERRORS.ADAPTER_FAILED,
        `派发失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!started || !started.taskRef) {
      return fail(DISPATCH_ERRORS.ADAPTER_FAILED, '派发失败：适配器没有返回任务引用')
    }

    active.set(started.taskRef, { role, readOnly, startedAt: now() })
    return { ok: true, taskRef: started.taskRef, role, readOnly, startedAt: now() }
  }

  /**
   * 任务结束时释放并发槽位。重复调用无害。
   * @param {object} taskRef
   */
  function release(taskRef) {
    return active.delete(taskRef)
  }

  /** 取消：先让宿主取消，成功后释放槽位。 */
  async function cancel(taskRef) {
    if (!taskRef) return
    if (adapter.cancel) await adapter.cancel(taskRef)
    release(taskRef)
  }

  return {
    dispatch,
    release,
    cancel,
    stats: () => ({
      active: active.size,
      writes: countWrites(),
      readonly: countReadonly(),
      maxParallelReadonly,
      serializeWrites,
    }),
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, code: string, message: string }}
 */
function fail(code, message) {
  return { ok: false, code, message }
}
