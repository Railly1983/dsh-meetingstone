// @ts-check
/**
 * 本机 CLI 探测（C2）—— 阶段 0 审计证明这是**唯一没有官方替代**的能力。
 *
 * 为什么需要它（docs/audit/00-summary.md §4 C2）：
 * - 官方明确「production performs no separate runtime version probe」「probes no version
 *   or authentication」，provider 也不回退本机 PATH 的 codex/claude（03-native-capabilities F2）
 * - Codex 是 Windows 商店应用，CLI 藏在 `Program Files\WindowsApps\OpenAI.Codex_<版本>\app\resources\codex.exe`，
 *   **PATH 与 where 都查不到**（04-cli-matrix §1），且路径随应用升级整体变化（26.1103.4239.0 → 26.1103.7773.0）
 *
 * 本模块的边界：
 * - 纯逻辑 + 可注入的 resolver / runner，便于单测
 * - **不做执行**：只回答「装没装、在哪、什么版本」，绝不启动任务
 * - 探测结果带 `source` 来源标签（PATH / appx / npm-global / known-dir / manual），
 *   拿不到就 `installed:false`，**不猜**
 */

/** 已知 CLI 的探测规格。新增 CLI 只改这里。 */
export const CLI_SPECS = Object.freeze({
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    /** Windows 商店包名（Appx resolver 用；`Get-AppxPackage -Name` 支持通配符） */
    appxName: 'OpenAI.Codex*',
    /** 拿到 InstallLocation 后校验包名，排除 CodexPrimaryRuntime 这类无 CLI 的同族包 */
    appxPattern: /^OpenAI\.Codex_/,
    /** 商店包内相对路径 */
    appxRelative: ['app', 'resources', 'codex.exe'],
    npmPackages: ['@openai/codex'],
    // 2026-11-13 真机实测：Codex 桌面应用会在用户目录下放一份自己的 CLI：
    //   C:\Users\<user>\.codex\.sandbox-bin\codex.exe   （360 MB，可直接跑 app-server）
    // 它既不在 PATH、也不在 Appx 安装目录，之前完全没覆盖 → resolveExecutable 返回 null
    // → capabilities 的 codex probe 永不执行 → UI 只显示静态表里的 2 个模型
    //（用户反馈「codex 怎么可能只有 2 个模型」）。
    // 注意：文件名带版本号的（codex-command-runner-0.153.4.exe）要排除，
    // 只认不带版本后缀的 `codex.exe`。
    knownDirs: [
      ['~', '.codex', '.sandbox-bin', 'codex.exe'],
      ['~', '.codex', 'bin', 'codex.exe'],
    ],
    versionArgs: ['--version'],
    /** 输出形如 "codex-cli 0.167.0-alpha.3.2" */
    versionPattern: /codex-cli\s+([0-9][^\s]*)/i,
  },
  codebuddy: {
    label: 'CodeBuddy CLI',
    bin: 'codebuddy',
    appxPattern: null,
    appxRelative: [],
    npmPackages: ['@tencent-ai/codebuddy-code'],
    versionArgs: ['--version'],
    /** 输出形如 "2.181.0" */
    versionPattern: /(\d+\.\d+\.\d+[\w.-]*)/,
  },
  claude: {
    label: 'Claude Code CLI',
    bin: 'claude',
    appxPattern: null,
    appxRelative: [],
    npmPackages: ['@anthropic-ai/claude-code'],
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+[\w.-]*)/,
  },
})

export const PROBE_SOURCES = Object.freeze({
  PATH: 'path',
  APPX: 'appx',
  NPM_GLOBAL: 'npm-global',
  KNOWN_DIR: 'known-dir',
  MANUAL: 'manual',
})

/**
 * 探测/预检的失败分类（P0-S2）。
 *
 * **只根据真实证据分类**：`--version` 的退出码、stderr、spawn 错误码。
 * 没有证据时给 `startup-failed` 或 `unknown`，不猜「未登录」之类的结论。
 */
export const PROBE_FAILURES = Object.freeze({
  NOT_INSTALLED: 'not-installed',
  LOGIN_REQUIRED: 'login-required',
  PERMISSION_DENIED: 'permission-denied',
  PATH_INVALID: 'path-invalid',
  STARTUP_FAILED: 'startup-failed',
  UNKNOWN_CLI: 'unknown-cli',
})

/** `--version` 输出里能证明「需要登录/授权」的线索。 */
const LOGIN_RE =
  /(login|log in|sign in|sign-in|authenticat|unauthorized|forbidden|not logged|invalid (?:api )?key|api key|token (?:expired|invalid)|401|403)/i
/** 权限不足（ACL / EACCES / EPERM）的线索。 */
const PERMISSION_RE = /(permission denied|access is denied|access denied|not permitted|eacces|eperm)/i
/** 路径异常（文件不存在/被移动）的线索。 */
const PATH_RE = /(enoent|no such file|not found|cannot find|does not exist)/i

/**
 * 按文本线索分类失败原因（顺序固定：权限 → 登录 → 路径 → 启动失败）。
 * @param {unknown} text
 * @returns {string}
 */
function classifyProbeText(text) {
  const value = String(text ?? '')
  if (PERMISSION_RE.test(value)) return PROBE_FAILURES.PERMISSION_DENIED
  if (LOGIN_RE.test(value)) return PROBE_FAILURES.LOGIN_REQUIRED
  if (PATH_RE.test(value)) return PROBE_FAILURES.PATH_INVALID
  return PROBE_FAILURES.STARTUP_FAILED
}

/**
 * 把一次 `--version` 的运行结果分类。
 * @param {{ code?: number, stdout?: string, stderr?: string } | null | undefined} run
 * @returns {string}
 */
export function classifyProbeFailure(run) {
  return classifyProbeText(`${run?.stdout ?? ''}\n${run?.stderr ?? ''}`)
}

/**
 * 把 runner 抛出的异常分类（ENOENT / EACCES 等优先于文本）。
 * @param {unknown} error
 * @returns {string}
 */
export function classifyProbeError(error) {
  const code = /** @type {any} */ (error)?.code
  if (code === 'EACCES' || code === 'EPERM') return PROBE_FAILURES.PERMISSION_DENIED
  if (code === 'ENOENT') return PROBE_FAILURES.PATH_INVALID
  return classifyProbeText(error instanceof Error ? error.message : String(error))
}

/** 探测结果默认缓存时长：5 分钟（商店应用升级后要能较快反映）。 */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * @typedef {object} ProbeCandidate
 * @property {string} path 可执行文件绝对路径
 * @property {string} source 来源标签
 */

/**
 * @typedef {object} ProbeResult
 * @property {string} cli
 * @property {boolean} installed
 * @property {string | null} path
 * @property {string | null} version
 * @property {string | null} source
 * @property {boolean} ready 探测级「可启动」：`--version` 成功且版本可解析。**不代表已登录**
 * @property {string | null} blockedReason 探测级失败分类（`PROBE_FAILURES`）；成功为 null
 * @property {string[]} notes 人类可读的探测备注（失败原因、多候选等）
 * @property {number} checkedAt
 */

/**
 * 把 `--version` 的输出解析出版本号。
 * @param {string} cli
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseVersion(cli, stdout) {
  const spec = /** @type {Record<string, any>} */ (CLI_SPECS)[cli]
  if (!spec) return null
  const text = String(stdout ?? '')
  const m = spec.versionPattern.exec(text)
  return m ? m[1] : null
}

/**
 * 创建探测器。
 *
 * @param {{
 *   resolvers?: Array<(spec: any) => Promise<ProbeCandidate[]> | ProbeCandidate[]>,
 *   runner?: (path: string, args: string[]) => Promise<{ code: number, stdout?: string, stderr?: string }>,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} [deps]
 */
export function createProbe(deps = {}) {
  const resolvers = deps.resolvers ?? []
  const runner = deps.runner ?? (async () => ({ code: 127, stdout: '', stderr: 'no runner' }))
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS

  /** @type {Map<string, { at: number, value: ProbeResult }>} */
  const cache = new Map()

  /**
   * 探测单个 CLI。
   * @param {string} cli
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<ProbeResult>}
   */
  async function probe(cli, opts = {}) {
    const spec = /** @type {Record<string, any>} */ (CLI_SPECS)[cli]
    if (!spec) {
      return {
        cli,
        installed: false,
        path: null,
        version: null,
        source: null,
        ready: false,
        blockedReason: PROBE_FAILURES.UNKNOWN_CLI,
        notes: [`未知的 CLI：${cli}`],
        checkedAt: now(),
      }
    }

    const cached = cache.get(cli)
    if (!opts.force && cached && now() - cached.at < ttlMs) {
      return cached.value
    }

    /** @type {string[]} */
    const notes = []
    /** @type {ProbeCandidate[]} */
    const candidates = []
    /** 首个可归因的失败分类；多个候选时保留最先出现的原因。 @type {string | null} */
    let failureReason = null

    // 1. 多源枚举候选（resolver 顺序即优先级）
    for (const resolve of resolvers) {
      try {
        const found = await resolve(spec)
        for (const c of found ?? []) {
          if (c && typeof c.path === 'string' && c.path) candidates.push(c)
        }
      } catch (err) {
        notes.push(`解析器失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 去重（同一路径保留优先级最高的来源）
    /** @type {ProbeCandidate[]} */
    const unique = []
    const seen = new Set()
    for (const c of candidates) {
      const key = c.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(c)
    }
    if (unique.length > 1) {
      notes.push(`发现 ${unique.length} 个候选，取第一个：${unique.map((c) => c.source).join(' > ')}`)
    }

    // 2. 逐个试跑 `--version`，第一个能跑通的即为结果
    for (const candidate of unique) {
      let run
      try {
        run = await runner(candidate.path, spec.versionArgs)
      } catch (err) {
        notes.push(`${candidate.source} 候选执行失败：${err instanceof Error ? err.message : String(err)}`)
        failureReason ??= classifyProbeError(err)
        continue
      }
      if (!run || run.code !== 0) {
        notes.push(`${candidate.source} 候选退出码非 0（${run?.code ?? 'n/a'}），跳过`)
        failureReason ??= classifyProbeFailure(run)
        continue
      }
      const version = parseVersion(cli, `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
      if (!version) {
        notes.push(`${candidate.source} 候选版本输出无法解析，跳过`)
        failureReason ??= PROBE_FAILURES.STARTUP_FAILED
        continue
      }
      const value = /** @type {ProbeResult} */ ({
        cli,
        installed: true,
        path: candidate.path,
        version,
        source: candidate.source,
        ready: true,
        blockedReason: null,
        notes,
        checkedAt: now(),
      })
      cache.set(cli, { at: now(), value })
      return value
    }

    if (unique.length === 0) notes.push('所有解析源都没有找到该 CLI')

    const value = /** @type {ProbeResult} */ ({
      cli,
      installed: false,
      path: null,
      version: null,
      source: null,
      ready: false,
      // 没有候选 = 未安装；有候选但都失败 = 保留首个可归因原因（权限/登录/路径/启动）。
      blockedReason: failureReason ?? (unique.length === 0 ? PROBE_FAILURES.NOT_INSTALLED : PROBE_FAILURES.STARTUP_FAILED),
      notes,
      checkedAt: now(),
    })
    // 未安装也缓存：避免每次派单都扫盘；TTL 到期或 force 时重试
    cache.set(cli, { at: now(), value })
    return value
  }

  /** 探测全部已知 CLI。 */
  async function probeAll(opts = {}) {
    const names = Object.keys(CLI_SPECS)
    /** @type {ProbeResult[]} */
    const out = []
    for (const name of names) out.push(await probe(name, opts))
    return out
  }

  /** 清缓存（可选按 CLI），用于"刷新状态"操作。 */
  function invalidate(cli) {
    if (cli) cache.delete(cli)
    else cache.clear()
  }

  return { probe, probeAll, invalidate }
}
