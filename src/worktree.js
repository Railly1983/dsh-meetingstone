// @ts-check
/**
 * 任务级 git 工作树隔离（路 2：插件自建 `git worktree`）。
 *
 * 为什么不用宿主 `ctx.worktrees.create()`（2026-11-11 悟空裁决）：
 * 宿主服务内部会 `workingDirectory.set(agent, path)` 把**父会话**的 cwd 切到工作树；
 * create→restore 之间没有事务锁，restore 可能被宿主其他调用覆盖。恢复失败会把父会话
 * 留在工作树里，风险不可接受。本模块只接管 git 工作树管理，不碰会话目录。
 *
 * 安全边界（必须如实理解）：
 * - 这是**文件布局隔离**，不是权限沙箱。子 Agent 仍在同一系统账号下运行，
 *   可以 cd 到主工作区写文件；工作树只保证"默认 cwd 不同、改动不直接落主工作区"。
 * - 所有 git 调用使用 literal argv（`execFile`，`shell:false`），清理 `GIT_*` 环境变量，
 *   禁止交互式认证，带超时与输出上限。
 * - 建树按 git common-dir 做**进程内**互斥：同一进程不并发 `worktree add`；
 *   跨进程并发仍可能争 git 锁（未验证，文档如实标注）。
 *
 * 清理策略：**一律不自动删除**工作树/分支（完成/失败/取消/卸载都不删）。
 * 未合并的改动可能只在工作树里，自动删除等于丢代码。人工清理见 docs/worktree-isolation.md。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 相对项目根的工作树目录（本仓库已在 .gitignore 里忽略 `.meetingstone/`）。 */
export const WORKTREE_RELATIVE_DIR = '.meetingstone/worktrees'
/** 分支前缀。分支名 = `<prefix><operationId>`。 */
export const WORKTREE_BRANCH_PREFIX = 'meetingstone/'
/** 单条 git 命令的默认超时。 */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000
/** 建树类 git 命令的输出上限（字节）。 */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 1024 * 1024
/** `git status` / `git diff` 的输出上限（大仓库可能文件很多）。 */
export const DEFAULT_CHANGED_FILES_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** 计算改动文件列表的默认超时（取消/卸载路径会 await 它，不能太久）。 */
export const DEFAULT_CHANGED_FILES_TIMEOUT_MS = 10_000

/** 错误码：工具层原样透传，便于调用方分支处理。 */
export const WORKTREE_ERRORS = Object.freeze({
  NOT_GIT_REPOSITORY: 'WORKTREE_NOT_GIT_REPOSITORY',
  BASE_INVALID: 'WORKTREE_BASE_INVALID',
  PATH_EXISTS: 'WORKTREE_PATH_EXISTS',
  BRANCH_EXISTS: 'WORKTREE_BRANCH_EXISTS',
  GIT_FAILED: 'WORKTREE_GIT_FAILED',
  TIMEOUT: 'WORKTREE_TIMEOUT',
  PATH_OUTSIDE: 'WORKTREE_PATH_OUTSIDE',
})

/** operationId 必须能安全地做路径段与分支段（randomUUID 满足）。 */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** 带错误码与残留位置的工作树错误。 */
export class WorktreeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ path?: string, branch?: string, phase?: string, cause?: unknown, [key: string]: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'WorktreeError'
    this.code = code
    if (typeof details.path === 'string' && details.path) this.path = details.path
    if (typeof details.branch === 'string' && details.branch) this.branch = details.branch
    if (typeof details.phase === 'string' && details.phase) this.phase = details.phase
    if (details.cause !== undefined) this.cause = details.cause
    this.details = details
  }
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/** @param {unknown} err @returns {err is { code?: unknown, path?: unknown, details?: any }} */
function isCodedError(err) {
  return err !== null && typeof err === 'object'
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ path?: string, branch?: string, phase?: string, cause?: unknown, [key: string]: unknown }} [details]
 */
function fail(code, message, details = {}) {
  return new WorktreeError(code, message, details)
}

/**
 * 清掉所有 `GIT_*` 环境变量并强制非交互。
 *
 * 为什么：`GIT_DIR` / `GIT_WORK_TREE` 会把命令指到别的仓库；`GIT_ASKPASS`、
 * `GIT_TERMINAL_PROMPT` 可能弹出凭据输入把派单挂死。工作树管理不需要任何凭据。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export function sanitizedGitEnv(source = process.env) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    if (key.toUpperCase().startsWith('GIT_')) continue
    out[key] = value
  }
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

/**
 * 默认 git 执行器：literal argv、无 shell、超时、输出上限。
 * 返回结构化结果而不是抛异常，便于把超时映射成专门错误码。
 *
 * @typedef {object} GitRunRequest
 * @property {string[]} args
 * @property {string} cwd
 * @property {Record<string, string>} env
 * @property {number} timeoutMs
 * @property {number} maxOutputBytes
 *
 * @typedef {object} GitRunResult
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} [timedOut]
 * @property {string} [spawnError]
 *
 * @param {GitRunRequest} request
 * @returns {Promise<GitRunResult>}
 */
export function defaultGitRunner(request) {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      request.args,
      {
        cwd: request.cwd,
        env: request.env,
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
        // 不让 git 拉起 shell；execFile 本身就是 literal argv。
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({
            code: 0,
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
            timedOut: false,
          })
          return
        }
        const timedOut = error.killed === true || error.code === 'ETIMEDOUT'
        resolvePromise({
          code: typeof error.code === 'number' ? error.code : null,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          timedOut,
          ...(typeof error.code === 'string' ? { spawnError: error.code } : {}),
        })
      },
    )
  })
}

/**
 * 从 git 选项里摘出残留位置信息，供所有 WORKTREE_* 错误统一携带。
 * @param {{ path?: string, branch?: string, phase?: string } | undefined} options
 */
function contextDetails(options) {
  /** @type {{ path?: string, branch?: string, phase?: string }} */
  const out = {}
  if (options && typeof options.path === 'string' && options.path) out.path = options.path
  if (options && typeof options.branch === 'string' && options.branch) out.branch = options.branch
  if (options && typeof options.phase === 'string' && options.phase) out.phase = options.phase
  return out
}

/**
 * 执行一条 git 命令；超时直接抛 `WORKTREE_TIMEOUT`，其余结果交给调用方判断 code。
 *
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} options.timeoutMs
 * @param {number} options.maxOutputBytes
 * @param {((request: GitRunRequest) => Promise<GitRunResult>) | undefined} [options.gitRunner]
 * @param {string} [options.label] 出错时用于说明是哪一步
 * @param {string} [options.path] 工作树目标路径（错误残留位置）
 * @param {string} [options.branch] 工作树分支（错误上下文）
 * @param {string} [options.phase] 失败阶段（错误上下文）
 * @returns {Promise<GitRunResult>}
 */
async function runGit(args, options) {
  const runner = options.gitRunner ?? defaultGitRunner
  const label = options.label ?? `git ${args.join(' ')}`
  const context = contextDetails(options)
  let result
  try {
    result = await runner({
      args,
      cwd: options.cwd,
      env: sanitizedGitEnv(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    })
  } catch (err) {
    if (isCodedError(err) && typeof err.code === 'string' && err.code.startsWith('WORKTREE_')) {
      throw err
    }
    throw fail(WORKTREE_ERRORS.GIT_FAILED, `${label} 执行失败：${errorMessage(err)}`, {
      ...context,
      cause: err,
    })
  }
  if (!result || typeof result !== 'object') {
    throw fail(WORKTREE_ERRORS.GIT_FAILED, `${label} 没有返回结果`, context)
  }
  if (result.timedOut) {
    throw fail(WORKTREE_ERRORS.TIMEOUT, `${label} 超过 ${options.timeoutMs}ms 未完成`, {
      ...context,
      timeoutMs: options.timeoutMs,
    })
  }
  return result
}

/** @param {string} value */
function gitFailureDetail(value) {
  return String(value ?? '').trim().slice(0, 500)
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await fs.lstat(path)
    return true
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return false
    throw err
  }
}

/**
 * realpath，但允许路径（或其尾部）尚不存在：对不存在的尾部逐段拼接回去。
 * 用于在建树**之前**判断 `.meetingstone/worktrees/...` 会不会经 junction/symlink 逃出项目根。
 * @param {string} path
 * @returns {Promise<string>}
 */
async function realpathAllowMissing(path) {
  let current = resolve(path)
  /** @type {string[]} */
  const suffix = []
  for (;;) {
    try {
      const real = await fs.realpath(current)
      return suffix.length > 0 ? resolve(real, ...suffix.reverse()) : real
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      suffix.push(basename(current))
      current = parent
    }
  }
}

/** Windows 大小写不敏感；比较前统一。 */
function normalizeForCompare(path) {
  const abs = resolve(path)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * child 是否在 root 内（规范化后按路径段比较，避免 `C:\proj-evil` 冒充 `C:\proj`）。
 * @param {string} child
 * @param {string} root
 */
function isPathInside(child, root) {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(child))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 进程内互斥：按 git common-dir 串行化建树。
 *
 * 为什么需要：Windows 上并发 `git worktree add` 会争 `.git/worktrees` 下的锁，
 * 失败重试还会留下半登记状态。任务执行可以并行，建树这一步串行即可。
 *
 * @type {Map<string, Promise<void>>}
 */
const repoLocks = new Map()

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withRepoLock(key, task) {
  const previous = repoLocks.get(key) ?? Promise.resolve()
  /** @type {() => void} */
  let release = () => {}
  const gate = new Promise((resolveGate) => {
    release = /** @type {() => void} */ (resolveGate)
  })
  const queued = previous.then(() => gate)
  repoLocks.set(key, queued)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (repoLocks.get(key) === queued) repoLocks.delete(key)
  }
}

/**
 * 查分支是否存在。
 * @param {string} repositoryRoot
 * @param {string} branch
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function branchExists(repositoryRoot, branch, options) {
  const result = await runGit(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    {
      ...options,
      cwd: repositoryRoot,
      label: `检查分支 ${branch}`,
      branch,
      phase: options.phase ?? 'check-branch',
    },
  )
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw fail(
    WORKTREE_ERRORS.GIT_FAILED,
    `检查分支 ${branch} 失败：${gitFailureDetail(result.stderr) || `退出码 ${result.code}`}`,
    { ...contextDetails(options), branch, phase: options.phase ?? 'check-branch' },
  )
}

/**
 * 列出已登记的 worktree 路径（用于识别"目录被手工删了但 git 还登记着"）。
 * @param {string} repositoryRoot
 * @param {object} options
 * @returns {Promise<string[]>}
 */
async function listRegisteredWorktrees(repositoryRoot, options) {
  const result = await runGit(['worktree', 'list', '--porcelain'], {
    ...options,
    cwd: repositoryRoot,
    label: '列出工作树',
    phase: 'list-worktrees',
  })
  if (result.code !== 0) {
    throw fail(
      WORKTREE_ERRORS.GIT_FAILED,
      `列出工作树失败：${gitFailureDetail(result.stderr) || `退出码 ${result.code}`}`,
      { ...contextDetails(options), phase: 'list-worktrees' },
    )
  }
  /** @type {string[]} */
  const paths = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length))
  }
  return paths
}

/**
 * 创建一个派单专用工作树。
 *
 * 约定：
 * - 路径固定为 `<projectRoot>/.meetingstone/worktrees/<operationId>`
 * - 分支固定为 `meetingstone/<operationId>`；已存在则失败，绝不覆盖
 * - `base` 缺省为 `HEAD`；解析成 commit SHA 后再建树，避免"分支名歧义"
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目根（当前会话 cwd）
 * @param {string} input.operationId 本次操作 ID（randomUUID）
 * @param {string} [input.base] 基线引用，默认 HEAD
 * @param {((request: GitRunRequest) => Promise<GitRunResult>) | undefined} [input.gitRunner]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.maxOutputBytes]
 * @returns {Promise<{ path: string, branch: string, baseSha: string, repositoryRoot: string, operationId: string }>}
 */
export async function createDispatchWorktree(input) {
  const projectRoot = typeof input?.projectRoot === 'string' ? input.projectRoot.trim() : ''
  const operationId = typeof input?.operationId === 'string' ? input.operationId.trim() : ''
  const timeoutMs =
    Number.isFinite(input?.timeoutMs) && /** @type {number} */ (input.timeoutMs) > 0
      ? /** @type {number} */ (input.timeoutMs)
      : DEFAULT_GIT_TIMEOUT_MS
  const maxOutputBytes =
    Number.isFinite(input?.maxOutputBytes) && /** @type {number} */ (input.maxOutputBytes) > 0
      ? /** @type {number} */ (input.maxOutputBytes)
      : DEFAULT_GIT_MAX_OUTPUT_BYTES

  if (!projectRoot) {
    throw fail(WORKTREE_ERRORS.NOT_GIT_REPOSITORY, '缺少项目根，无法创建工作树', {
      phase: 'validate-input',
    })
  }
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw fail(
      WORKTREE_ERRORS.PATH_OUTSIDE,
      `operationId 不合法（会逃出工作树根目录）：${JSON.stringify(operationId)}`,
      { phase: 'validate-input' },
    )
  }

  const resolvedProjectRoot = resolve(projectRoot)
  /** @type {string} */
  let realProjectRoot
  try {
    realProjectRoot = await fs.realpath(resolvedProjectRoot)
  } catch {
    throw fail(
      WORKTREE_ERRORS.NOT_GIT_REPOSITORY,
      `项目根不存在或不可访问：${resolvedProjectRoot}`,
      { path: resolvedProjectRoot, phase: 'resolve-project-root' },
    )
  }

  const worktreesRoot = resolve(realProjectRoot, WORKTREE_RELATIVE_DIR)
  const targetPath = resolve(worktreesRoot, operationId)
  const branch = `${WORKTREE_BRANCH_PREFIX}${operationId}`
  if (!isPathInside(targetPath, realProjectRoot)) {
    throw fail(WORKTREE_ERRORS.PATH_OUTSIDE, `工作树路径逃出项目根：${targetPath}`, {
      path: targetPath,
      branch,
      phase: 'validate-path',
    })
  }
  const options = {
    timeoutMs,
    maxOutputBytes,
    gitRunner: typeof input.gitRunner === 'function' ? input.gitRunner : undefined,
    // 所有 WORKTREE_* 错误都带残留位置，便于人工清理（P2）
    path: targetPath,
    branch,
  }

  // 1) 必须是 git 仓库（拿不到 top-level 就失败关闭）
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], {
    ...options,
    cwd: resolvedProjectRoot,
    label: '检查 git 仓库',
    phase: 'check-repository',
  })
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw fail(
      WORKTREE_ERRORS.NOT_GIT_REPOSITORY,
      `${resolvedProjectRoot} 不是 git 工作区，无法创建隔离工作树`,
      { path: targetPath, branch, phase: 'check-repository' },
    )
  }
  const top = await runGit(['rev-parse', '--show-toplevel'], {
    ...options,
    cwd: resolvedProjectRoot,
    label: '读取仓库根',
    phase: 'read-toplevel',
  })
  if (top.code !== 0 || !top.stdout.trim()) {
    throw fail(
      WORKTREE_ERRORS.NOT_GIT_REPOSITORY,
      `无法读取 ${resolvedProjectRoot} 的仓库根：${gitFailureDetail(top.stderr)}`,
      { path: targetPath, branch, phase: 'read-toplevel' },
    )
  }
  const repositoryRoot = resolve(top.stdout.trim())

  // 2) common-dir 作为建树互斥键（worktree 的 .git 是文件，common-dir 才是共享元数据）
  let common = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    ...options,
    cwd: resolvedProjectRoot,
    label: '读取 git common-dir',
    phase: 'read-common-dir',
  })
  if (common.code !== 0) {
    // 老版本 git 没有 --path-format；退回相对路径再解析
    common = await runGit(['rev-parse', '--git-common-dir'], {
      ...options,
      cwd: resolvedProjectRoot,
      label: '读取 git common-dir',
      phase: 'read-common-dir',
    })
  }
  if (common.code !== 0 || !common.stdout.trim()) {
    throw fail(
      WORKTREE_ERRORS.GIT_FAILED,
      `无法读取 git common-dir：${gitFailureDetail(common.stderr)}`,
      { path: targetPath, branch, phase: 'read-common-dir' },
    )
  }
  const commonRaw = common.stdout.trim()
  const commonDir = isAbsolute(commonRaw) ? resolve(commonRaw) : resolve(resolvedProjectRoot, commonRaw)
  const lockKey = normalizeForCompare(commonDir)

  // 3) base 必须可解析成 commit；解析后的 SHA 用于建树，避免分支名歧义
  const baseRef = typeof input.base === 'string' && input.base.trim() ? input.base.trim() : 'HEAD'
  const baseResult = await runGit(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
    ...options,
    cwd: resolvedProjectRoot,
    label: `解析基线 ${baseRef}`,
    phase: 'resolve-base',
  })
  const baseSha = baseResult.stdout.trim()
  if (baseResult.code !== 0 || !baseSha) {
    throw fail(
      WORKTREE_ERRORS.BASE_INVALID,
      `基线 ${JSON.stringify(baseRef)} 无法解析为 commit`,
      { path: targetPath, branch, phase: 'resolve-base' },
    )
  }

  // 4) 路径不得存在（含 git 已登记但目录被删的情况）
  if (await pathExists(targetPath)) {
    throw fail(WORKTREE_ERRORS.PATH_EXISTS, `工作树路径已存在：${targetPath}`, {
      path: targetPath,
      branch,
      phase: 'precheck-path',
    })
  }
  const registered = await listRegisteredWorktrees(repositoryRoot, options)
  if (registered.some((p) => normalizeForCompare(p) === normalizeForCompare(targetPath))) {
    throw fail(WORKTREE_ERRORS.PATH_EXISTS, `工作树路径已被 git 登记：${targetPath}`, {
      path: targetPath,
      branch,
      phase: 'precheck-registered',
    })
  }

  // 5) realpath 校验：防 `.meetingstone` 是 junction/symlink 指到项目外
  let realTarget
  try {
    realTarget = await realpathAllowMissing(targetPath)
  } catch (err) {
    throw fail(
      WORKTREE_ERRORS.GIT_FAILED,
      `无法解析工作树实际路径：${errorMessage(err)}`,
      { path: targetPath, branch, phase: 'resolve-realpath', cause: err },
    )
  }
  if (!isPathInside(realTarget, realProjectRoot)) {
    throw fail(WORKTREE_ERRORS.PATH_OUTSIDE, `工作树实际路径逃出项目根：${realTarget}`, {
      path: targetPath,
      branch,
      phase: 'validate-realpath',
    })
  }

  // 6) 分支不得存在
  if (await branchExists(repositoryRoot, branch, { ...options, phase: 'check-branch' })) {
    throw fail(WORKTREE_ERRORS.BRANCH_EXISTS, `分支已存在：${branch}`, {
      path: targetPath,
      branch,
      phase: 'check-branch',
    })
  }

  // 7) 串行建树；锁内重查，避免同进程两个请求都通过预检
  return withRepoLock(lockKey, async () => {
    if (await pathExists(targetPath)) {
      throw fail(WORKTREE_ERRORS.PATH_EXISTS, `工作树路径已存在：${targetPath}`, {
        path: targetPath,
        branch,
        phase: 'lock-recheck-path',
      })
    }
    if (await branchExists(repositoryRoot, branch, { ...options, phase: 'lock-check-branch' })) {
      throw fail(WORKTREE_ERRORS.BRANCH_EXISTS, `分支已存在：${branch}`, {
        path: targetPath,
        branch,
        phase: 'lock-check-branch',
      })
    }

    const add = await runGit(['worktree', 'add', '-b', branch, targetPath, baseSha], {
      ...options,
      cwd: resolvedProjectRoot,
      label: '创建工作树',
      phase: 'create-worktree',
    })
    if (add.code !== 0) {
      // 竞态兜底：另一进程可能刚好创建了路径/分支
      if (await branchExists(repositoryRoot, branch, options).catch(() => false)) {
        throw fail(WORKTREE_ERRORS.BRANCH_EXISTS, `分支已存在：${branch}`, {
          path: targetPath,
          branch,
          phase: 'create-worktree',
        })
      }
      if (await pathExists(targetPath)) {
        throw fail(WORKTREE_ERRORS.PATH_EXISTS, `工作树路径已存在：${targetPath}`, {
          path: targetPath,
          branch,
          phase: 'create-worktree',
        })
      }
      throw fail(
        WORKTREE_ERRORS.GIT_FAILED,
        `git worktree add 失败：${gitFailureDetail(add.stderr) || `退出码 ${add.code}`}`,
        { path: targetPath, branch, phase: 'create-worktree' },
      )
    }

    // 8) 建完再校验一次实际路径（目录创建后 realpath 才完整）
    let actualPath
    try {
      actualPath = await fs.realpath(targetPath)
    } catch (err) {
      throw fail(
        WORKTREE_ERRORS.GIT_FAILED,
        `工作树已创建但无法读取实际路径：${errorMessage(err)}`,
        { path: targetPath, branch, phase: 'verify-created-path', cause: err },
      )
    }
    if (!isPathInside(actualPath, realProjectRoot)) {
      throw fail(WORKTREE_ERRORS.PATH_OUTSIDE, `工作树实际路径逃出项目根：${actualPath}`, {
        path: targetPath,
        branch,
        phase: 'verify-created-path',
      })
    }

    return {
      path: actualPath,
      branch,
      baseSha,
      repositoryRoot,
      operationId,
    }
  })
}

/**
 * 解析 `git status --porcelain -z`：返回工作区里所有变化路径（暂存/未暂存/未跟踪/重命名）。
 * 重命名条目在 -z 下是 `XY <新路径>\0<旧路径>\0`，两个都收。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseStatusPorcelainZ(text) {
  /** @type {string[]} */
  const out = []
  const tokens = String(text ?? '').split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i]
    if (!entry) continue
    // 每个条目至少是 "XY PATH"（3 字符前缀）
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    const renamed = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C'
    if (renamed && i + 1 < tokens.length) {
      const other = tokens[i + 1]
      i += 1
      if (other) out.push(other)
    }
    if (path) out.push(path)
  }
  return out
}

/**
 * 解析 `git diff --name-status -z`：返回相对 base 的已提交/暂存/未暂存变化。
 * 重命名/复制条目是 `<状态>\0<旧路径>\0<新路径>\0`，两个都收。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseNameStatusZ(text) {
  /** @type {string[]} */
  const out = []
  const tokens = String(text ?? '').split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i]
    if (!status) continue
    if (!/^[A-Z][0-9]*$/.test(status)) continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1]
      const to = tokens[i + 2]
      i += 2
      if (from) out.push(from)
      if (to) out.push(to)
    } else {
      const path = tokens[i + 1]
      i += 1
      if (path) out.push(path)
    }
  }
  return out
}

/**
 * 计算工作树相对 baseSha 的改动文件列表。
 *
 * 来源两路并集：
 * - `git status --porcelain -z`：暂存 / 未暂存 / 未跟踪 / 重命名（旧+新）
 * - `git diff --name-status -z <baseSha>`：已提交的改动（以及暂存/未暂存）
 *
 * **失败必须返回 `{ unknown: true }`，调用方不得当成"无改动"**——否则重叠检测会漏报。
 *
 * @param {string} worktreePath
 * @param {string} baseSha
 * @param {object} [options]
 * @param {((request: GitRunRequest) => Promise<GitRunResult>) | undefined} [options.gitRunner]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes]
 * @returns {Promise<{ files?: string[], unknown?: false } | { unknown: true, reason: string }>}
 */
export async function computeChangedFiles(worktreePath, baseSha, options = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { unknown: true, reason: '缺少工作树路径' }
  }
  if (typeof baseSha !== 'string' || !baseSha.trim()) {
    return { unknown: true, reason: '缺少 baseSha' }
  }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) > 0
      ? /** @type {number} */ (options.timeoutMs)
      : DEFAULT_CHANGED_FILES_TIMEOUT_MS
  const maxOutputBytes =
    Number.isFinite(options.maxOutputBytes) && /** @type {number} */ (options.maxOutputBytes) > 0
      ? /** @type {number} */ (options.maxOutputBytes)
      : DEFAULT_CHANGED_FILES_MAX_OUTPUT_BYTES
  const gitRunner = typeof options.gitRunner === 'function' ? options.gitRunner : undefined

  try {
    const status = await runGit(
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      {
        cwd: worktreePath,
        timeoutMs,
        maxOutputBytes,
        gitRunner,
        label: '读取工作区状态',
      },
    )
    if (status.code !== 0) {
      return {
        unknown: true,
        reason: `git status 失败：${gitFailureDetail(status.stderr) || `退出码 ${status.code}`}`,
      }
    }

    const diff = await runGit(
      ['diff', '--name-status', '-z', '--find-renames', baseSha, '--'],
      {
        cwd: worktreePath,
        timeoutMs,
        maxOutputBytes,
        gitRunner,
        label: '读取相对基线的改动',
      },
    )
    if (diff.code !== 0) {
      return {
        unknown: true,
        reason: `git diff 失败：${gitFailureDetail(diff.stderr) || `退出码 ${diff.code}`}`,
      }
    }

    const files = new Set([
      ...parseStatusPorcelainZ(status.stdout),
      ...parseNameStatusZ(diff.stdout),
    ])
    return { files: [...files].sort(), unknown: false }
  } catch (err) {
    return { unknown: true, reason: errorMessage(err) }
  }
}

/**
 * 生产用管理器：给 dispatcher / index 注入同一个 git 执行配置。
 *
 * @param {object} [options]
 * @param {((request: GitRunRequest) => Promise<GitRunResult>) | undefined} [options.gitRunner]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes]
 * @param {number} [options.changedFilesTimeoutMs]
 * @param {number} [options.changedFilesMaxOutputBytes]
 */
export function createWorktreeManager(options = {}) {
  return {
    /** @param {{ projectRoot: string, operationId: string, base?: string }} input */
    create(input) {
      return createDispatchWorktree({ ...options, ...input })
    },
    /** @param {string} worktreePath @param {string} baseSha */
    computeChangedFiles(worktreePath, baseSha) {
      return computeChangedFiles(worktreePath, baseSha, {
        gitRunner: options.gitRunner,
        timeoutMs: options.changedFilesTimeoutMs,
        maxOutputBytes: options.changedFilesMaxOutputBytes,
      })
    },
  }
}

export default createDispatchWorktree
