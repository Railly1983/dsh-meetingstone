// @ts-check
/**
 * 派单编排（C3）。纯逻辑 + 可注入适配器，便于单测；真实 DSH 调用在 dsh/adapter.js。
 *
 * 职责边界（勿扩大）：
 * - 只做「角色 → 通道 → 一次委派」的路由、隔离与并发纪律
 * - 不建任务队列、不存会话、不做重试策略、不渲染 UI
 * - 工作树管理由注入的 `worktrees`（src/worktree.js）负责
 * - 进行中重复任务去重（P0-D）：仅内存 Map 索引，终态即清理；不建库、不复用已完成结果
 *   （不是任务队列 / 数据库，见 §P0-D 注释）
 *
 * 并发纪律（2026-11-11 用户决策后的并行版）：
 * - **先占槽、再启动**：本插件的全局额度在**首次异步操作前**预占，包括建工作树；
 *   否则并发请求会同时通过检查
 * - **只统计本插件派发的在跑任务**：额度属于 dispatcher 实例，不按通道/项目分开；
 *   宿主自身的子 Agent 不在这里计数
 * - **宿主容量交给宿主**：不重复实现单会话/进程上限；宿主 `ACTIVATION_LIMIT_REACHED`
 *   （`subagent limit reached`，默认容量 8）原样透传，本项目**不排队**
 * - **按项目隔离计数**：项目 key 先归一化（Windows 大小写 / 尾斜杠），别名不能绕过
 *   隔离互斥（同项目 worktree 与 none 不得混跑）
 * - **由适配器回调释放**：`onFinish` 在任务终态（完成/失败/取消）时调用，幂等
 *
 * 隔离纪律：
 * - 默认隔离方式来自全局配置 `limits.defaultIsolation`（默认 `worktree`）
 * - 请求隔离但工作树服务缺失 / 建树失败 → **拒绝派单**，绝不退回主工作区
 * - `isolation:'none'` 与隔离任务**不得混跑**：同项目任一方向有活动任务就拒绝
 * - 终止时**不删除**工作树/分支；未合并改动只能人工处理
 *
 * 本项目**不提供只读通道**：没有只读判定、没有只读限流。
 *
 * 依据：
 * - docs/plan/2026-11-11-parallel-plan.md（悟空裁决）
 * - docs/开发计划.md §7.2（工具语义）
 * - docs/audit/08-sandbox.md（权限不能靠 Prompt，必须显式封装）
 */

import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { sanitizedGitEnv } from '../worktree.js'

/** 派单错误码。 */
export const DISPATCH_ERRORS = Object.freeze({
  // P1-B：调用方既没给 role，也没开 autoRoute（自动路由失败用 AUTO_ROUTE_FAILED）
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_DISABLED: 'ROLE_DISABLED',
  ROLE_AMBIGUOUS: 'ROLE_AMBIGUOUS',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  WRITE_CONFLICT: 'WRITE_CONFLICT',
  WRITE_LIMIT_TOTAL: 'WRITE_LIMIT_TOTAL',
  // 宿主子 Agent 容量耗尽（共享池，默认 8）：原样透传，不包成 ADAPTER_FAILED。
  // 出处：宿主 @deepseek-ai/dsh-subagent 的 ActivationPool.reserve() 抛
  // SubagentError(msg, 'ACTIVATION_LIMIT_REACHED')，且**没有等待/排队机制**。
  ACTIVATION_LIMIT_REACHED: 'ACTIVATION_LIMIT_REACHED',
  INVALID_TASK: 'INVALID_TASK',
  INVALID_ISOLATION: 'INVALID_ISOLATION',
  ADAPTER_FAILED: 'ADAPTER_FAILED',
  // 适配器生命周期错误码：原样透传，调用方才能区分「卸载拒绝」与「启动失败」
  ADAPTER_DISPOSED: 'ADAPTER_DISPOSED',
  // 适配器的前置校验错误码：原样透传，便于调用方分支处理（而不是一律 ADAPTER_FAILED）
  MODEL_UNSUPPORTED: 'MODEL_UNSUPPORTED',
  PATH_OUTSIDE_PROJECT: 'PATH_OUTSIDE_PROJECT',
  PROJECT_ROOT_UNKNOWN: 'PROJECT_ROOT_UNKNOWN',
  PARENT_AGENT_UNAVAILABLE: 'PARENT_AGENT_UNAVAILABLE',
  // 工作树隔离错误码（与 src/worktree.js 的 WORKTREE_ERRORS 对齐）
  WORKTREE_UNAVAILABLE: 'WORKTREE_UNAVAILABLE',
  WORKTREE_NOT_GIT_REPOSITORY: 'WORKTREE_NOT_GIT_REPOSITORY',
  WORKTREE_BASE_INVALID: 'WORKTREE_BASE_INVALID',
  WORKTREE_PATH_EXISTS: 'WORKTREE_PATH_EXISTS',
  WORKTREE_BRANCH_EXISTS: 'WORKTREE_BRANCH_EXISTS',
  WORKTREE_GIT_FAILED: 'WORKTREE_GIT_FAILED',
  WORKTREE_TIMEOUT: 'WORKTREE_TIMEOUT',
  WORKTREE_PATH_OUTSIDE: 'WORKTREE_PATH_OUTSIDE',
})

/** 适配器抛错串里可透传的错误码前缀。 */
const PASSTHROUGH_PREFIXES = [
  'MODEL_UNSUPPORTED',
  'PATH_OUTSIDE_PROJECT',
  'PROJECT_ROOT_UNKNOWN',
  'PARENT_AGENT_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'ADAPTER_DISPOSED',
  'ACTIVATION_LIMIT_REACHED',
]

/** 工作树错误码前缀（dispatcher 自己抛/透传）。 */
const WORKTREE_CODE_PREFIX = 'WORKTREE_'

/** 未指定项目时的默认槽位键。 */
export const DEFAULT_PROJECT_KEY = 'default'

/** 隔离方式闭集。 */
export const ISOLATION_MODES = Object.freeze(['none', 'worktree'])

// ─── P0-D：进行中重复任务去重（指纹 / 版本） ──────────────────────────────────
//
// 依据 docs/reference/efficiency-v1.0.md §3.5 / §5 表 8 / §8：
// - 只对「进行中」（reserved→started，即 queued/running）任务去重；完成的条目在
//   release() 时从索引移除，绝不复用已完成任务结果。
// - 绝不只 hash Prompt：指纹 = 项目身份 + 角色 ID/provider + 规范化任务内容 +
//   版本指纹 + 状态桶 + 关键参数。
// - 版本指纹取 `git rev-parse HEAD`（worktree 隔离下等同 baseSha）。取不到标
//   `unknown`：此时无法证明完全相同，该请求既不进索引也不命中索引（宁可重复也不误合）。
// - 索引仅内存（Map），重启失效；不建库、不落盘。

/** 版本指纹取不到时的标记；它不是任何真实 SHA，且**不参与**去重判定。 */
export const VERSION_UNKNOWN = 'unknown'

/** 指纹结构版本：组成规则变更时改它，让旧指纹自然失效。 */
export const FINGERPRINT_VERSION = 1

/** `git rev-parse HEAD` 的超时（毫秒）：不能让一次派单被 git 卡死。 */
export const DEFAULT_VERSION_TIMEOUT_MS = 2000

/**
 * 默认版本指纹：在项目根同步跑一次 `git rev-parse HEAD`。
 *
 * 为什么同步：去重判定必须与「占额度 / 建树 / 启动」之间保持原子；一旦这里异步，
 * 两个并发相同请求可能都通过判定。execFileSync 只做一次轻量查询，带超时与输出上限。
 * 失败（非 git 仓库 / 没有项目根 / git 不在 PATH / 超时）一律返回 VERSION_UNKNOWN，
 * 交由上层走「信息不足 → 正常创建新任务」。
 *
 * @param {unknown} projectRoot
 * @returns {string} 40 位小写 SHA 或 VERSION_UNKNOWN
 */
export function defaultVersionFingerprint(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return VERSION_UNKNOWN
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      env: sanitizedGitEnv(),
      timeout: DEFAULT_VERSION_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const sha = typeof out === 'string' ? out.trim() : ''
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : VERSION_UNKNOWN
  } catch {
    return VERSION_UNKNOWN
  }
}

/**
 * 稳定序列化：对象键排序、数组保序、undefined/函数/符号统一当 null。
 * 保证「字段插入顺序不同但内容相同」的两个请求得到同一指纹。
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return 'null'
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return 'null'
}

/** @param {unknown} value */
function normalizePrompt(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 构造指纹的规范化组成（导出供单测核对「哪些字段参与判定」）。
 * 返回 null 表示信息不足以证明完全相同（版本未知）→ 不参与去重。
 *
 * @param {{ req: any, role: any, projectKey: string,
 *           isolation: 'none' | 'worktree', version: string }} input
 * @returns {Record<string, unknown> | null}
 */
export function fingerprintParts({ req, role, projectKey, isolation, version }) {
  if (!version || version === VERSION_UNKNOWN) return null
  const channel =
    role && typeof role === 'object' && role.channel && typeof role.channel === 'object'
      ? role.channel
      : {}
  const taskSpec = req.taskSpec && typeof req.taskSpec === 'object' ? req.taskSpec : null
  const contextPack = req.contextPack && typeof req.contextPack === 'object' ? req.contextPack : null
  return {
    v: FINGERPRINT_VERSION,
    // 项目 / 工作区身份
    project: projectKey,
    // 角色 ID 与 provider / 关键执行参数（任一差异即视为不同任务）
    role: {
      roleId: String(role?.roleId ?? ''),
      provider: channel.provider ?? null,
      kind: channel.kind ?? null,
      channelId: channel.channelId ?? null,
      model: channel.model ?? null,
      reasoning: channel.reasoning ?? null,
      prompt: typeof role?.prompt === 'string' ? role.prompt : null,
      description: typeof role?.description === 'string' ? role.description : null,
      timeoutMs: role?.timeoutMs ?? null,
    },
    // 规范化任务内容：有 TaskSpec 时用结构化字段，绝不只是 hash Prompt
    content: {
      prompt: normalizePrompt(req.task),
      ...(taskSpec ? { taskSpec } : {}),
      ...(contextPack ? { contextPack } : {}),
    },
    // 版本指纹（当前 HEAD commit / baseSha）
    version: String(version),
    // 状态：只对进行中（queued/running）去重；完成的条目已从索引移除
    status: 'in-progress',
    // 关键参数：隔离 / 权限档位 / 输出预算 / 上下文重放
    params: {
      isolation,
      ...(taskSpec?.permissionPreset != null ? { permissionPreset: taskSpec.permissionPreset } : {}),
      ...(taskSpec?.outputBudget != null ? { outputBudget: taskSpec.outputBudget } : {}),
      ...(req.continuation ? { continuation: true } : {}),
    },
  }
}

/**
 * 计算任务指纹（sha256 hex）。版本未知时返回 null（不去重）。
 * @param {{ req: any, role: any, projectKey: string,
 *           isolation: 'none' | 'worktree', version: string }} input
 * @returns {string | null}
 */
export function computeFingerprint(input) {
  const parts = fingerprintParts(input)
  if (parts === null) return null
  return createHash('sha256').update(stableStringify(parts)).digest('hex')
}

/**
 * 从适配器错误里取出可透传的错误码；取不到就归为 ADAPTER_FAILED。
 *
 * 优先读 `err.code`（宿主 SubagentError 把 `ACTIVATION_LIMIT_REACHED` 放在 code 上，
 * 消息本身是 `subagent limit reached (...)`，没有 code 前缀），再退回消息前缀。
 *
 * @param {string} raw
 * @param {unknown} [err]
 */
function adapterErrorCode(raw, err) {
  const explicit =
    err && typeof err === 'object' && typeof (/** @type {any} */ (err).code) === 'string'
      ? /** @type {any} */ (err).code.trim()
      : ''
  if (PASSTHROUGH_PREFIXES.includes(explicit)) return explicit
  const head = raw.split(':')[0]?.trim() ?? ''
  return PASSTHROUGH_PREFIXES.includes(head) ? head : DISPATCH_ERRORS.ADAPTER_FAILED
}

/**
 * 提取失败上下文（工作树 path/branch/phase 等）。
 *
 * 为什么必须在 dispatcher 层做：`WORKTREE_*` 的三阶段异常（list / 预检分支 / 锁内分支检查）
 * 在 worktree.js 里都带 path/branch/phase，但 dispatcher 原来只挑 residualPath，
 * 调用方拿到失败结果后无法定位是哪一步、哪个分支（F5）。
 * 顶层字段优先，其次 `details`（WorktreeError 两种都带）。
 *
 * @param {unknown} err
 * @param {any} [worktree] 已创建的工作树元数据（适配器启动阶段失败时没有 err.path）
 * @returns {{ path?: string, branch?: string, phase?: string, residualPath?: string }}
 */
function errorContext(err, worktree) {
  const source = err && typeof err === 'object' ? /** @type {any} */ (err) : {}
  const details =
    source.details && typeof source.details === 'object' ? source.details : {}
  /** @param {string} key */
  const pick = (key) => {
    const direct = source[key]
    if (typeof direct === 'string' && direct) return direct
    const nested = details[key]
    if (typeof nested === 'string' && nested) return nested
    return undefined
  }
  const path =
    pick('path') ??
    (typeof worktree?.path === 'string' && worktree.path ? worktree.path : undefined)
  const branch =
    pick('branch') ??
    (typeof worktree?.branch === 'string' && worktree.branch ? worktree.branch : undefined)
  const phase = pick('phase')
  const residualPath =
    pick('residualPath') ?? path
  return {
    ...(path ? { path } : {}),
    ...(branch ? { branch } : {}),
    ...(phase ? { phase } : {}),
    ...(residualPath ? { residualPath } : {}),
  }
}

/**
 * 归一化并发计数键（纯字符串层）。
 *
 * 为什么需要：`dispatcher` 用**精确字符串**比较 projectKey，`D:/P` 与 `d:/p/`
 * 会被当成两个项目，从而绕过"同项目"的额度（沙僧审计实测）。
 * Windows 大小写不敏感、尾斜杠等价，统一折叠；POSIX 只去尾斜杠，避免误并不同目录。
 *
 * 注意：字符串层解决不了 `原路径` 与 `原路径/src/..` 这类**同目录别名**，
 * 也解决不了 junction/symlink。派单路径必须再用 `resolveProjectKey()` 做 realpath。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeProjectKey(value) {
  if (typeof value !== 'string') return null
  let key = value.trim().replace(/[\\/]+$/, '')
  if (!key) return null
  // Windows 上 `D:\P` 与 `D:/P` 是同一路径；大小写也不敏感。POSIX 保留原样，
  // 避免把合法的反斜杠文件名/目录名误并。
  if (process.platform === 'win32') key = key.replace(/\\/g, '/').toLowerCase()
  return key
}

/**
 * 解析项目/仓库身份：先 `fs.realpath`，再按平台折叠大小写/斜杠。
 *
 * 为什么必须在**额度检查之前**做：`原路径` 与 `原路径/src/..`、junction/symlink
 * 指向同一目录时，字符串归一化会得到两个 key，隔离互斥（同项目 worktree/none 不得混跑）
 * 会被绕过（P1）。realpath 失败（路径尚不存在、无权限）时退回字符串归一化，保持失败关闭语义——
 * 不因为解析失败就放行成另一个 key。
 *
 * @param {unknown} value
 * @returns {Promise<string | null>}
 */
export async function resolveProjectKey(value) {
  return (await realpathProjectKey(value)) ?? normalizeProjectKey(value)
}

/**
 * 只做 realpath 身份解析；解析失败返回 null（不退回字符串），
 * 供调用方在多个候选字段之间挑选"真正存在的路径"。
 * @param {unknown} value
 * @returns {Promise<string | null>}
 */
async function realpathProjectKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const real = await fs.realpath(value.trim())
    return normalizeProjectKey(real)
  } catch {
    return null
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const n = Math.floor(value)
  return n >= 1 ? n : fallback
}

/**
 * @typedef {object} DispatchRequest
 * @property {string} role 角色引用（roleId / name / 别名）
 * @property {string} task 任务内容
 * @property {{ roleId: string, reason?: string, auto: boolean }} [routing]
 *   角色路由结果（P1-B）：由工具层在自动路由时生成；dispatcher 只负责透传与落盘，
 *   不参与决策、不改 provider/model。手动指定角色时 `auto:false` 且不带 reason。
 * @property {any} [taskSpec] 已校验的 TaskSpec（结构化模式；不传 = 旧路径）
 * @property {any} [contextPack] 已校验的 ContextPack（可空）
 * @property {string} [cwd] 目标目录；隔离模式下会被工作树路径覆盖
 * @property {string} [projectKey] 并发计数键（通常传项目根路径）；省略视为 default
 * @property {string} [projectRoot] 原始项目根（未归一化；建工作树用）
 * @property {'none' | 'worktree'} [isolation] 覆盖本次隔离方式
 * @property {object} [context] 宿主上下文（如 exec.agent），原样透传给适配器
 * @property {object} [registry] 覆盖本次解析用的注册表（按项目上下文注入全局+项目覆盖）
 */

/**
 * @typedef {object} AdapterStartInput
 * @property {object} role 已解析的角色
 * @property {string} task
 * @property {any} [taskSpec] TaskSpec（原样透传，由适配器渲染提示词与落盘摘要）
 * @property {any} [contextPack] ContextPack（原样透传）
 * @property {{ roleId: string, reason?: string, auto: boolean }} [routing] 路由结果（P1-B，落盘用）
 * @property {string} [cwd]
 * @property {number} timeoutMs
 * @property {object} [context] 由调用方透传的宿主上下文
 * @property {() => void} onFinish 任务终态回调（适配器必须在完成/失败/取消时调用一次）
 * @property {'none' | 'worktree'} [isolation]
 * @property {string} [operationId]
 * @property {{ path: string, branch: string, baseSha: string, repositoryRoot: string, operationId: string }} [worktree]
 */

/**
 * @typedef {object} DispatchAdapter
 * @property {(input: AdapterStartInput) => Promise<{ taskRef: object }>} start
 * @property {(taskRef: object | string) => Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>} [cancel]
 * @property {(role: object) => { ok: boolean, reason?: string }} [canStart]
 * @property {(childIds: string[], timeoutMs?: number) => Promise<object>} [waitForSettled]
 */

/**
 * @typedef {{ ok: true, taskRef: object, role: object, startedAt: number, isolation?: string,
 *             operationId?: string, worktree?: object,
 *             routing?: { roleId: string, reason?: string, auto: boolean } }
 *   | { ok: false, code: string, message: string, role?: object,
 *       operationId?: string, worktree?: object, residualPath?: string,
 *       path?: string, branch?: string, phase?: string }} DispatchResult
 */

/**
 * @param {{ registry: { resolve: (ref: string) => any, list: () => any[] },
 *           adapter: DispatchAdapter,
 *           limits?: { serializeWrites?: boolean, maxParallelWritesTotal?: number,
 *                      defaultIsolation?: 'none' | 'worktree' },
 *           worktrees?: { create: (input: { projectRoot: string, operationId: string }) => Promise<any> } | null,
 *           now?: () => number,
 *           versionFingerprint?: (projectRoot: unknown) => string }} deps
 */
export function createDispatcher({ registry, adapter, limits = {}, worktrees = null, now = () => Date.now(), versionFingerprint = defaultVersionFingerprint }) {
  const serializeWrites = limits.serializeWrites !== false
  const maxParallelWritesTotal = positiveInteger(limits.maxParallelWritesTotal, 4)
  // 注意：这里缺省为 none（纯 dispatcher 单测/旧装配的兼容默认）；用户可见默认由
  // src/config.js 的 limits.defaultIsolation='worktree' 提供，index.js 会原样传入。
  const defaultIsolation = limits.defaultIsolation === 'worktree' ? 'worktree' : 'none'

  /** @type {Map<object, { role: any, projectKey: string, startedAt: number, ref: object | null,
   *   isolation: 'none' | 'worktree', operationId: string | null, worktree: any,
   *   phase: 'reserved' | 'starting' | 'started' }>} */
  const active = new Map()
  /** @type {Map<object, object>} taskRef -> token */
  const refToToken = new Map()
  /**
   * 进行中任务去重索引（P0-D）：fingerprint -> reservation。仅内存，重启失效。
   * 只存「进行中」条目：终态由 release() 删除，绝不复用已完成任务结果。
   * @type {Map<string, { token: object, entry: any, fingerprint: string,
   *   promise: Promise<any>, resolve: (v: any) => void, result: any, settled: boolean }>}
   */
  const inProgress = new Map()

  /**
   * 创建「已占位、等首个任务拿到 taskRef」的 reservation（受控 pending promise）。
   * 并发相同请求命中它时 await promise，拿到首个 taskRef 后返回去重回执。
   * @param {string} fp
   * @param {object} token
   * @param {any} entry
   */
  function makeReservation(fp, token, entry) {
    /** @type {(v: any) => void} */
    let resolve = () => {}
    const promise = new Promise((r) => {
      resolve = r
    })
    return { token, entry, fingerprint: fp, promise, resolve, result: null, settled: false }
  }

  /** 给等待者一个确定结果（成功或失败），只解析一次。 @param {any} reservation @param {any} result */
  function settleReservation(reservation, result) {
    if (!reservation || reservation.result !== null) return
    reservation.result = result
    reservation.resolve(result)
  }

  /** 从去重索引移除该 reservation（终态清理，幂等）。 @param {any} reservation */
  function dropFromIndex(reservation) {
    if (!reservation) return
    reservation.settled = true
    if (inProgress.get(reservation.fingerprint) === reservation) {
      inProgress.delete(reservation.fingerprint)
    }
  }

  /** 命中相同进行中任务的回执：原 taskRef / 当前状态 / deduplicated 标记。 */
  function deduplicatedResult(reservation, first, fingerprint) {
    const entry = reservation.entry
    const ref = first.taskRef && typeof first.taskRef === 'object' ? first.taskRef : {}
    return {
      ok: true,
      deduplicated: true,
      taskRef: first.taskRef, // 原值：原 childId / jobId
      role: entry.role,
      ...(entry.routing ? { routing: entry.routing } : {}),
      isolation: entry.isolation,
      status: entry.phase === 'started' ? 'running' : 'queued',
      startedAt: entry.startedAt,
      deduplicatedFrom: ref.childId ?? ref.id ?? ref.sessionId ?? ref.jobId ?? fingerprint,
    }
  }

  /**
   * @param {string} projectKey
   * @returns {Array<any>}
   */
  function entriesFor(projectKey) {
    /** @type {Array<any>} */
    const entries = []
    for (const entry of active.values()) {
      if (entry.projectKey === projectKey) entries.push(entry)
    }
    return entries
  }

  /**
   * 在**任何 await 之前**做完整准入检查。返回 null 表示可以占槽。
   *
   * 只有两类拒绝：
   * - 同项目的隔离/未隔离互斥（正确性保护，与并发额度无关）
   * - 本插件全局并行写任务上限（只统计本插件派发的任务；宿主容量不在这里）
   *
   * **本项目不排队**：超限立即拒绝，由调用方稍后重试。
   *
   * @param {string} projectKey
   * @param {'none' | 'worktree'} isolation
   * @returns {{ code: string, message: string } | null}
   */
  function admissionFailure(projectKey, isolation) {
    const entries = entriesFor(projectKey)
    const hasWorktree = entries.some((entry) => entry.isolation === 'worktree')
    const hasNone = entries.some((entry) => entry.isolation === 'none')

    if (isolation === 'none') {
      if (hasWorktree) {
        return {
          code: DISPATCH_ERRORS.WRITE_CONFLICT,
          message: '同一项目已有隔离任务在执行；关闭隔离的派单不得与隔离任务混跑',
        }
      }
      if (serializeWrites && entries.length > 0) {
        return {
          code: DISPATCH_ERRORS.WRITE_CONFLICT,
          message:
            '同一项目已有任务在执行；写入主工作区必须串行（正确性保护，不是并发额度；' +
            '可在插件全局配置里调整 limits.serializeWrites）',
        }
      }
    } else if (hasNone) {
      return {
        code: DISPATCH_ERRORS.WRITE_CONFLICT,
        message: '同一项目已有未隔离任务在执行；隔离任务不得与未隔离任务混跑',
      }
    }

    if (active.size >= maxParallelWritesTotal) {
      return {
        code: DISPATCH_ERRORS.WRITE_LIMIT_TOTAL,
        message:
          `本插件派发的并行写任务已达上限 ${maxParallelWritesTotal}（不含宿主的子 Agent 容量）；` +
          '请等待现有任务完成或调大 limits.maxParallelWritesTotal 后重试（本项目不排队）',
      }
    }
    return null
  }

  /**
   * 释放一个槽位。按 token / taskRef / childId 都可以，重复调用幂等。
   * `failureResult` 仅供「启动阶段失败」时给去重等待者一个确定结果，避免它们挂在
   * pending promise 上；正常终态（onFinish / cancel）不传，reservation 已带成功结果。
   * @param {object | string | null | undefined} key
   * @param {any} [failureResult]
   */
  function release(key, failureResult) {
    if (!key) return false
    // 允许传 taskRef
    let token = refToToken.get(key) ?? key
    // 允许传 childId（工具层按 childId 取消时只能给字符串）
    if (!active.has(token) && typeof key === 'string') {
      for (const [candidate, entry] of active) {
        const refChildId =
          entry.ref && typeof entry.ref === 'object'
            ? entry.ref.childId ?? entry.ref.id ?? entry.ref.sessionId
            : null
        if (refChildId !== undefined && refChildId !== null && String(refChildId) === key) {
          token = candidate
          break
        }
      }
    }
    const entry = active.get(token)
    if (!entry) return false
    active.delete(token)
    if (entry.ref) refToToken.delete(entry.ref)
    // P0-D：终态清理去重索引。完成的条目不再对相同请求去重（不复用旧结果）。
    const reservation = entry.reservation
    if (reservation) {
      if (reservation.result === null) {
        settleReservation(
          reservation,
          failureResult ?? fail(DISPATCH_ERRORS.ADAPTER_FAILED, '派发失败：任务未启动'),
        )
      }
      dropFromIndex(reservation)
    }
    return true
  }

  /**
   * 失败并回滚：释放额度 + 清理去重索引 + 给等待者失败结果，再返回失败结果。
   * @param {object} token
   * @param {string} code
   * @param {string} message
   * @param {object} [extra]
   */
  function releaseOnFailure(token, code, message, extra) {
    const result = fail(code, message, extra)
    release(token, result)
    return result
  }

  /**
   * 派发一次任务。
   * @param {DispatchRequest} req
   * @returns {Promise<DispatchResult>}
   */
  async function dispatch(req) {
    if (!req || typeof req.role !== 'string' || !req.role.trim()) {
      // P1-B：自动路由在工具层完成，到达这里时 role 必须已是具体角色引用。
      // 未指定 role（且没有开 autoRoute）在工具层已返回 ROLE_REQUIRED；这里同样
      // 用 ROLE_REQUIRED，避免直接调用 dispatcher 时拿到会误导的 ROLE_NOT_FOUND。
      return fail(
        DISPATCH_ERRORS.ROLE_REQUIRED,
        '必须提供角色名、别名或 roleId（自动路由请在 meetingstone_dispatch 传 autoRoute:true）',
      )
    }
    if (typeof req.task !== 'string' || !req.task.trim()) {
      return fail(DISPATCH_ERRORS.INVALID_TASK, '任务内容不能为空')
    }
    if (req.isolation !== undefined && !ISOLATION_MODES.includes(req.isolation)) {
      return fail(
        DISPATCH_ERRORS.INVALID_ISOLATION,
        `isolation 必须是 none | worktree，收到 ${JSON.stringify(req.isolation)}`,
      )
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

    // 3. 并发纪律：**先占槽再启动**，本插件的全局额度在任何 await 之前预占；所有派单都按写任务计数。
    //    项目身份用 realpath 归一化：`原路径` 与 `原路径/src/..`、junction/symlink
    //    必须折到同一个 key，否则隔离互斥会被别名绕过（P1）。
    //    两个候选字段里只要有一个能 realpath 成功，就以真实路径为准；都失败才退回字符串键。
    const projectKey =
      (await realpathProjectKey(req.projectKey)) ??
      (await realpathProjectKey(req.projectRoot)) ??
      normalizeProjectKey(req.projectKey) ??
      normalizeProjectKey(req.projectRoot) ??
      DEFAULT_PROJECT_KEY
    const isolation = req.isolation ?? defaultIsolation

    // 3.5 P0-D 去重判定：**在占额度 / 建树 / 启动之前**。版本指纹同步取当前 HEAD；
    //     取不到（unknown）→ 信息不足，不进索引也不命中索引，正常创建新任务（不误合）。
    const version = versionFingerprint(
      typeof req.projectRoot === 'string' && req.projectRoot
        ? req.projectRoot
        : typeof req.context?.projectRoot === 'string'
          ? req.context.projectRoot
          : null,
    )
    const fingerprint = computeFingerprint({ req, role, projectKey, isolation, version })

    if (fingerprint !== null) {
      // 命中相同「进行中」占位：等首个任务拿到 taskRef 后返回既有引用（受控 pending promise）。
      // 有限重试覆盖「首个其实没启动成功 / 已完成（占位已被清理）」的边界：重新判定并创建。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = inProgress.get(fingerprint)
        if (!existing) break
        const first = await existing.promise
        if (first?.ok === true && active.has(existing.token)) {
          // 首个任务仍在进行中：不占额度、不建树、不创建第二个子任务。
          return deduplicatedResult(existing, first, fingerprint)
        }
        // 首个失败或已结束：占位已由 release() 清理，再查一次；无占位就走创建。
      }
    }

    const blocked = admissionFailure(projectKey, isolation)
    if (blocked) return fail(blocked.code, blocked.message)

    /** @type {object} */
    const token = {}
    /** @type {any} */
    const entry = {
      role,
      routing: req.routing && typeof req.routing === 'object' ? req.routing : null,
      projectKey,
      startedAt: now(),
      ref: null,
      isolation,
      operationId: null,
      worktree: null,
      phase: 'reserved',
      fingerprint,
      reservation: null,
    }
    // 同步占位：active（额度）与 inProgress（去重索引）之间没有任何 await，
    // 两个并发相同请求不可能都通过判定（先占位再启动）。
    active.set(token, entry)
    let reservation = null
    if (fingerprint !== null) {
      reservation = makeReservation(fingerprint, token, entry)
      entry.reservation = reservation
      inProgress.set(fingerprint, reservation)
    }
    /** @type {() => void} */
    const onFinish = () => {
      release(token)
    }

    // 4. 隔离：在 adapter.start 之前建树；失败释放额度并拒绝派单（绝不退回主工作区）
    let worktree = null
    let operationId = null
    let taskCwd = req.cwd
    if (isolation === 'worktree') {
      if (!worktrees || typeof worktrees.create !== 'function') {
        return releaseOnFailure(
          token,
          DISPATCH_ERRORS.WORKTREE_UNAVAILABLE,
          '请求了工作树隔离，但工作树服务不可用；拒绝派单（不会退回主工作区）',
        )
      }
      const projectRoot =
        typeof req.projectRoot === 'string' && req.projectRoot
          ? req.projectRoot
          : typeof req.context?.projectRoot === 'string'
            ? req.context.projectRoot
            : null
      if (!projectRoot) {
        return releaseOnFailure(
          token,
          DISPATCH_ERRORS.PROJECT_ROOT_UNKNOWN,
          '请求了工作树隔离，但无法确定项目根；拒绝派单（不会退回主工作区）',
        )
      }
      operationId = randomUUID()
      entry.operationId = operationId
      entry.phase = 'starting'
      try {
        worktree = await worktrees.create({ projectRoot, operationId })
      } catch (err) {
        const rawCode = /** @type {any} */ (err)?.code
        const code =
          typeof rawCode === 'string' && rawCode.startsWith(WORKTREE_CODE_PREFIX)
            ? rawCode
            : DISPATCH_ERRORS.WORKTREE_GIT_FAILED
        return releaseOnFailure(token, code, `创建工作树失败：${errorMessage(err)}`, {
          operationId,
          // path/branch/phase/residualPath 全部透传：三阶段异常都靠它们定位（F5）
          ...errorContext(err),
        })
      }
      if (!worktree || typeof worktree.path !== 'string' || !worktree.path) {
        return releaseOnFailure(
          token,
          DISPATCH_ERRORS.WORKTREE_GIT_FAILED,
          '创建工作树失败：工作树服务没有返回有效 path',
          { operationId },
        )
      }
      entry.worktree = worktree
      entry.operationId = worktree.operationId ?? operationId
      operationId = entry.operationId
      taskCwd = worktree.path
    }

    // 5. 交给宿主适配器
    //    把原始 projectRoot 补进 context：落盘层需要它定位 `.meetingstone/runs`；
    //    调用方已给的 agent 等上下文原样保留。
    const startContext = {
      ...(req.context && typeof req.context === 'object' ? req.context : {}),
      ...(typeof req.projectRoot === 'string' && req.projectRoot
        ? { projectRoot: req.projectRoot }
        : {}),
    }
    let started
    try {
      started = await adapter.start({
        role,
        task: req.task,
        // P1-B：路由结果原样交给适配器，落盘后可用 get_task/list_runs 解释「为什么是它」
        ...(req.routing && typeof req.routing === 'object' ? { routing: req.routing } : {}),
        // P0-B：结构化简报原样交给适配器（提示词组装与落盘摘要都在那里做）
        ...(req.taskSpec && typeof req.taskSpec === 'object' ? { taskSpec: req.taskSpec } : {}),
        ...(req.contextPack && typeof req.contextPack === 'object'
          ? { contextPack: req.contextPack }
          : {}),
        // 隔离模式下 cwd 必须是工作树；显式传入的 cwd 不能绕过隔离
        cwd: taskCwd,
        timeoutMs: role.timeoutMs,
        ...(Object.keys(startContext).length > 0 ? { context: startContext } : {}),
        // 上下文重放块（P1）：由工具层解析好后透传，适配器只负责拼进提示词
        ...(req.continuation ? { continuation: req.continuation } : {}),
        isolation,
        ...(operationId ? { operationId } : {}),
        ...(worktree ? { worktree } : {}),
        onFinish,
      })
    } catch (err) {
      // 适配器明确要求保留槽位（例如卸载后迟到 activation 的 dispose 未确认）时不得释放：
      // 停止状态未确认，释放槽位会让仍可能存活的进程绕过并发纪律（F1）。
      const slotPreserved = /** @type {any} */ (err)?.slotPreserved === true
      const raw = err instanceof Error ? err.message : String(err)
      const result = fail(adapterErrorCode(raw, err), `派发失败：${raw}`, {
        ...(operationId ? { operationId } : {}),
        ...(worktree ? { worktree } : {}),
        ...errorContext(err, worktree),
      })
      if (slotPreserved) {
        // 槽位保留：仍解析占位并清理去重索引，避免相同请求一直挂在 pending promise 上。
        settleReservation(reservation, result)
        dropFromIndex(reservation)
      } else {
        release(token, result)
      }
      return result
    }
    if (!started || !started.taskRef) {
      return releaseOnFailure(
        token,
        DISPATCH_ERRORS.ADAPTER_FAILED,
        '派发失败：适配器没有返回任务引用',
        {
          ...(operationId ? { operationId } : {}),
          ...(worktree ? { worktree } : {}),
          ...errorContext(null, worktree),
        },
      )
    }

    const current = active.get(token)
    if (current) {
      current.ref = started.taskRef
      current.phase = 'started'
    }
    refToToken.set(started.taskRef, token)

    const success = {
      ok: true,
      taskRef: started.taskRef,
      role,
      ...(req.routing && typeof req.routing === 'object' ? { routing: req.routing } : {}),
      startedAt: now(),
      isolation,
      ...(operationId ? { operationId } : {}),
      ...(worktree ? { worktree } : {}),
    }
    // 首个任务已拿到 taskRef：解析占位 promise，后续相同请求即可命中去重。
    settleReservation(reservation, success)
    return success
  }

  /**
   * 取消：让宿主取消；**只有拿到可验证的停止结果**（`{ stopConfirmed: true }`）
   * 才释放槽位。dispose 超时/抛错时保留槽位与隔离互斥，避免旧进程未退干净就派新写任务。
   * 适配器不支持取消、或没有返回确认，一律按「未确认」处理（fail-safe）。
   * **不删除工作树**：未合并改动留在树里，人工处理。
   *
   * @param {object | string} taskRef
   * @returns {Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>}
   */
  async function cancel(taskRef) {
    if (!taskRef) return { stopConfirmed: false, reason: '缺少任务引用' }
    let outcome
    try {
      if (adapter.cancel) outcome = await adapter.cancel(taskRef)
    } catch (err) {
      // 适配器自己没确认停止：保留槽位，错误如实返回给工具层
      return { stopConfirmed: false, reason: errorMessage(err) }
    }
    const stopConfirmed = Boolean(outcome && outcome.stopConfirmed === true)
    if (stopConfirmed) release(taskRef)
    return {
      stopConfirmed,
      ...(outcome && typeof outcome.code === 'string' ? { code: outcome.code } : {}),
      ...(outcome && typeof outcome.message === 'string' ? { message: outcome.message } : {}),
      ...(outcome && typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}),
      ...(!stopConfirmed && !adapter.cancel ? { reason: '适配器不支持取消，无法确认停止状态' } : {}),
    }
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

  /**
   * 等待一组任务全部到达终态（或超时）。适配器不支持时如实返回不可用，不假装已等待。
   * @param {string[]} childIds
   * @param {number} [timeoutMs]
   */
  async function waitForSettled(childIds, timeoutMs) {
    if (typeof adapter.waitForSettled !== 'function') {
      return { ok: false, code: 'WAIT_UNAVAILABLE', message: '当前适配器不支持等待任务终态' }
    }
    return adapter.waitForSettled(childIds, timeoutMs)
  }

  return {
    dispatch,
    release,
    cancel,
    getTask,
    waitForSettled,
    // P0-D：进行中索引规模（仅用于测试/诊断，不暴露索引内容）。
    dedupIndexSize: () => inProgress.size,
    stats: (projectKey) => {
      if (typeof projectKey === 'string') {
        const key = normalizeProjectKey(projectKey) ?? DEFAULT_PROJECT_KEY
        const writes = entriesFor(key).length
        return { active: writes, writes, serializeWrites }
      }
      return { active: active.size, writes: active.size, serializeWrites }
    },
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ operationId?: string, worktree?: object, residualPath?: string,
 *           path?: string, branch?: string, phase?: string }} [extra]
 * @returns {{ ok: false, code: string, message: string }}
 */
function fail(code, message, extra) {
  return { ok: false, code, message, ...(extra ?? {}) }
}
