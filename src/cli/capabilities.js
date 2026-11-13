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
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fillContextWindows } from './model-context-library.js'

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
  // 本机 profile 里 provider 行的真实声明（模型/强度/provider 映射的唯一本机事实）
  CONFIG: 'config',
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
 * 反查：在能力目录条目的 models 里按模型 id 找 provider（编辑器保存映射用）。
 * @param {Array<{ id: string, provider?: string | null }>} models
 * @param {string} modelId
 * @returns {string | null}
 */
export function providerForCatalogModel(models, modelId) {
  const list = Array.isArray(models) ? models : []
  const found = list.find((item) => item && item.id === modelId)
  return found && typeof found.provider === 'string' && found.provider ? found.provider : null
}

/**
 * 强度 id → 展示名（未知 id 原样返回）。
 * @param {string} id
 */
export function strengthLabel(id) {
  return /** @type {Record<string, string>} */ (STRENGTH_LABELS)[id] ?? id
}

// ─── config 源（本机 profile provider 行的真实声明）────────────────────────────
//
// 为什么读 profile patch 文件而不是 `ctx`：
// - 宿主 `configEditor` 只暴露 `edit()`（写当前 profile patch），没有“读任意 plugin 行 config”的公开 API；
// - `pluginInventory/list` 是只读投影，但只给 id/specifier/enabled/fiber phase，**不含 config 值**；
// - 因此插件侧拿不到“其它插件行的 config”。替代方案 = 只读解析 profile patch 文件
//   （`$DSH_PROFILE_DIR/cordis.patch.yml`，即 configEditor 的写目标），失败则静默回退。
// 这是只读操作：不写文件、不改 profile。

/** `@deepseek-ai/dsh-subagent-*` specifier → 能力目录 CLI id。 */
export const SPECIFIER_TO_CLI = Object.freeze({
  '@deepseek-ai/dsh-subagent-acp': 'codebuddy',
  '@deepseek-ai/dsh-subagent-codex': 'codex',
  '@deepseek-ai/dsh-subagent-claude-code': 'claude',
})

/**
 * 解析 profile `cordis.patch.yml` 里的 provider 行（YAML 子集，逐行扫描）。
 *
 * 只认我们需要的字段：`id` / `name`(specifier) / `providerName` / `model` / `effort` /
 * `disabled` / `args`（数组里的 `--model`、`--effort`）。
 * 结构不符/缺字段的行跳过（不猜），行本身原样保留在返回值里供审计。
 *
 * @param {string} text
 * @returns {Array<{
 *   id: string, specifier: string | null, providerName: string | null,
 *   model: string | null, effort: string | null, args: string[], disabled: boolean,
 *   llmProvider: string | null, llmModel: string | null,
 * }>}
 */
export function parseProviderPatchRows(text) {
  const rows = []
  /** @type {any} */
  let current = null
  let inArgs = false
  /** @param {string} value */
  const clean = (value) => value.trim().replace(/^["']|["']$/g, '')
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const entryMatch = line.match(/^\s*-\s+id:\s*(.+?)\s*$/)
    if (entryMatch) {
      current = {
        id: clean(entryMatch[1]),
        specifier: null,
        providerName: null,
        model: null,
        effort: null,
        args: [],
        disabled: false,
        // in-process 通道用 `llmProvider`/`llmModel` 声明宿主 LLM 路由，不是 args。
        llmProvider: null,
        llmModel: null,
      }
      rows.push(current)
      inArgs = false
      continue
    }
    if (!current) continue
    if (/^\s*-\s+insert:\s*$/.test(line)) {
      current = null
      inArgs = false
      continue
    }
    const nameMatch = line.match(/^\s*name:\s*(.+?)\s*$/)
    if (nameMatch) {
      current.specifier = clean(nameMatch[1])
      inArgs = false
      continue
    }
    const providerMatch = line.match(/^\s*providerName:\s*(.+?)\s*$/)
    if (providerMatch) {
      current.providerName = clean(providerMatch[1])
      inArgs = false
      continue
    }
    // in-process 通道：宿主 LLM 路由写在 `llmProvider`/`llmModel`，不是 args/`model`。
    // 这两个 pattern 必须放在 `model:` 之前，否则 `llmModel:` 不会被识别
    // （`^\s*model:` 锚定行首，本不会误匹配，但保持顺序更明确）。
    const llmProviderMatch = line.match(/^\s*llmProvider:\s*(.+?)\s*$/)
    if (llmProviderMatch) {
      current.llmProvider = clean(llmProviderMatch[1])
      inArgs = false
      continue
    }
    const llmModelMatch = line.match(/^\s*llmModel:\s*(.+?)\s*$/)
    if (llmModelMatch) {
      current.llmModel = clean(llmModelMatch[1])
      inArgs = false
      continue
    }
    const modelMatch = line.match(/^\s*model:\s*(.+?)\s*$/)
    if (modelMatch) {
      current.model = clean(modelMatch[1])
      inArgs = false
      continue
    }
    const effortMatch = line.match(/^\s*effort:\s*(.+?)\s*$/)
    if (effortMatch) {
      current.effort = clean(effortMatch[1])
      inArgs = false
      continue
    }
    if (/^\s*disabled:\s*true\s*$/.test(line)) {
      current.disabled = true
      inArgs = false
      continue
    }
    if (/^\s*args:\s*$/.test(line)) {
      inArgs = true
      continue
    }
    if (inArgs) {
      const argMatch = line.match(/^\s*-\s+(.+?)\s*$/)
      if (argMatch) {
        const token = clean(argMatch[1])
        if (token) current.args.push(token)
        continue
      }
      inArgs = false
    }
  }
  return rows
}

/**
 * 从一行 provider 声明里拆出模型/强度/provider（args 优先，config 字段兜底）。
 * @param {any} row
 * @returns {{ cli: string | null, model: string | null, effort: string | null, provider: string | null, strengths: string[] }}
 */
export function providerRowToCapability(row) {
  const cli = row && typeof row.specifier === 'string'
    ? /** @type {Record<string, string>} */ (SPECIFIER_TO_CLI)[row.specifier] ?? null
    : null
  if (!cli || (row && row.disabled === true)) {
    return { cli: null, model: null, effort: null, provider: null, strengths: [] }
  }
  const args = Array.isArray(row.args) ? row.args : []
  let model = typeof row.model === 'string' && row.model ? row.model : null
  let effort = typeof row.effort === 'string' && row.effort ? row.effort : null
  // 注：in-process 通道的 `llmModel` **不在这里**回退——本函数只服务 provider 行，
  // 而 provider 行必然有 `specifier`（无映射时上面已提前返回）。in-process 通道不是
  // provider 行，它由 `channelsToCatalog()` 从 `cfg.channels` 直接读取（与派单侧同源）。
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? '')
    const eq = token.match(/^--(model|effort)=(.*)$/)
    if (eq) {
      if (eq[1] === 'model' && eq[2]) model = eq[2]
      if (eq[1] === 'effort' && eq[2]) effort = eq[2]
      continue
    }
    if ((token === '--model' || token === '--effort') && i + 1 < args.length) {
      const value = String(args[i + 1] ?? '')
      if (token === '--model' && value && !value.startsWith('-')) model = value
      if (token === '--effort' && value && !value.startsWith('-')) effort = value
      i += 1
    }
  }
  const provider = typeof row.providerName === 'string' && row.providerName ? row.providerName : null
  /** @type {string[]} */
  const strengths = effort ? [effort] : []
  return { cli, model, effort, provider, strengths }
}

/**
 * 内部 `channel.kind` → 能力目录 CLI id。
 * 必须与 `src/client/index.js` 的 `CLI_BY_CHANNEL_KIND` 保持一致。
 */
export const CHANNEL_KIND_TO_CLI = Object.freeze({
  'in-process': 'dsh',
  'claude-code': 'claude',
  codex: 'codex',
  'acp-cli': 'codebuddy',
})

/**
 * 插件配置里的通道实例表（`cfg.channels`）→ 能力目录的 config 源。
 *
 * 为什么需要这条来源：in-process 通道的模型声明在 `llmModel`（不是 provider 行的
 * `model`/args），而 `cfg.channels` 正是派单侧 `src/dsh/adapter.js:buildChildAgentOptions`
 * 读取的**同一份数据**。能力目录从同一处取值，才能保证「下拉框里能选的模型」与
 * 「派单实际会用的模型」不分叉（D1 验收缺陷 1 成因 B）。
 *
 * @param {any[]} channels
 * @returns {Record<string, { models: Array<{ id: string, label: string, provider: string | null, strengths: string[] }>, strengths: string[], rows: string[] }>}
 */
export function channelsToCatalog(channels = []) {
  /** @type {Record<string, { models: Array<any>, strengths: Set<string>, rows: string[] }>} */
  const byCli = {}
  for (const channel of Array.isArray(channels) ? channels : []) {
    if (!channel || typeof channel !== 'object') continue
    const cli = /** @type {Record<string, string>} */ (CHANNEL_KIND_TO_CLI)[String(channel.kind ?? '')] ?? null
    if (!cli) continue
    // in-process 用 llmModel/llmProvider；外部通道用 model/provider。
    const model = asString(channel.llmModel) || asString(channel.model)
    const provider = asString(channel.llmProvider) || asString(channel.provider) || null
    const effort = asString(channel.reasoning)
    const bucket = byCli[cli] ?? { models: [], strengths: new Set(), rows: [] }
    byCli[cli] = bucket
    // 2026-11-12 修复：外部 CLI 通道（acp-cli / codex / claude-code）在 profile 里
    // 通常没有 `model` 字段 —— 它们的模型由角色行（role.model）或 provider 行的
    // --model 承载。早期这里 `if (!model) continue` 会让这些 CLI 从目录里**整个消失**，
    // 表现就是用户反馈的「模型列表刷新不正常 / 只有 dsh 一个 CLI」。
    // 现在：没有 model 也登记通道（models 为空但有 rows），CLI 至少能出现在下拉里；
    // 角色实际绑定的模型由 mergeRoleBoundModels() 从角色侧补进来。
    if (!model) {
      if (effort) bucket.strengths.add(effort)
      const channelId = asString(channel.channelId)
      if (channelId && !bucket.rows.includes(channelId)) bucket.rows.push(channelId)
      continue
    }
    const existing = bucket.models.find((item) => item.id === model)
    if (existing) {
      if (!existing.provider && provider) existing.provider = provider
      if (effort && !existing.strengths.includes(effort)) existing.strengths.push(effort)
    } else {
      bucket.models.push({ id: model, label: model, provider, strengths: effort ? [effort] : [] })
    }
    if (effort) bucket.strengths.add(effort)
    const rowId = asString(channel.channelId)
    if (rowId && !bucket.rows.includes(rowId)) bucket.rows.push(rowId)
  }
  /** @type {Record<string, any>} */
  const out = {}
  for (const [cli, bucket] of Object.entries(byCli)) {
    out[cli] = { models: bucket.models, strengths: [...bucket.strengths], rows: bucket.rows }
  }
  return out
}

/**
 * 把角色**实际绑定的模型**补进能力目录。
 *
 * ── 为什么需要（「模型列表刷新不正常」的正解之二）──────────────────────
 * profile 里模型的真实来源有两处：
 * 1. 通道行：in-process 的 `llmModel`、外部 CLI 的 provider 行 `--model`
 * 2. **角色行**：`role.model` / `role.reasoning`（角色派单时实际用的就是它）
 *
 * 早期只读了第 1 处。但用户给「唐僧」绑的是 `ch-acp-kimi` + `role.model = kimi-k3.1-pro`，
 * 而 `ch-acp-kimi` 通道行本身没有 model —— 于是编辑器里这个模型**根本看不到**，
 * 用户会以为「刷新不出模型」。
 *
 * 本函数从角色侧反补：凡是角色声明过的 model / reasoning 都并进对应 CLI 的目录，
 * 并标 `sources: ['role', ...]` 让 UI 能区分「来自角色绑定」而不是伪装成探测结果。
 *
 * @param {Record<string, any>} catalog 已有目录
 * @param {any[]} roles 角色列表
 * @param {Record<string, string>} [kindToCli] 通道 kind → CLI id（默认用内置映射）
 * @returns {Record<string, any>} 新目录（不修改入参）
 */
export function mergeRoleBoundModels(catalog, roles, kindToCli) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [cli, entry] of Object.entries(catalog ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    out[cli] = {
      models: Array.isArray(entry.models) ? entry.models.map((/** @type {any} */ m) => ({ ...m })) : [],
      strengths: Array.isArray(entry.strengths) ? [...entry.strengths] : [],
      rows: Array.isArray(entry.rows) ? [...entry.rows] : [],
    }
  }
  const map = kindToCli ?? CHANNEL_KIND_TO_CLI
  for (const role of Array.isArray(roles) ? roles : []) {
    if (!role || typeof role !== 'object') continue
    const model = asString(role.model) || asString(role.channel?.model)
    if (!model) continue
    const reasoning = asString(role.reasoning) || asString(role.channel?.reasoning)
    const kind = asString(role.channel?.kind) || asString(role.kind)
    const cli = /** @type {Record<string, string>} */ (map)[kind] ?? null
    if (!cli) continue
    const bucket = out[cli] ?? { models: [], strengths: [], rows: [] }
    out[cli] = bucket
    const provider = asString(role.channel?.provider) || asString(role.provider) || null
    const existing = bucket.models.find((/** @type {any} */ item) => item.id === model)
    if (existing) {
      if (!existing.provider && provider) existing.provider = provider
      if (reasoning && !existing.strengths.includes(reasoning)) existing.strengths.push(reasoning)
      if (!Array.isArray(existing.sources)) existing.sources = ['channel']
      if (!existing.sources.includes('role')) existing.sources.push('role')
    } else {
      bucket.models.push({
        id: model,
        label: model,
        provider,
        strengths: reasoning ? [reasoning] : [],
        sources: ['role'],
      })
    }
    if (reasoning && !bucket.strengths.includes(reasoning)) bucket.strengths.push(reasoning)
  }
  return out
}

/**
 * 合并两个 catalog 源：先出现的优先。channels 源应与 provider 行合并时放在前面，
 * 因为它是派单侧的同一份事实。
 * @param {Record<string, any>} base
 * @param {Record<string, any>} extra
 */
export function mergeCatalogs(base = {}, extra = {}) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const source of [base, extra]) {
    for (const [cli, entry] of Object.entries(source ?? {})) {
      if (!entry || typeof entry !== 'object') continue
      const bucket = out[cli] ?? { models: [], strengths: [], rows: [] }
      out[cli] = bucket
      for (const model of Array.isArray(entry.models) ? entry.models : []) {
        if (!model || !model.id) continue
        const existing = bucket.models.find((/** @type {any} */ item) => item.id === model.id)
        if (existing) {
          if (!existing.provider && model.provider) existing.provider = model.provider
          for (const strength of Array.isArray(model.strengths) ? model.strengths : []) {
            if (!existing.strengths.includes(strength)) existing.strengths.push(strength)
          }
        } else {
          bucket.models.push({
            id: model.id,
            label: model.label || model.id,
            provider: model.provider ?? null,
            strengths: Array.isArray(model.strengths) ? [...model.strengths] : [],
          })
        }
      }
      for (const strength of Array.isArray(entry.strengths) ? entry.strengths : []) {
        if (!bucket.strengths.includes(strength)) bucket.strengths.push(strength)
      }
      for (const row of Array.isArray(entry.rows) ? entry.rows : []) {
        if (!bucket.rows.includes(row)) bucket.rows.push(row)
      }
    }
  }
  return out
}

/**
 * provider 行 → 每个 CLI 的 config 能力（models 按模型 id 去重，provider 保留行里的真实值）。
 * @param {any[]} rows
 * @returns {Record<string, { models: Array<{ id: string, label?: string, provider: string | null, strengths: string[] }>, strengths: string[], rows: string[] }>}
 */
export function providerRowsToCatalog(rows = []) {
  /** @type {Record<string, { models: Array<any>, strengths: Set<string>, rows: string[] }>} */
  const byCli = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    const mapped = providerRowToCapability(row)
    if (!mapped.cli || !mapped.model) continue
    const bucket = byCli[mapped.cli] ?? { models: [], strengths: new Set(), rows: [] }
    byCli[mapped.cli] = bucket
    const existing = bucket.models.find((item) => item.id === mapped.model)
    if (existing) {
      if (!existing.provider && mapped.provider) existing.provider = mapped.provider
      for (const strength of mapped.strengths) if (!existing.strengths.includes(strength)) existing.strengths.push(strength)
    } else {
      bucket.models.push({
        id: mapped.model,
        label: mapped.model,
        provider: mapped.provider,
        strengths: [...mapped.strengths],
      })
    }
    for (const strength of mapped.strengths) bucket.strengths.add(strength)
    if (row && typeof row.id === 'string') bucket.rows.push(row.id)
  }
  /** @type {Record<string, any>} */
  const out = {}
  for (const [cli, bucket] of Object.entries(byCli)) {
    out[cli] = { models: bucket.models, strengths: [...bucket.strengths], rows: bucket.rows }
  }
  return out
}

/**
 * profile 配置文件候选路径（只读）。
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [deps]
 * @returns {string[]}
 */
export function defaultProviderConfigPaths({ env = process.env, home = homedir() } = {}) {
  const paths = []
  const profileDir = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR : ''
  const profileName = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE : ''
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME ? env.DSH_HOME : join(home, '.dsh')
  if (profileDir) paths.push(join(profileDir, 'cordis.patch.yml'), join(profileDir, 'cordis.yml'))
  if (profileName) paths.push(join(dshHome, 'profiles', profileName, 'cordis.patch.yml'))
  paths.push(join(dshHome, 'cordis.patch.yml'))
  return [...new Set(paths)]
}

/**
 * 同步读取 profile provider 行（能力目录创建时立即生效，避免“编辑器第一次打开为空”）。
 * @param {{ env?: Record<string, string | undefined>, home?: string, fs?: { readFileSync?: Function }, paths?: string[] }} [deps]
 * @returns {{ path: string | null, rows: any[], catalog: Record<string, any>, errors: string[] }}
 */
export function readProviderRowsFromProfileSync(deps = {}) {
  const fsImpl = deps.fs?.readFileSync ? deps.fs : { readFileSync }
  const paths = Array.isArray(deps.paths) ? deps.paths : defaultProviderConfigPaths({ env: deps.env, home: deps.home })
  /** @type {string[]} */
  const errors = []
  for (const path of paths) {
    try {
      const text = fsImpl.readFileSync(path, 'utf8')
      const rows = parseProviderPatchRows(String(text))
      return { path, rows, catalog: providerRowsToCatalog(rows), errors }
    } catch (err) {
      const code = /** @type {any} */ (err)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        errors.push(`读取 ${path} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  errors.push('未找到可读的 profile 配置（cordis.patch.yml）')
  return { path: null, rows: [], catalog: {}, errors }
}

/**
 * 异步读取 profile provider 行（刷新时重新读取，反映 profile 变更）。
 * @param {{ env?: Record<string, string | undefined>, home?: string, fs?: { readFile?: Function }, paths?: string[] }} [deps]
 * @returns {Promise<{ path: string | null, rows: any[], catalog: Record<string, any>, errors: string[] }>}
 */
export async function readProviderRowsFromProfile(deps = {}) {
  const fsImpl = deps.fs?.readFile ? deps.fs : { readFile }
  const paths = Array.isArray(deps.paths) ? deps.paths : defaultProviderConfigPaths({ env: deps.env, home: deps.home })
  /** @type {string[]} */
  const errors = []
  for (const path of paths) {
    try {
      const text = await fsImpl.readFile(path, 'utf8')
      const rows = parseProviderPatchRows(String(text))
      return { path, rows, catalog: providerRowsToCatalog(rows), errors }
    } catch (err) {
      const code = /** @type {any} */ (err)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        errors.push(`读取 ${path} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  errors.push('未找到可读的 profile 配置（cordis.patch.yml）')
  return { path: null, rows: [], catalog: {}, errors }
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
 * 构造一个 CLI 目录条目（按来源优先级合并：discovered > config > static > unknown）。
 *
 * 合并策略（Lead 定版）：
 * - 模型：动态发现列表 + profile provider 行的真实声明（按 id 去重；同一 id 以 discovered 为准）；
 *   两者都空时才回退静态表；动态成功但为空且无 config 时保持空（不伪造、不回退静态）。
 * - 强度：动态发现的强度并集 + profile 行 `--effort` 的并集；都没有时才回退静态表。
 * - 每个模型保留自己的 `provider`（config 行用 providerName，保证“选中模型能反查 provider”）。
 *
 * @param {string} cli
 * @param {{ discovered?: Array<{ id: string, label?: string, strengths?: string[] }> | null, config?: { models: any[], strengths: string[] } | null, errors?: string[], refreshedAt?: number | null }} [state]
 */
export function buildCatalogEntry(cli, state = {}) {
  const staticSpec = /** @type {Record<string, any>} */ (STATIC_CATALOG)[cli] ?? { models: [], strengths: [] }
  const discovered = Array.isArray(state.discovered) ? state.discovered : null
  const config = state.config && typeof state.config === 'object' ? state.config : null
  const configModels = Array.isArray(config?.models) ? config.models : []
  const errors = Array.isArray(state.errors) ? [...state.errors] : []

  /** @type {Array<{ id: string, label: string, provider: string | null, source: string, contextWindow?: number | null, contextWindowSource?: string }>} */
  const models = []
  /** @type {Set<string>} */
  const modelIds = new Set()
  for (const item of discovered ?? []) {
    if (!item || !item.id || modelIds.has(item.id)) continue
    modelIds.add(item.id)
    models.push({
      id: item.id,
      label: item.label || item.id,
      provider: providerForModel(cli, item.id),
      source: CAPABILITY_SOURCES.DISCOVERED,
      // 上下文窗口（最大输入 token 数）。
      // 来源优先级：probe 实测 > 本地官方元数据（product.json）> null（未知）。
      // **不猜**：拿不到就是 null，UI 显示「未知」。猜错的后果是按 1M 规划、
      // 实际只有 200K 时在 20% 处被静默截断，比「未知」危险得多。
      ...(Number.isFinite(item.contextWindow)
        ? {
            contextWindow: Number(item.contextWindow),
            contextWindowSource: item.contextWindowSource || 'probe',
          }
        : {}),
    })
  }
  for (const item of configModels) {
    if (!item || !item.id || modelIds.has(item.id)) continue
    modelIds.add(item.id)
    models.push({
      id: item.id,
      label: item.label || item.id,
      provider: item.provider || providerForModel(cli, item.id),
      source: CAPABILITY_SOURCES.CONFIG,
    })
  }
  let modelsSource
  if (models.length > 0) {
    modelsSource = models.some((item) => item.source === CAPABILITY_SOURCES.DISCOVERED)
      ? CAPABILITY_SOURCES.DISCOVERED
      : CAPABILITY_SOURCES.CONFIG
  } else if (discovered !== null) {
    // 动态成功但为空、且 config 也没有：以动态为准（不回退静态表，不伪造）
    modelsSource = CAPABILITY_SOURCES.DISCOVERED
  } else if (staticSpec.models.length > 0) {
    for (const item of staticSpec.models) {
      if (!item || !item.id || modelIds.has(item.id)) continue
      modelIds.add(item.id)
      models.push({
        id: item.id,
        label: item.label || item.id,
        provider: providerForModel(cli, item.id),
        source: CAPABILITY_SOURCES.STATIC,
      })
    }
    modelsSource = CAPABILITY_SOURCES.STATIC
  } else {
    modelsSource = CAPABILITY_SOURCES.UNKNOWN
  }

  /** @type {Set<string>} */
  const strengthIds = new Set()
  /** @type {Array<{ id: string, label: string, source: string }>} */
  const strengths = []
  for (const item of discovered ?? []) {
    for (const effort of item.strengths ?? []) {
      if (!effort || strengthIds.has(effort)) continue
      strengthIds.add(effort)
      strengths.push({ id: effort, label: strengthLabel(effort), source: CAPABILITY_SOURCES.DISCOVERED })
    }
  }
  for (const effort of Array.isArray(config?.strengths) ? config.strengths : []) {
    const id = typeof effort === 'string' ? effort : ''
    if (!id || strengthIds.has(id)) continue
    strengthIds.add(id)
    strengths.push({ id, label: strengthLabel(id), source: CAPABILITY_SOURCES.CONFIG })
  }
  let strengthsSource
  if (strengths.length > 0) {
    strengthsSource = strengths.some((item) => item.source === CAPABILITY_SOURCES.DISCOVERED)
      ? CAPABILITY_SOURCES.DISCOVERED
      : CAPABILITY_SOURCES.CONFIG
  } else if (discovered !== null) {
    strengthsSource = CAPABILITY_SOURCES.UNKNOWN
  } else if (staticSpec.strengths.length > 0) {
    for (const id of staticSpec.strengths) {
      if (strengthIds.has(id)) continue
      strengthIds.add(id)
      strengths.push({ id, label: strengthLabel(id), source: CAPABILITY_SOURCES.STATIC })
    }
    strengthsSource = CAPABILITY_SOURCES.STATIC
  } else {
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
 * - `probes.codebuddy({ executable })`：走 ACP session/new 拿账号可用模型
 * - `resolveExecutable(cli)`：把 CLI 解析成可执行文件路径（host 用已有 probe）
 * - `ttlMs`：**已不再用于自动刷新**（2026-11-13 改为「首次 + 手动」）。
 *   保留这个参数是为了兼容既有调用方；它的值只影响 `refreshedAt` 的可观测语义。
 * - `autoRefresh`：默认 true。为 true 时**只在本进程首次读快照**时后台刷一次；
 *   之后必须显式 `refresh()`（即用户点「刷新能力」）才会更新。
 *
 * @param {{
 *   probes?: { codex?: Function, dsh?: Function },
 *   resolveExecutable?: (cli: string) => Promise<string | null>,
 *   now?: () => number,
 *   ttlMs?: number,
 *   autoRefresh?: boolean,
 *   configReader?: (() => Promise<{ path: string | null, rows: any[], catalog: Record<string, any>, errors: string[] }>) | null,
 *   configReaderSync?: (() => { path: string | null, rows: any[], catalog: Record<string, any>, errors: string[] }) | null,
 *   channelsSource?: () => any[],
 *   rolesSource?: () => any[],
 * }} [options]
 * @returns {CapabilityCatalog}
 */
export function createCliCapabilityCatalog(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : DEFAULT_CAPABILITY_TTL_MS
  const probes = options.probes ?? {}
  const resolveExecutable = options.resolveExecutable ?? (async () => null)
  const autoRefresh = options.autoRefresh !== false
  // roles 源：角色实际绑定的模型/强度（「模型列表刷新不正常」的正解之二，见 mergeRoleBoundModels）。
  // 与 `channels` 一样接受函数或数组，保持参数风格一致。
  const rolesSource =
    typeof options.roles === 'function' ? options.roles : () => options.roles ?? []
  // channels 源：插件配置里的通道实例表（与派单侧 adapter.js 同源）。
  // in-process 的 `llmModel` 只存在于这里，provider 行拿不到（D1 缺陷 1 成因 B）。
  const channelsSource =
    typeof options.channels === 'function' ? options.channels : () => options.channels ?? []
  // config 源：本机 profile provider 行的真实声明。默认启用（只读解析 profile patch）；
  // 测试可传 null 明确关闭，避免依赖本机 profile。
  const configReaderSync =
    options.configReaderSync === null
      ? null
      : typeof options.configReaderSync === 'function'
        ? options.configReaderSync
        : () => readProviderRowsFromProfileSync()
  const configReader =
    options.configReader === null
      ? null
      : typeof options.configReader === 'function'
        ? options.configReader
        : () => readProviderRowsFromProfile()
  /** @type {{ path: string | null, rows: any[], catalog: Record<string, any>, errors: string[], rowCount: number }} */
  let configData = { path: null, rows: [], catalog: {}, errors: [], rowCount: 0 }
  if (configReaderSync) {
    try {
      const initial = configReaderSync()
      if (initial) configData = { ...initial, rowCount: Array.isArray(initial.rows) ? initial.rows.length : 0 }
    } catch (err) {
      configData = {
        path: null,
        rows: [],
        catalog: {},
        errors: [`读取 profile provider 配置失败：${err instanceof Error ? err.message : String(err)}`],
        rowCount: 0,
      }
    }
  }
  /**
   * channels 源与 profile provider 行合并。channels 优先——它与派单侧同源，
   * 而 provider 行只覆盖外部 CLI。每次取用都重算，`channels` 以函数形式传入时
   * 能反映运行期配置变化。
   */
  function effectiveCatalog() {
    let channels = []
    try {
      channels = Array.isArray(channelsSource()) ? channelsSource() : []
    } catch {
      channels = []
    }
    let roles = []
    try {
      roles = Array.isArray(rolesSource()) ? rolesSource() : []
    } catch {
      roles = []
    }
    // 顺序：provider 行（只覆盖外部 CLI）→ channels（与派单侧同源，优先）
    // → 角色绑定（角色派单时实际用的就是它，最高优先，只做补全集）。
    const withChannels = mergeCatalogs(channelsToCatalog(channels), configData.catalog ?? {})
    return mergeRoleBoundModels(withChannels, roles)
  }
  /** @type {Map<string, { discovered: any[] | null, config: any, errors: string[], refreshedAt: number | null }>} */
  const state = new Map()
  {
    const catalog = effectiveCatalog()
    for (const cli of CLI_IDS) {
      state.set(cli, {
        discovered: null,
        config: catalog[cli] ?? null,
        errors: [],
        refreshedAt: null,
      })
    }
  }
  let lastRefreshAt = null
  /** @type {Promise<any> | null} */
  let inFlight = null

  /** @returns {any[]} */
  function list() {
    return CLI_IDS.map((cli) => buildCatalogEntry(cli, state.get(cli)))
  }

  function snapshot() {
    // 「首次 + 手动」策略（2026-11-13 用户决定）。
    //
    // 之前：`autoRefresh` 默认 true + 5 分钟 TTL —— 每次打开设置页且距上次
    // 超过 5 分钟，就会在后台静默刷新。对 CodeBuddy 这种要起子进程、
    // 耗时约 5 秒的探测，这个成本没有意义（用户原话：「频繁获取也没有意义」）。
    //
    // 现在：只在**本进程首次**读快照时自动刷一次（用户不用等首屏），
    // 之后一律只在用户点「刷新能力」时刷新。
    const isFirstRead = lastRefreshAt === null
    if (autoRefresh && isFirstRead && !inFlight) {
      // 后台刷新：list 只读、不阻塞；刷新完成后下次 list 可见（可观测 refreshedAt）
      void refresh(undefined, { force: false }).catch(() => {})
    }
    return {
      capabilities: list(),
      refreshedAt: lastRefreshAt,
      errors: [...new Set([
        ...configData.errors,
        ...CLI_IDS.flatMap((cli) => state.get(cli)?.errors ?? []),
      ])],
      // config 源可观测（host.js 不消费也没关系；便于测试/诊断与报告复核）
      capabilitiesConfig: {
        path: configData.path,
        rows: configData.rowCount,
        errors: [...configData.errors],
      },
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
      // 0) 重新读取 profile provider 行（只读；失败保留上一次成功结果），
      //    再与 channels 源合并后回写到每个 CLI 的 config。
      if (configReader) {
        try {
          const next = await configReader()
          if (next) {
            configData = {
              ...next,
              rowCount: Array.isArray(next.rows) ? next.rows.length : 0,
            }
            const nextCatalog = effectiveCatalog()
            for (const id of CLI_IDS) {
              const current = state.get(id)
              if (current) current.config = nextCatalog[id] ?? null
            }
          }
        } catch (err) {
          configData = {
            ...configData,
            errors: [`读取 profile provider 配置失败：${err instanceof Error ? err.message : String(err)}`],
          }
          errors.push(...configData.errors)
        }
      }
      // channels 源可能运行期变化（配置热更新）；即便 provider 读取失败也重算一次。
      const catalog = effectiveCatalog()
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
          } else if (target === 'codebuddy' && typeof probes.codebuddy === 'function') {
            // 2026-11-13：CodeBuddy 走 ACP session/new 拿账号实际可用的模型。
            // 之前这里没有分支，所以 codebuddy 永远只显示配置里的 4 个模型
            //（用户反馈「只有我之前使用的选项」的成因之一）。
            const executable = await resolveExecutable('codebuddy')
            const found = await probes.codebuddy({ executable })
            if (Array.isArray(found)) discovered = found
            else if (found && Array.isArray(found.models)) discovered = found.models
          }
          if (discovered !== null) {
            state.set(target, {
              discovered,
              config: catalog[target] ?? null,
              errors: [],
              refreshedAt: now(),
            })
            refreshed.push(target)
          } else {
            // 无可动态来源（claude/codebuddy）：保留 config/静态表，仅记录刷新时间
            state.set(target, {
              discovered: null,
              config: catalog[target] ?? null,
              errors: current.errors,
              refreshedAt: now(),
            })
            refreshed.push(target)
          }
        } catch (err) {
          const message = `${target}: ${err instanceof Error ? err.message : String(err)}`
          errors.push(message)
          // 动态失败 → 保留 config/静态表（不伪造 discovered），错误可观测
          state.set(target, {
            discovered: null,
            config: catalog[target] ?? null,
            errors: [message],
            refreshedAt: now(),
          })
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
 * 探测 CodeBuddy 的模型与思考强度：走 **ACP 的 session/new**。
 *
 * ## 为什么这条路可行（都有出处）
 *
 * 1. **ACP 规范**（agentclientprotocol.com/protocol）：
 *    `session/new` 的 response 含
 *      `models: SessionModelState | null`
 *      `models.availableModels: List of available model objects`
 *      `models.currentModelId: string`
 *
 * 2. **社区实测**（farm-out 的 observed-behaviour.md，2026-09-23）：
 *    > "The model list comes with the session. session/new returns the available
 *    >  model ids and a set of config options (model, thought_level, and
 *    >  context_window for some models). No inference is needed to read them,
 *    >  which is what probe, models and doctor use."
 *
 * 3. **本机实测（2026-11-12，本文件作者）**：
 *    - 启动：`node <codebuddy-pkg>/bin/codebuddy --acp`
 *      （**必须**用 `bin/codebuddy`；用 `lib/node/index.js` 会因 ESM 缺 `.js` 后缀崩溃）
 *    - 发 `initialize` → 正常返回 `agentCapabilities`
 *    - 发 `session/new` → 返回 20 个模型的 `availableModels`
 *    - `configOptions` 里 `thought_level` 的可选值是 `high` / `enabled`
 *    - 每个模型带积分倍率（在 `description` 里，形如 `x0.11 credits`）
 *
 * ## 与「静态配置」的区别
 *
 * 之前 codebuddy 没有 probe，模型只能来自 profile 配置（用户看到 4 个）。
 * 走 ACP 后能拿到账号实际可用的全部模型（实测 20 个），且带积分倍率。
 *
 * @param {object} opts
 * @param {string} opts.executable codebuddy 入口脚本绝对路径
 * @param {string} [opts.runtimeExecutable] 用哪个 node 跑它（默认 process.execPath）
 * @param {string} [opts.cwd] session/new 的 cwd
 * @param {number} [opts.timeoutMs] 整体超时（默认 30s）
 * @param {any} [opts.spawnImpl] 测试注入（默认 node:child_process.spawn）
 * @returns {Promise<Array<{ id: string, label?: string, description?: string, strengths?: string[] }>>}
 */
export async function probeCodebuddyModels({
  executable,
  runtimeExecutable,
  cwd,
  timeoutMs = 30_000,
  spawnImpl = nodeSpawn,
} = /** @type {any} */ ({})) {
  if (!executable || typeof executable !== 'string') {
    throw new Error('CODEBUDDY_EXECUTABLE_MISSING: 缺少 codebuddy 入口脚本路径')
  }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(runtimeExecutable || process.execPath, [executable, '--acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          // 社区实测：继承这两个变量会让 CLI 试着绑一个已占用的端口然后卡住
          SERVER__PORT: '',
          SERVER__HOST: '',
        },
      })
    } catch (err) {
      reject(new Error(`CODEBUDDY_SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    let buffer = ''
    let settled = false
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    /** @type {string[]} */
    const stderrTail = []
    let nextId = 1

    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        /* ignore */
      }
      reject(error)
    }

    /** @param {any} value */
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        child?.kill()
      } catch {
        /* ignore */
      }
      resolve(value)
    }

    timer = setTimeout(() => {
      fail(
        new Error(
          `CODEBUDDY_MODEL_LIST_TIMEOUT（${timeoutMs}ms）` +
            (stderrTail.length ? `；stderr: ${stderrTail.slice(-3).join(' | ')}` : ''),
        ),
      )
    }, timeoutMs)

    /** @param {any} message */
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch (err) {
        fail(new Error(`CODEBUDDY_STDIN_FAILED: ${err instanceof Error ? err.message : String(err)}`))
      }
    }

    let initDone = false
    let sessionSent = false

    const handleMessage = (/** @type {any} */ msg) => {
      if (!msg || typeof msg !== 'object') return
      // initialize 的响应 → 紧接着发 session/new
      if (msg.id === 1 && !initDone) {
        initDone = true
        if (msg.error) {
          fail(new Error(`CODEBUDDY_INIT_FAILED: ${JSON.stringify(msg.error)}`))
          return
        }
        sessionSent = true
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: typeof cwd === 'string' && cwd ? cwd : process.cwd(), mcpServers: [] },
        })
        return
      }
      // session/new 的响应 → 提取模型
      if (msg.id === 2 && sessionSent) {
        if (msg.error) {
          fail(new Error(`CODEBUDDY_SESSION_NEW_FAILED: ${JSON.stringify(msg.error)}`))
          return
        }
        const result = msg.result ?? {}
        const available = Array.isArray(result.models?.availableModels)
          ? result.models.availableModels
          : []
        const configOptions = Array.isArray(result.configOptions) ? result.configOptions : []
        const thoughtOption = configOptions.find((/** @type {any} */ o) => o && o.id === 'thought_level')
        const strengths = Array.isArray(thoughtOption?.options)
          ? thoughtOption.options.map((/** @type {any} */ o) => String(o?.value ?? o)).filter(Boolean)
          : []
        // **关键**：`availableModels[].id` 是**显示名**（如 `Hy4`、`Kimi-K3.1-Pro`），
        // 不是能传给 `--model` 的 id。真正可用的是 `configOptions` 里
        // `id === 'model'` 那一项的 `options[].value`（如 `hy4free`、`kimi-k3.1-pro`）。
        //
        // 2026-11-12 实测：两者按顺序一一对应，数量相同（各 20 个）。
        // 如果数量不一致，退回用 availableModels 的 id（至少能显示，标 unknown 来源）。
        const modelOption = configOptions.find((/** @type {any} */ o) => o && o.id === 'model')
        const wireIds = Array.isArray(modelOption?.options)
          ? modelOption.options.map((/** @type {any} */ o) => String(o?.value ?? o ?? '')).filter(Boolean)
          : []
        const useWireIds = wireIds.length === available.length

        done(
          available.map((/** @type {any} */ m, /** @type {number} */ index) => {
            const displayId = String(m?.id ?? m?.name ?? '')
            const wireId = useWireIds ? wireIds[index] : displayId
            return {
              // id 用于派单（--model 的值）；label 用于界面显示
              id: wireId || displayId,
              label: displayId || wireId,
              description: typeof m?.description === 'string' ? m.description : undefined,
              ...(strengths.length > 0 ? { strengths: [...strengths] } : {}),
            }
          }),
        )
      }
    }

    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            handleMessage(JSON.parse(line))
          } catch {
            /* 非 JSON 行（日志噪音）忽略 */
          }
        }
        index = buffer.indexOf('\n')
      }
    })

    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      stderrTail.push(chunk.toString('utf8').trim())
      if (stderrTail.length > 20) stderrTail.shift()
    })

    child.on('error', (/** @type {Error} */ err) => {
      fail(new Error(`CODEBUDDY_PROCESS_ERROR: ${err.message}`))
    })
    child.on('exit', (/** @type {number} */ code) => {
      if (!settled) {
        fail(
          new Error(
            `CODEBUDDY_EXITED_EARLY: 退出码 ${code}` +
              (stderrTail.length ? `；stderr: ${stderrTail.slice(-3).join(' | ')}` : ''),
          ),
        )
      }
    })

    // 握手开始
    send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'meetingstone-probe', version: '0.1.0' },
      },
    })
  })
}

/**
 * 把 CLI 的探测路径解析成「能用 `node` 直接跑的 JS 入口」。
 *
 * ## 为什么需要（2026-11-13 真机暴露）
 *
 * `probe.probe('codebuddy')` 在 Windows 上返回的是 **`codebuddy.cmd`**
 * （`C:\Users\<u>\AppData\Roaming\npm\codebuddy.cmd`）—— 那是 npm 生成的
 * shell 包装脚本，**不是** JavaScript。
 *
 * 我们的 ACP 探测是 `spawn(process.execPath, [entry, '--acp'])`，
 * 把 `.cmd` 交给 node 解析会直接报：
 *   `SyntaxError: Invalid or unexpected token` → 退出码 1
 * → probe 抛错 → 能力目录保留 config 来源
 * → UI 显示「配置」而不是「动态」→ 用户看到只有 4 个模型。
 *
 * ## 解析规则
 *
 * - `.js` / `.mjs` / `.cjs` → 原样
 * - `.cmd` / `.ps1` / `.bat` → 从 npm 全局布局反推：
 *   `<npm>/codebuddy.cmd` → `<npm>/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`
 * - 其他（`.exe`）→ 原样返回，由调用方决定（外部 CLI 可执行文件本来就该直接跑）
 *
 * @param {string} cliPath
 * @param {string} cli
 * @returns {string}
 */
function resolveJsEntry(cliPath, cli) {
  const p = String(cliPath || '')
  if (!p) return p
  const lower = p.toLowerCase()
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return p
  if (!/\.(cmd|ps1|bat)$/.test(lower)) return p

  // Windows npm 全局布局：<prefix>/<name>.cmd → <prefix>/node_modules/<pkg>/<bin>
  const dir = dirname(p)
  const NPM_PKG = {
    codebuddy: '@tencent-ai/codebuddy-code',
    codex: '@openai/codex',
    claude: '@anthropic-ai/claude-code',
  }
  const pkg = NPM_PKG[cli]
  if (pkg) {
    // 该包的入口脚本（从 package.json 的 bin 字段实测）
    const BIN_REL = {
      codebuddy: ['bin', 'codebuddy'],
    }
    const rel = BIN_REL[cli] || []
    if (rel.length > 0) {
      const candidate = join(dir, 'node_modules', ...pkg.split('/'), ...rel)
      try {
        if (readFileSync(candidate)) return candidate
      } catch {
        /* 不存在就往下走 */
      }
    }
  }
  return p
}

/**
 * 从 WorkBuddy 本地桥读取**完整**模型目录。
 *
 * ## 为什么需要（2026-11-13 用户反馈）
 *
 * 用户说「deepseek harness 我现在接的起码有 20 个模型」，而我们的 dsh probe
 * 只报 1 个。实测真相：桥上有 **59 个**。
 *
 * ## 为什么不能只靠 ctx.llm.listModels()
 *
 * `listModels(provider)` 走的是 DSH 的适配层，返回的模型经过了适配器的
 * filter（`modelAllow` / 面板显示偏好），**不是**桥的完整目录。
 *
 * ## 关键：必须带 `?all=1`
 *
 * 实测：
 * - `GET /v1/models`        → **3 个**（被过滤）
 * - `GET /v1/models?all=1`  → **59 个**（完整，含 context_window 等全部字段）
 *
 * 鉴权：本地回环令牌，文件在 `<user>/.workbuddy-bridge/bridge-token`。
 *
 * @param {{ host?: string, port?: number, token?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<Array<{ id: string, label?: string, contextWindow?: number, maxOutputTokens?: number, strengths?: string[] }>>}
 */
export async function probeWorkbuddyBridgeModels(opts = {}) {
  const host = opts.host || process.env.WORKBUDDY_BRIDGE_HOST || '127.0.0.1'
  const port = Number(opts.port || process.env.WORKBUDDY_BRIDGE_PORT || 8790)
  const timeoutMs = Number(opts.timeoutMs) || 15_000

  const token =
    (typeof opts.token === 'string' && opts.token) ||
    process.env.WORKBUDDY_BRIDGE_TOKEN ||
    (() => {
      // 令牌文件：实测在 ~/.workbuddy-bridge/bridge-token
      const home = (() => {
        try {
          return homedir()
        } catch {
          return ''
        }
      })()
      if (!home) return ''
      const candidates = [
        process.env.WORKBUDDY_DATA_DIR ? join(process.env.WORKBUDDY_DATA_DIR, 'bridge-token') : '',
        join(home, '.workbuddy-bridge', 'bridge-token'),
        join(home, '.workbuddy', 'bridge-token'),
      ].filter(Boolean)
      for (const p of candidates) {
        try {
          const t = readFileSync(p, 'utf8').trim()
          if (t) return t
        } catch {
          /* 读不到继续 */
        }
      }
      return ''
    })()

  const url = `http://${host}:${port}/v1/models?all=1`
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  /** @type {Response} */
  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(
      `WORKBUDDY_BRIDGE_UNREACHABLE: ${url} — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (res.status === 401) {
    throw new Error(
      token
        ? 'WORKBUDDY_BRIDGE_UNAUTHORIZED: 令牌无效（桥可能重启后生成了新令牌）'
        : 'WORKBUDDY_BRIDGE_NO_TOKEN: 没找到 bridge-token（通常在 ~/.workbuddy-bridge/）',
    )
  }
  if (!res.ok) throw new Error(`WORKBUDDY_BRIDGE_HTTP_${res.status}: ${url}`)

  /** @type {any} */
  let parsed
  try {
    parsed = await res.json()
  } catch (error) {
    throw new Error(`WORKBUDDY_BRIDGE_BAD_JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.data ?? parsed?.models ?? []
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('WORKBUDDY_BRIDGE_EMPTY: 桥返回的模型列表为空')
  }

  return list
    .filter((/** @type {any} */ m) => m && typeof m === 'object')
    .map((/** @type {any} */ m) => {
      const id = asString(m.id) || asString(m.model)
      if (!id) return null
      // 上下文：优先 context_window（当前档），其次 max_input_tokens / context_length
      const ctxRaw =
        Number(m.context_window) ||
        Number(m.max_input_tokens) ||
        Number(m.context_length) ||
        Number(m.contextWindow) ||
        0
      const outRaw = Number(m.max_output_tokens) || Number(m.maxOutputTokens) || 0
      const efforts = Array.isArray(m.reasoning_efforts)
        ? m.reasoning_efforts.map(String).filter(Boolean)
        : []
      return {
        id,
        label: buildBridgeModelLabel(id, m),
        ...(ctxRaw > 0 ? { contextWindow: ctxRaw, contextWindowSource: 'workbuddy-bridge' } : {}),
        ...(outRaw > 0 ? { maxOutputTokens: outRaw } : {}),
        ...(efforts.length > 0 ? { strengths: efforts } : {}),
      }
    })
    .filter((/** @type {any} */ m) => Boolean(m))
}

/**
 * 从桥生成的 label 里抽出标注段。
 *
 * `Hy4（免费 · free）` → `免费 · free`
 * `GLM-5.3（x0.69）`   → `x0.69`
 * `Hy4`                → `''`（没有标注）
 *
 * 用于把桥的计费/归属信息复用到**别的来源**（如 CodeBuddy 的 ACP 结果），
 * 让同一个模型在不同入口有一致的可区分标注。
 *
 * @param {any} label
 * @returns {string}
 */
function extractLabelMarks(label) {
  const s = asString(label)
  const m = s.match(/（(.+)）\s*$/)
  return m && m[1] ? m[1] : ''
}

/**
 * 给桥返回的模型生成**可区分**的显示名。
 *
 * ## 为什么需要（2026-11-13 用户反馈）
 *
 * 桥上有多组同名模型，直接用 `name` 会让下拉里出现两个一模一样的
 * 「Hy4 · 动态 · 300K」，用户无法知道哪个免费、哪个扣积分：
 *
 * | id | name | credits | official |
 * |---|---|---|---|
 * | `hy4free` | Hy4 | **0**（免费） | 官方 |
 * | `hy4std` | Hy4 | **0.29** | 官方 |
 * | `hy3` | Hy3 | 0 | 官方 |
 * | `hy3-x` | Hy3 | **0.05** | 官方 |
 * | `kimi-k3-2` | Kimi-K3 | 1.62 | 官方 |
 * | `kimi-k3-1` | Kimi-K3 | 1.62 | **三方** |
 * | `hy4-preview-*` × 5 | Hy4 preview | 0.29 | 三方 |
 *
 * ## 标注规则（只在需要时加，不污染干净的名字）
 *
 * 1. **免费**：`credits === 0` → 加「免费」；否则 `x0.29`
 * 2. **非官方**（`official === false`）→ 加「三方」
 * 3. **促销**（`tags` 含 `badge:xxx`）→ 加 badge 文本
 * 4. **同组重名**：当 name 有多个 id 共用时，额外带上 id 里的区分后缀
 *    （如 `hy3-b` → 「Hy3 · b」），保证任意两条不重复
 *
 * 注意：这些只是**显示名**，`id` 保持不变（派单用的还是真 id）。
 *
 * @param {string} id
 * @param {any} raw 桥返回的原始条目
 * @returns {string}
 */
function buildBridgeModelLabel(id, raw) {
  const base = asString(raw?.name) || asString(raw?.displayName) || id
  /** @type {string[]} */
  const marks = []

  // 1) 计费：免费 or 倍率
  const credits = raw?.credits
  if (credits === 0 || credits === '0') {
    marks.push('免费')
  } else if (Number.isFinite(Number(credits)) && Number(credits) > 0) {
    marks.push(`x${Number(credits)}`)
  }

  // 2) 官方 / 三方
  if (raw?.official === false) marks.push('三方')

  // 3) 促销徽标（tags: ["badge:限时免费:#009273"]）
  //    若徽标文本与已有的「免费」重复，就不再加（避免「Hy4（免费 · 限时免费）」
  //    这种冗余；但「限时折扣 / 夜间折扣 / 订阅优先」这类信息要保留）。
  if (Array.isArray(raw?.tags)) {
    for (const tag of raw.tags) {
      const s = String(tag)
      if (!s.startsWith('badge:')) continue
      const text = s.slice('badge:'.length).split(':')[0]
      if (!text) continue
      const duplicated = marks.includes(text) || (text === '限时免费' && marks.includes('免费'))
      if (!duplicated) marks.push(text)
    }
  }

  // 4) 同组重名时补 id 区分段
  //    例：hy3 / hy3-b / hy3-c 都叫 Hy3 → 后两个补「b」「c」
  //        hy4-preview-ctrl / -exp / -x → 补「ctrl」「exp」「x」
  //
  //    做法：在**原始 id** 上找 display name 的归一化前缀长度，
  //    再取剩余部分。不能用 `slice(-4)` 那种取巧写法 ——
  //    会把 `hy4free` 截成 `ree`、`hy4std` 截成 `td`、`kimi-k3-2` 截成 `i-k3-2`。
  const displayKey = base.toLowerCase().replace(/[\s_.-]+/g, '')
  const idKey = id.toLowerCase().replace(/[\s_.-]+/g, '')
  if (idKey !== displayKey && idKey.startsWith(displayKey)) {
    // 逐字符对齐，找出原始 id 里「display 名之后」的起点
    let i = 0
    let j = 0
    const lowerId = id.toLowerCase()
    const lowerBase = base.toLowerCase()
    while (i < lowerId.length && j < lowerBase.length) {
      const ch = lowerId[i]
      if (/[\s_.-]/.test(ch)) {
        i += 1
        continue
      }
      if (ch === lowerBase[j]) {
        i += 1
        j += 1
        continue
      }
      break
    }
    const suffix = id.slice(i).replace(/^[\s_.-]+/, '')
    if (suffix && suffix.length <= 14 && /^[a-z0-9][a-z0-9-]*$/i.test(suffix)) {
      marks.push(suffix)
    }
  }

  return marks.length > 0 ? `${base}（${marks.join(' · ')}）` : base
}

/**
 * 从 CodeBuddy 安装包的 `product.json` 读取模型的上下文窗口。
 *
 * ## 为什么用这个文件
 *
 * 2026-11-13 实测：ACP 的 `configOptions` **不再包含** `context_window`
 * （20 个模型逐个 set 都没有）。但安装包里的 `product.json`（351 KB）
 * 有完整的模型元数据：
 *
 * ```json
 * { "id": "hy4-preview", "maxInputTokens": 1000000,
 *   "contextWindow": { "supportedLengths": [200000, 1000000], "defaultLength": 200000 } }
 * ```
 *
 * **这是安装包自带的官方数据**，比网上搜资料准确。
 *
 * ## 重要限制：只覆盖一部分模型
 *
 * `product.json` 是**产品级目录**（所有可能的模型），ACP 返回的是
 * **账号级可用列表**。实测两份清单只有 6/20 交集：
 * `hy3`、`deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`kimi-k2.8-preview`。
 *
 * 对不命中的模型**返回 null**（UI 显示「未知」），绝不猜。
 *
 * @param {string} codebuddyEntry 形如 `<pkg>/bin/codebuddy` 的入口路径
 * @returns {Map<string, { maxInputTokens: number, maxOutputTokens: number | null, supportedLengths: number[] | null, defaultLength: number | null }>}
 */
function readCodebuddyProductModels(codebuddyEntry) {
  /** @type {Map<string, any>} */
  const out = new Map()
  try {
    // 入口在 <pkg>/bin/codebuddy，product.json 在 <pkg>/product.json
    const pkgDir = dirname(dirname(codebuddyEntry))
    const productPath = join(pkgDir, 'product.json')
    const raw = readFileSync(productPath, 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.models) ? parsed.models : []
    for (const m of list) {
      const id = typeof m?.id === 'string' ? m.id : ''
      if (!id) continue
      const maxInput = Number(m?.maxInputTokens)
      if (!Number.isFinite(maxInput) || maxInput <= 0) continue
      const supported = Array.isArray(m?.contextWindow?.supportedLengths)
        ? m.contextWindow.supportedLengths.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : null
      const defaultLength = Number(m?.contextWindow?.defaultLength)
      out.set(id, {
        maxInputTokens: maxInput,
        maxOutputTokens: Number.isFinite(Number(m?.maxOutputTokens)) ? Number(m.maxOutputTokens) : null,
        supportedLengths: supported && supported.length > 0 ? supported : null,
        defaultLength: Number.isFinite(defaultLength) && defaultLength > 0 ? defaultLength : null,
      })
    }
  } catch {
    // 文件不存在/格式变化 → 返回空表（调用方会显示「未知」）
  }
  return out
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
      const models = await probeCodexModels({ executable: exe, spawnImpl: deps.spawnImpl })
      // Codex app-server 的 model/list **不带** contextWindow，
      // 用模型上下文库补（GPT 系列官方都是 1.05M）。
      return fillContextWindows(models, { cli: 'codex' })
    },
    // CodeBuddy：走 ACP session/new 拿账号实际可用的模型（2026-11-12 实测 20 个）。
    // 之前没有这个 probe，模型只来自 profile 配置（用户看到 4 个）。
    codebuddy: async ({ executable }) => {
      const raw = executable || (await resolveExecutable('codebuddy'))
      if (!raw) throw new Error('codebuddy 入口脚本不可用')
      // **关键**：probe 在 Windows 上返回的是 `codebuddy.cmd`（npm 包装脚本），
      // 直接交给 node 会 SyntaxError。必须解析回真正的 JS 入口。
      const exe = resolveJsEntry(raw, 'codebuddy')
      const models = await probeCodebuddyModels({ executable: exe, spawnImpl: deps.spawnImpl })
      // 补上下文窗口（2026-11-13）。
      // ACP 的 configOptions 已不再包含 context_window（实测 20 个模型都没有），
      // 改从安装包自带的 product.json 取 maxInputTokens。
      // **只对命中的模型补**；不命中的保持 undefined，UI 显示「未知」。
      const productModels = readCodebuddyProductModels(exe)
      const withProduct = models.map((m) => {
        const meta = productModels.get(m.id)
        if (!meta) return m
        return { ...m, contextWindow: meta.maxInputTokens, contextWindowSource: 'product.json' }
      })

      // **优先用桥的真实数据**（2026-11-13）。
      //
      // 桥里恰好有 CodeBuddy 这 20 个模型的**真实** context_window 与计费信息
      //（实测 20/20 命中）。它比 product.json（6/20）和查表（可能是官方上限
      // 而非默认档）都准 —— 例如 hy3-x 桥上是 192K，查表会得到 256K。
      //
      // 所以顺序是：桥 > product.json > 上下文库查表。
      let bridgeMap = null
      try {
        const bridge = await probeWorkbuddyBridgeModels({ timeoutMs: 6000 })
        bridgeMap = new Map(bridge.map((m) => [m.id, m]))
      } catch {
        bridgeMap = null
      }

      const merged = withProduct.map((m) => {
        const b = bridgeMap?.get(m.id)
        if (!b) return m
        /** @type {any} */
        const next = { ...m }
        // 计费/归属标注
        const marks = extractLabelMarks(b.label)
        if (marks) next.label = `${asString(m.label) || m.id}（${marks}）`
        // 上下文：桥的值最权威（它是账号实际可用的默认档）
        if (Number.isFinite(b.contextWindow) && b.contextWindow > 0) {
          next.contextWindow = b.contextWindow
          next.contextWindowSource = 'workbuddy-bridge'
        }
        return next
      })

      // 桥没覆盖到的，再走上下文库查表
      return fillContextWindows(merged, { cli: 'codebuddy' })
    },
    dsh: async () => {
      // **首选：WorkBuddy 桥的完整目录**（2026-11-13 更正）。
      //
      // 实测：桥上有 59 个模型且每个都带 context_window / max_output / reasoning_efforts；
      // 而 `ctx.llm.listModels(provider)` 只返回适配层过滤后的子集（本机实测 1~3 个）。
      // 用户反馈「我接的起码有 20 个模型」——桥才是真相源。
      //
      // 桥不可用（没装 WorkBuddy / 桥没起 / 无令牌）时，回退到宿主 ctx.llm。
      let bridgeModels = null
      let bridgeError = ''
      try {
        bridgeModels = await probeWorkbuddyBridgeModels({ timeoutMs: 8000 })
      } catch (error) {
        bridgeError = error instanceof Error ? error.message : String(error)
      }
      if (Array.isArray(bridgeModels) && bridgeModels.length > 0) {
        return fillContextWindows(bridgeModels, { cli: 'dsh' })
      }

      // 回退：宿主 llm 服务
      const ctx = deps.ctx
      if (!ctx) throw new Error(bridgeError ? `桥不可用（${bridgeError}），且宿主 ctx 不可用` : '宿主 ctx 不可用')
      let llm = null
      try {
        llm = ctx.llm ?? (typeof ctx.get === 'function' ? ctx.get('llm') : null)
      } catch {
        llm = null
      }
      if (!llm || typeof llm.listModels !== 'function') {
        throw new Error(bridgeError ? `桥不可用（${bridgeError}），且宿主 llm.listModels 不可用` : '宿主 llm.listModels 不可用')
      }

      // **关键修复（2026-11-13）**：宿主 `llm.listModels(provider)` **需要 provider 参数**。
      //
      // 取证：`app.asar: dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`
      //   async listModels(provider) {
      //     return this.dependencies.discoverModels?.(provider) ?? []
      //   }
      //
      // 之前我们调 `llm.listModels()`（无参）→ `discoverModels(undefined)` → 返回空，
      // 于是 DSH 的模型列表只剩配置里的那一个。用户反馈「我接的起码有 20 个模型」
      // 就是这个原因。
      //
      // 现在：先问宿主有哪些 provider，再逐个 `listModels(provider)` 并合并去重。
      // 拿不到 provider 清单时退回无参调用（保持旧行为，不至于完全失效）。
      /** @type {string[]} */
      let providers = []
      try {
        // 宿主的 llm 服务通常有 providers() / listProviders()；两种都试。
        if (typeof llm.providers === 'function') {
          const raw = await llm.providers()
          if (Array.isArray(raw)) providers = raw.map((p) => asString(p?.id ?? p?.name ?? p)).filter(Boolean)
        } else if (typeof llm.listProviders === 'function') {
          const raw = await llm.listProviders()
          if (Array.isArray(raw)) providers = raw.map((p) => asString(p?.id ?? p?.name ?? p)).filter(Boolean)
        }
      } catch {
        providers = []
      }

      /** @type {Map<string, any>} */
      const merged = new Map()
      /** @type {string[]} */
      const errors = []

      const takeFrom = (value) => {
        const { models } = extractHostModels(value)
        for (const m of models) {
          if (m && m.id && !merged.has(m.id)) merged.set(m.id, m)
        }
        return models.length
      }

      if (providers.length > 0) {
        for (const provider of providers) {
          try {
            const value = await llm.listModels(provider)
            takeFrom(value)
          } catch (error) {
            errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } else {
        // 拿不到 provider 清单：退回无参（旧行为）
        const value = await llm.listModels()
        takeFrom(value)
      }

      const models = [...merged.values()]
      if (models.length === 0 && errors.length > 0) {
        throw new Error(`宿主 llm.listModels 全部失败：${errors.slice(0, 3).join(' | ')}`)
      }
      // 宿主 listModels 不保证带 contextWindow，用模型上下文库补。
      // 已经有值的不覆盖。
      return fillContextWindows(models, { cli: 'dsh' })
    },
  }
}
