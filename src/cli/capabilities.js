// @ts-check
/**
 * CLI 能力目录（B2b）：4 CLI × 模型（含 provider 映射）× 思考强度。
 *
 * 这是 GUI 角色编辑器**唯一的能力事实源**（不再从插件 channel 实例推断）。
 *
 * 来源优先级（不得伪造）：
 *   1. `discovered` —— 动态发现（codex app-server `model/list`；DSH host `ctx.llm.listModels`）
 *   2. `static`     —— CLI 自身文档/帮助里的静态已知表（claude `--model` 别名与 `--effort` 档位等）
 *   3. `unknown`    —— 发现失败且没有静态表：空列表 + `source:"unknown"`，绝不补造
 *
 * 固定 4 个 CLI（Lead 定版）：`dsh` / `claude` / `codex` / `codebuddy`。
 * 条目形状固定：`{ id, label, models:[{id,label,provider,source}], strengths:[{id,label,source}] }`，
 * 另附 `sources`（models/strengths 各自的来源）与 `refreshedAt`（可观测）。
 *
 * 边界：纯数据 + 受控探测；不写配置、不启动 CLI 执行任务（只查询能力）。
 * @module src/cli/capabilities
 */
import { spawn as nodeSpawn } from 'node:child_process'

/** 固定 4 个 CLI（顺序稳定，GUI 按此渲染）。 */
export const CLI_IDS = Object.freeze(['dsh', 'claude', 'codex', 'codebuddy'])

/** 用户可见名称（DeepSeek Harness / Claude Code / Codex / CodeBuddy）。 */
export const CLI_LABELS = Object.freeze({
  dsh: 'DeepSeek Harness',
  claude: 'Claude Code',
  codex: 'Codex',
  codebuddy: 'CodeBuddy',
})

/** 能力来源枚举。 */
export const CAPABILITY_SOURCES = Object.freeze({
  DISCOVERED: 'discovered',
  STATIC: 'static',
  UNKNOWN: 'unknown',
})

/** CLI 级 provider 兜底（模型级映射优先，见 PROVIDER_BY_MODEL）。 */
export const PROVIDER_BY_CLI = Object.freeze({
  dsh: 'spawn',
  claude: 'claude-code',
  codex: 'codex',
  codebuddy: 'acp',
})

/** 模型 → provider 映射（Lead 定版；未知模型回退 PROVIDER_BY_CLI）。 */
export const PROVIDER_BY_MODEL = Object.freeze({
  codex: Object.freeze({
    'gpt-6-astra': 'codex',
    'gpt-6.1-sol': 'codex-sol',
  }),
  codebuddy: Object.freeze({
    'deepseek-v4.1-flash': 'acp',
    hy3: 'acp-hy4',
  }),
})

/** 思考强度的展示名（id 为 CLI 实际接受的写法）。 */
const STRENGTH_LABELS = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
})

/**
 * 静态已知表（来源 `static`；**只写有证据的条目**）。
 *
 * - claude：`claude --help` 实测（2026-11-12，v2.1.322）：
 *   `--model` 别名 `fable` / `opus` / `sonnet`（或完整模型名）；`--effort` 档位 `low, medium, high, xhigh, max`。
 * - codex：模型来自 Lead 的 provider 映射（gpt-6-astra / gpt-6.1-sol）；
 *   强度**不设静态值**（以动态 `model/list` 的 `supportedReasoningEfforts` 为准，失败则 unknown）。
 * - codebuddy：模型来自 Lead 的 provider 映射（deepseek-v4.1-flash / hy3）；
 *   本机 CLI 无可枚举模型的接口（`codebuddy --help` 崩溃、settings.json 无模型表）→ 强度 unknown。
 * - dsh：模型/强度由宿主 `ctx.llm.listModels()` 动态发现；无静态表（拿不到 → unknown）。
 */
export const STATIC_CATALOG = Object.freeze({
  dsh: Object.freeze({ models: Object.freeze([]), strengths: Object.freeze([]) }),
  claude: Object.freeze({
    models: Object.freeze([
      Object.freeze({ id: 'sonnet', label: 'Sonnet' }),
      Object.freeze({ id: 'opus', label: 'Opus' }),
      Object.freeze({ id: 'fable', label: 'Fable' }),
    ]),
    strengths: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  }),
  codex: Object.freeze({
    models: Object.freeze([
      Object.freeze({ id: 'gpt-6-astra', label: 'GPT-6-Astra' }),
      Object.freeze({ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }),
    ]),
    strengths: Object.freeze([]),
  }),
  codebuddy: Object.freeze({
    models: Object.freeze([
      Object.freeze({ id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' }),
      Object.freeze({ id: 'hy3', label: 'HY3' }),
    ]),
    strengths: Object.freeze([]),
  }),
})

/** 能力目录默认刷新间隔（毫秒）。 */
export const DEFAULT_CAPABILITY_TTL_MS = 5 * 60 * 1000

/** @param {unknown} value */
function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 模型 → provider。
 * @param {string} cli
 * @param {string} modelId
 * @returns {string | null}
 */
export function providerForModel(cli, modelId) {
  const modelMap = /** @type {Record<string, Record<string, string>>} */ (PROVIDER_BY_MODEL)[cli]
  if (modelMap && typeof modelMap[modelId] === 'string') return modelMap[modelId]
  return /** @type {Record<string, string>} */ (PROVIDER_BY_CLI)[cli] ?? null
}

/**
 * 强度 id → 展示名（未知 id 原样返回）。
 * @param {string} id
 */
export function strengthLabel(id) {
  return /** @type {Record<string, string>} */ (STRENGTH_LABELS)[id] ?? id
}

/**
 * @typedef {object} CatalogProbeResult
 * @property {true} ok
 * @property {Array<{ id: string, label?: string, strengths?: string[] }>} models
 * @property {{ detail?: string }} [meta]
 */

/**
 * 从宿主 `ctx.llm.listModels()` 的返回里保守提取模型与强度。
 * 只认明确字段；结构不符的项丢弃（不猜）。
 * @param {unknown} value
 * @returns {{ models: Array<{ id: string, label?: string, strengths: string[] }>, notes: string[] }}
 */
export function extractHostModels(value) {
  const notes = []
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).models)
      ? /** @type {any} */ (value).models
      : []
  /** @type {Array<{ id: string, label?: string, strengths: string[] }>} */
  const models = []
  for (const item of source) {
    if (!item || typeof item !== 'object') {
      notes.push('忽略非法模型条目（非对象）')
      continue
    }
    const raw = /** @type {Record<string, any>} */ (item)
    const id = asString(raw.id) || asString(raw.model) || asString(raw.modelId)
    if (!id) {
      notes.push('忽略缺少 id/model 的模型条目')
      continue
    }
    const label = asString(raw.displayName) || asString(raw.label) || id
    /** @type {string[]} */
    const strengths = []
    const efforts = Array.isArray(raw.reasoning?.efforts)
      ? raw.reasoning.efforts
      : Array.isArray(raw.supportedReasoningEfforts)
        ? raw.supportedReasoningEfforts
        : []
    for (const effort of efforts) {
      const effortId =
        typeof effort === 'string'
          ? effort
          : effort && typeof effort === 'object'
            ? asString(/** @type {any} */ (effort).id) ||
              asString(/** @type {any} */ (effort).reasoningEffort) ||
              ''
            : ''
      if (effortId && !strengths.includes(effortId)) strengths.push(effortId)
    }
    models.push({ id, label, strengths })
  }
  return { models, notes }
}

/**
 * 解析 codex `app-server model/list` 的响应（JSON-RPC `result.data[]`）。
 * @param {any} result
 */
export function parseCodexModelList(result) {
  const data = Array.isArray(result?.data) ? result.data : []
  /** @type {Array<{ id: string, label?: string, strengths: string[] }>} */
  const models = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const id = asString(item.model) || asString(item.id)
    if (!id) continue
    const strengths = []
    for (const effort of Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : []) {
      const effortId = typeof effort === 'string' ? effort : asString(effort?.reasoningEffort)
      if (effortId && !strengths.includes(effortId)) strengths.push(effortId)
    }
    models.push({ id, label: asString(item.displayName) || id, strengths })
  }
  return models
}

/**
 * 低层 JSON-RPC 探测：启动 codex app-server，initialize → initialized → model/list。
 *
 * 实测（2026-11-12，codex-cli 0.167.0-alpha.4.1）：initialize 与 model/list 均可用，
 * 返回 `data[]`（含 `supportedReasoningEfforts`）。**必须**在 initialize 响应后发送
 * `initialized` 通知，否则 model/list 不会返回。
 *
 * @param {object} opts
 * @param {string} opts.executable codex 可执行文件绝对路径
 * @param {number} [opts.timeoutMs] 整体超时（默认 15s）
 * @param {any} [opts.spawnImpl] 测试注入（默认 node:child_process.spawn）
 * @returns {Promise<Array<{ id: string, label?: string, strengths: string[] }>>}
 */
export async function probeCodexModels({ executable, timeoutMs = 15_000, spawnImpl = nodeSpawn } = /** @type {any} */ ({})) {
  if (!executable || typeof executable !== 'string') throw new Error('CODEX_EXECUTABLE_MISSING: 缺少 codex 可执行文件路径')
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(new Error(`CODEX_SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    let buffer = ''
    let settled = false
    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        /* 忽略 kill 失败 */
      }
      reject(error)
    }
    /** @param {any} value */
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        /* 忽略 kill 失败 */
      }
      resolve(value)
    }
    const timer = setTimeout(() => fail(new Error('CODEX_MODEL_LIST_TIMEOUT')), timeoutMs)
    /** @param {any} message */
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch (err) {
        fail(new Error(`CODEX_STDIN_FAILED: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    let initialized = false
    const onLine = (/** @type {string} */ line) => {
      const text = line.trim()
      if (!text) return
      /** @type {any} */
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message.id === 1 && message.result) {
        if (initialized) return
        initialized = true
        send({ jsonrpc: '2.0', method: 'initialized', params: {} })
        send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })
        return
      }
      if (message.id === 2) {
        if (message.error) {
          fail(new Error(`CODEX_MODEL_LIST_ERROR: ${JSON.stringify(message.error).slice(0, 300)}`))
          return
        }
        done(parseCodexModelList(message.result))
      }
    }
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        onLine(line)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', () => {
      /* stderr 只作为诊断，不当作响应 */
    })
    child.on('error', (/** @type {any} */ err) => fail(new Error(`CODEX_SPAWN_ERROR: ${err?.message ?? String(err)}`)))
    child.on('exit', (/** @type {number | null} */ code) => {
      if (!settled) fail(new Error(`CODEX_EXITED_EARLY: code=${code}`))
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'dsh-meetingstone-capabilities', version: '1.0.0' }, capabilities: {} },
    })
  })
}

/**
 * 构造一个 CLI 目录条目（按来源优先级合并）。
 * @param {string} cli
 * @param {{ discovered?: Array<{ id: string, label?: string, strengths?: string[] }> | null, errors?: string[], refreshedAt?: number | null }} [state]
 */
export function buildCatalogEntry(cli, state = {}) {
  const staticSpec = /** @type {Record<string, any>} */ (STATIC_CATALOG)[cli] ?? { models: [], strengths: [] }
  const discovered = Array.isArray(state.discovered) ? state.discovered : null
  const errors = Array.isArray(state.errors) ? [...state.errors] : []
  /** @type {Array<{ id: string, label: string, provider: string | null, source: string }>} */
  let models
  /** @type {string} */
  let modelsSource
  if (discovered) {
    models = discovered.map((item) => ({
      id: item.id,
      label: item.label || item.id,
      provider: providerForModel(cli, item.id),
      source: CAPABILITY_SOURCES.DISCOVERED,
    }))
    modelsSource = CAPABILITY_SOURCES.DISCOVERED
  } else if (staticSpec.models.length > 0) {
    models = staticSpec.models.map((/** @type {any} */ item) => ({
      id: item.id,
      label: item.label || item.id,
      provider: providerForModel(cli, item.id),
      source: CAPABILITY_SOURCES.STATIC,
    }))
    modelsSource = CAPABILITY_SOURCES.STATIC
  } else {
    models = []
    modelsSource = CAPABILITY_SOURCES.UNKNOWN
  }
  /** @type {Array<{ id: string, label: string, source: string }>} */
  let strengths
  /** @type {string} */
  let strengthsSource
  if (discovered) {
    /** @type {Set<string>} */
    const set = new Set()
    for (const item of discovered) for (const effort of item.strengths ?? []) if (effort) set.add(effort)
    strengths = [...set].map((id) => ({ id, label: strengthLabel(id), source: CAPABILITY_SOURCES.DISCOVERED }))
    // 动态发现成功但没有声明任何强度 → 明确 unknown（不是静态补造）
    strengthsSource = strengths.length > 0 ? CAPABILITY_SOURCES.DISCOVERED : CAPABILITY_SOURCES.UNKNOWN
  } else if (staticSpec.strengths.length > 0) {
    strengths = staticSpec.strengths.map((/** @type {string} */ id) => ({
      id,
      label: strengthLabel(id),
      source: CAPABILITY_SOURCES.STATIC,
    }))
    strengthsSource = CAPABILITY_SOURCES.STATIC
  } else {
    strengths = []
    strengthsSource = CAPABILITY_SOURCES.UNKNOWN
  }
  return {
    id: cli,
    label: /** @type {Record<string, string>} */ (CLI_LABELS)[cli],
    provider: /** @type {Record<string, string>} */ (PROVIDER_BY_CLI)[cli] ?? null,
    models,
    strengths,
    sources: { models: modelsSource, strengths: strengthsSource },
    refreshedAt: Number.isFinite(state.refreshedAt) ? state.refreshedAt : null,
    errors,
  }
}

/**
 * @typedef {object} CapabilityCatalog
 * @property {() => { capabilities: any[], refreshedAt: number | null, errors: string[] }} snapshot
 * @property {(cli?: string | null, opts?: { force?: boolean }) => Promise<{ ok: boolean, refreshed: string[], refreshedAt: number | null, errors: string[] }>} refresh
 * @property {() => any[]} list
 */

/**
 * 创建能力目录（可注入探测，默认静态表）。
 *
 * - `probes.codex({ resolveExecutable, spawnImpl, timeoutMs })`：动态发现 codex 模型
 * - `probes.dsh({ listHostModels })`：动态发现 DSH host 模型
 * - `resolveExecutable(cli)`：把 CLI 解析成可执行文件路径（host 用已有 probe）
 * - `ttlMs`：snapshot 发现过期时后台刷新（不阻塞 list）
 *
 * @param {{
 *   probes?: { codex?: Function, dsh?: Function },
 *   resolveExecutable?: (cli: string) => Promise<string | null>,
 *   now?: () => number,
 *   ttlMs?: number,
 *   autoRefresh?: boolean,
 * }} [options]
 * @returns {CapabilityCatalog}
 */
export function createCliCapabilityCatalog(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : DEFAULT_CAPABILITY_TTL_MS
  const probes = options.probes ?? {}
  const resolveExecutable = options.resolveExecutable ?? (async () => null)
  const autoRefresh = options.autoRefresh !== false
  /** @type {Map<string, { discovered: any[] | null, errors: string[], refreshedAt: number | null }>} */
  const state = new Map()
  for (const cli of CLI_IDS) state.set(cli, { discovered: null, errors: [], refreshedAt: null })
  let lastRefreshAt = null
  /** @type {Promise<any> | null} */
  let inFlight = null

  /** @returns {any[]} */
  function list() {
    return CLI_IDS.map((cli) => buildCatalogEntry(cli, state.get(cli)))
  }

  function snapshot() {
    if (autoRefresh && (lastRefreshAt === null || now() - lastRefreshAt >= ttlMs) && !inFlight) {
      // 后台刷新：list 只读、不阻塞；刷新完成后下次 list 可见（可观测 refreshedAt）
      void refresh(undefined, { force: false }).catch(() => {})
    }
    return {
      capabilities: list(),
      refreshedAt: lastRefreshAt,
      errors: [...new Set(CLI_IDS.flatMap((cli) => state.get(cli)?.errors ?? []))],
    }
  }

  /**
   * 刷新能力（cli 为空 = 全部）。
   * @param {string | null} [cli]
   * @param {{ force?: boolean }} [opts]
   */
  async function refresh(cli = null, opts = {}) {
    const force = opts.force !== false
    if (inFlight && !force) return inFlight
    const targets = CLI_IDS.filter((id) => !cli || id === cli)
    const run = (async () => {
      const refreshed = []
      /** @type {string[]} */
      const errors = []
      for (const target of targets) {
        const current = state.get(target)
        if (!current) continue
        try {
          /** @type {Array<{ id: string, label?: string, strengths?: string[] }> | null} */
          let discovered = null
          if (target === 'codex' && typeof probes.codex === 'function') {
            const executable = await resolveExecutable('codex')
            // 探测实现自己决定是否需要 executable（默认实现需要；注入替身可忽略）。
            // 传 null 时默认实现会抛错 → 走静态表 + 可观测错误。
            const found = await probes.codex({ executable, timeoutMs: 15_000 })
            if (Array.isArray(found)) discovered = found
            else if (found && Array.isArray(found.models)) discovered = found.models
          } else if (target === 'dsh' && typeof probes.dsh === 'function') {
            const found = await probes.dsh({})
            if (Array.isArray(found)) discovered = found
            else if (found && Array.isArray(found.models)) discovered = found.models
          }
          if (discovered !== null) {
            state.set(target, { discovered, errors: [], refreshedAt: now() })
            refreshed.push(target)
          } else {
            // 无可动态来源（claude/codebuddy）：仅记录刷新时间，保留静态表
            state.set(target, { discovered: null, errors: current.errors, refreshedAt: now() })
            refreshed.push(target)
          }
        } catch (err) {
          const message = `${target}: ${err instanceof Error ? err.message : String(err)}`
          errors.push(message)
          // 动态失败 → 保留静态表（不伪造 discovered），错误可观测
          state.set(target, { discovered: null, errors: [message], refreshedAt: now() })
        }
      }
      lastRefreshAt = now()
      return { ok: errors.length === 0, refreshed, refreshedAt: lastRefreshAt, errors }
    })()
    inFlight = run
    try {
      return await run
    } finally {
      inFlight = null
    }
  }

  return { snapshot, refresh, list }
}

/**
 * 默认探测（host 侧可直接使用）：
 * - codex：`resolveExecutable('codex')` + app-server model/list
 * - dsh：宿主 `ctx.llm.listModels()`（拿不到 → 抛错，保留 unknown/静态）
 *
 * @param {{ resolveExecutable?: (cli: string) => Promise<string | null>, ctx?: any, spawnImpl?: any }} [deps]
 */
export function createDefaultProbes(deps = {}) {
  const resolveExecutable = deps.resolveExecutable ?? (async () => null)
  return {
    codex: async ({ executable }) => {
      const exe = executable || (await resolveExecutable('codex'))
      if (!exe) throw new Error('codex 可执行文件不可用')
      return probeCodexModels({ executable: exe, spawnImpl: deps.spawnImpl })
    },
    dsh: async () => {
      const ctx = deps.ctx
      if (!ctx) throw new Error('宿主 ctx 不可用')
      let llm = null
      try {
        llm = ctx.llm ?? (typeof ctx.get === 'function' ? ctx.get('llm') : null)
      } catch {
        llm = null
      }
      if (!llm || typeof llm.listModels !== 'function') {
        throw new Error('宿主 llm.listModels 不可用')
      }
      const value = await llm.listModels()
      const { models } = extractHostModels(value)
      return models
    },
  }
}
