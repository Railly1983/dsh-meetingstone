// @ts-check
/**
 * 派单编排（C3）。纯逻辑 + 可注入适配器，便于单测；真实 DSH 调用在 dsh/adapter.js。
 *
 * 职责边界（勿扩大）：
 * - 只做「角色 → 通道 → 一次委派」的路由与并发纪律
 * - 不建任务队列、不存会话、不做重试策略、不渲染 UI
 * - 真正的生命周期（job、取消、进程树）归宿主 provider / ctx.jobs
 *
 * 并发纪律（唐僧 P2 Gate 复核后修正）：
 * - **先占槽、再启动**：否则两个并发写请求会同时通过检查（旧实现已复现该 bug）
 * - **由适配器回调释放**：`onFinish` 在任务终态（完成/失败/取消）时调用，幂等
 * - **按项目隔离计数**：不同项目互不误挡；同项目写任务默认串行
 *
 * 本项目**不提供只读通道**：没有只读判定、没有只读限流，所有派单都按写任务串行。
 * 宿主 subagent spec 没有权限字段，做不到绝对只读，就不要留半吊子承诺（2026-11-11）。
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
  INVALID_TASK: 'INVALID_TASK',
  ADAPTER_FAILED: 'ADAPTER_FAILED',
  // 适配器的前置校验错误码：原样透传，便于调用方分支处理（而不是一律 ADAPTER_FAILED）
  MODEL_UNSUPPORTED: 'MODEL_UNSUPPORTED',
  PATH_OUTSIDE_PROJECT: 'PATH_OUTSIDE_PROJECT',
  PROJECT_ROOT_UNKNOWN: 'PROJECT_ROOT_UNKNOWN',
  PARENT_AGENT_UNAVAILABLE: 'PARENT_AGENT_UNAVAILABLE',
})

/** 适配器抛错串里可透传的错误码前缀。 */
const PASSTHROUGH_PREFIXES = [
  'MODEL_UNSUPPORTED',
  'PATH_OUTSIDE_PROJECT',
  'PROJECT_ROOT_UNKNOWN',
  'PARENT_AGENT_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
]

/**
 * 从适配器错误里取出可透传的错误码；取不到就归为 ADAPTER_FAILED。
 * @param {string} raw
 */
function adapterErrorCode(raw) {
  const head = raw.split(':')[0]?.trim() ?? ''
  return PASSTHROUGH_PREFIXES.includes(head) ? head : DISPATCH_ERRORS.ADAPTER_FAILED
}

/** 未指定项目时的默认槽位键。 */
export const DEFAULT_PROJECT_KEY = 'default'

/**
 * @typedef {object} DispatchRequest
 * @property {string} role 角色引用（roleId / name / 别名）
 * @property {string} task 任务内容
 * @property {string} [cwd] 目标目录；项目边界校验在适配器里做
 * @property {string} [projectKey] 并发计数键（通常传项目根路径）；省略视为 default
 * @property {object} [context] 宿主上下文（如 exec.agent），原样透传给适配器
 * @property {object} [registry] 覆盖本次解析用的注册表（按项目上下文注入全局+项目覆盖）
 */

/**
 * @typedef {object} AdapterStartInput
 * @property {object} role 已解析的角色
 * @property {string} task
 * @property {string} [cwd]
 * @property {number} timeoutMs
 * @property {object} [context] 由调用方透传的宿主上下文
 * @property {() => void} onFinish 任务终态回调（适配器必须在完成/失败/取消时调用一次）
 */

/**
 * @typedef {object} DispatchAdapter
 * @property {(input: AdapterStartInput) => Promise<{ taskRef: object }>} start
 * @property {(taskRef: object) => Promise<void>} [cancel]
 * @property {(role: object) => { ok: boolean, reason?: string }} [canStart]
 */

/**
 * @typedef {{ ok: true, taskRef: object, role: object, startedAt: number }
 *   | { ok: false, code: string, message: string, role?: object }} DispatchResult
 */

/**
 * @param {{ registry: { resolve: (ref: string) => any, list: () => any[] },
 *           adapter: DispatchAdapter,
 *           limits?: { serializeWrites?: boolean },
 *           now?: () => number }} deps
 */
export function createDispatcher({ registry, adapter, limits = {}, now = () => Date.now() }) {
  const serializeWrites = limits.serializeWrites !== false

  /** @type {Map<object, { role: any, projectKey: string, startedAt: number, ref: object | null }>} */
  const active = new Map()
  /** @type {Map<object, object>} taskRef -> token */
  const refToToken = new Map()

  /** @param {string} projectKey */
  const writesFor = (projectKey) => {
    let writes = 0
    for (const v of active.values()) {
      if (v.projectKey === projectKey) writes += 1
    }
    return writes
  }

  /**
   * 释放一个槽位。按 token 或 taskRef 都可以，重复调用幂等。
   * @param {object | null | undefined} key
   */
  function release(key) {
    if (!key) return false
    // 允许传 taskRef
    const token = refToToken.get(key) ?? key
    const entry = active.get(token)
    if (!entry) return false
    active.delete(token)
    if (entry.ref) refToToken.delete(entry.ref)
    return true
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

    // 1. 解析角色（允许调用方按项目上下文传入专用注册表：全局 + 项目覆盖）
    const effectiveRegistry = req.registry ?? registry
    const role = effectiveRegistry.resolve(req.role)
    if (!role) {
      // 区分「不存在」与「有歧义」：否则用户看到"找不到角色"却明明有这个名字
      if (
        typeof effectiveRegistry.isAmbiguousRef === 'function' &&
        effectiveRegistry.isAmbiguousRef(req.role)
      ) {
        const ids =
          typeof effectiveRegistry.conflictsFor === 'function'
            ? effectiveRegistry.conflictsFor(req.role)
            : []
        const hint = ids.length ? `，可选：${ids.join(' / ')}` : '（可用 meetingstone_list_roles 查看）'
        return fail(
          DISPATCH_ERRORS.ROLE_AMBIGUOUS,
          `名称「${req.role}」被多个角色占用，请改用 roleId 指定${hint}`,
        )
      }
      return fail(DISPATCH_ERRORS.ROLE_NOT_FOUND, `找不到角色：${req.role}`)
    }
    // 歧义只在「用名字/别名解析」时阻挡；直接给 roleId 仍然可用（否则纠错提示是空话）
    const refKey = String(req.role).trim().toLowerCase()
    if (role.ambiguous === true && refKey !== String(role.roleId).toLowerCase()) {
      return fail(
        DISPATCH_ERRORS.ROLE_AMBIGUOUS,
        `角色「${role.name}」的名称或别名与其他角色冲突，请改用 roleId（${role.roleId}）指定`,
      )
    }
    if (role.enabled === false || role.disabled === true) {
      return fail(DISPATCH_ERRORS.ROLE_DISABLED, `角色「${role.name}」已停用，不能派单`)
    }

    // 2. 通道可用性（provider 未安装时给出可诊断的错误，而不是崩）
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

    // 3. 并发纪律：**先占槽再启动**，失败回滚。所有派单都按写任务串行。
    const projectKey =
      typeof req.projectKey === 'string' && req.projectKey ? req.projectKey : DEFAULT_PROJECT_KEY
    const writes = writesFor(projectKey)

    if (serializeWrites && writes > 0) {
      return fail(
        DISPATCH_ERRORS.WRITE_CONFLICT,
        '同一项目已有任务在执行；写任务默认串行（可在项目配置里调整）',
      )
    }

    /** @type {object} */
    const token = {}
    active.set(token, { role, projectKey, startedAt: now(), ref: null })
    /** @type {() => void} */
    const onFinish = () => {
      release(token)
    }

    // 4. 交给宿主适配器
    let started
    try {
      started = await adapter.start({
        role,
        task: req.task,
        cwd: req.cwd,
        timeoutMs: role.timeoutMs,
        context: req.context,
        // 上下文重放块（P1）：由工具层解析好后透传，适配器只负责拼进提示词
        ...(req.continuation ? { continuation: req.continuation } : {}),
        onFinish,
      })
    } catch (err) {
      active.delete(token)
      const raw = err instanceof Error ? err.message : String(err)
      return fail(adapterErrorCode(raw), `派发失败：${raw}`)
    }
    if (!started || !started.taskRef) {
      active.delete(token)
      return fail(DISPATCH_ERRORS.ADAPTER_FAILED, '派发失败：适配器没有返回任务引用')
    }

    const entry = active.get(token)
    if (entry) entry.ref = started.taskRef
    refToToken.set(started.taskRef, token)

    return { ok: true, taskRef: started.taskRef, role, startedAt: now() }
  }

  /** 取消：先让宿主取消，成功后释放槽位（适配器也可能回调 onFinish，release 幂等）。 */
  async function cancel(taskRef) {
    if (!taskRef) return
    if (adapter.cancel) await adapter.cancel(taskRef)
    release(taskRef)
  }

  /**
   * 查询任务结果。适配器不支持时返回 unknown，不编造。
   * @param {string | object} ref
   */
  async function getTask(ref) {
    if (typeof adapter.getTask !== 'function') {
      return { status: 'unknown', reason: '当前适配器不支持结果查询' }
    }
    return adapter.getTask(ref)
  }

  return {
    dispatch,
    release,
    cancel,
    getTask,
    stats: (projectKey) => {
      if (typeof projectKey === 'string') {
        const writes = writesFor(projectKey)
        return { active: writes, writes, serializeWrites }
      }
      return { active: active.size, writes: active.size, serializeWrites }
    },
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
