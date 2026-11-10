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
        continue
      }
      if (!run || run.code !== 0) {
        notes.push(`${candidate.source} 候选退出码非 0（${run?.code ?? 'n/a'}），跳过`)
        continue
      }
      const version = parseVersion(cli, `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
      if (!version) {
        notes.push(`${candidate.source} 候选版本输出无法解析，跳过`)
        continue
      }
      const value = /** @type {ProbeResult} */ ({
        cli,
        installed: true,
        path: candidate.path,
        version,
        source: candidate.source,
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
