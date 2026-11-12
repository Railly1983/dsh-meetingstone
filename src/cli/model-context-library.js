// @ts-check
/**
 * 模型上下文窗口的**智能匹配**。
 *
 * ## 为什么需要
 *
 * 语法探测（ACP `configOptions`、CLI `--list-models`、宿主 `listModels`）
 * 并不总能给出 `contextWindow`：
 * - CodeBuddy 2.181.0 的 ACP 已经不返回 `context_window`（实测 20 个模型全无）
 * - `product.json` 只覆盖账号可用列表的一部分（实测 6/20）
 * - Codex app-server 的 `model/list` 根本不带上下文字段
 * - DSH 宿主 `listModels` 也不保证带
 *
 * 但**模型的上下文是公开且固定的**，可以查表补上。
 *
 * ## 匹配策略（按要求做「智能匹配」，不是精确匹配）
 *
 * 按优先级逐级尝试，任一级命中即返回：
 *
 * 1. **归一化精确**：`GLM-5.3` / `glm_5.3` / `glm 5.3` → `glm5.3`
 * 2. **别名表**：目录里显式声明的 `aliases`（如 `hy4free` → `hy4`）
 * 3. **去后缀变体**：`-highspeed` / `-preview` / `-pay` / `-std` / `-free`
 *    这类「同代同窗口」的后缀剥掉再匹配
 * 4. **前缀/包含匹配**：`kimi-k3.1-pro` 命中 `kimi-k3`（同代）
 * 5. **家族兜底**：同厂商同代（`glm-5.*` → GLM-5 家族的窗口）
 *
 * 都匹配不上 → 返回 null（UI 显示「未知」），**绝不瞎猜**。
 *
 * ## 与「硬编码最大值」的区别
 *
 * 每条记录都带 `source` 与 `note`，可以追溯依据。
 * 查不到就是查不到 —— 不把「猜的」伪装成「查到的」。
 *
 * @module src/cli/model-context-library
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = join(HERE, 'model-context-catalog.json')

/** 只在同代同窗口时才可剥离的后缀（顺序有意义：长的在前）。 */
const STRIPPABLE_SUFFIXES = [
  '-highspeed',
  '-preview',
  '-flashx',
  '-flash',
  '-std',
  '-free',
  '-pay',
  '-pro',
  '-exp',
  '-1017',
  '-0813',
  '-202606',
  '-x',
  '-2',
  '-1',
]

/**
 * 把模型名归一化成可比较形式。
 *
 * 规则：小写 → 去掉所有 `-`/`_`/`.`/空格 → 去除非字母数字。
 * 例：`GLM-5.3-Flash` → `glm53flash`；`kimi_k3.1_pro` → `kimik31pro`
 *
 * @param {any} value
 * @returns {string}
 */
export function normalizeModelId(value) {
  const s = typeof value === 'string' ? value : ''
  return s
    .toLowerCase()
    .replace(/[\s_.-]+/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * 剥离同代后缀（只剥一个，且要求剩余部分仍有意义）。
 * @param {string} normalized 已归一化的 id
 * @returns {string[]} 候选（含原值）
 */
function stripSuffixCandidates(normalized) {
  /** @type {string[]} */
  const out = [normalized]
  for (const suffix of STRIPPABLE_SUFFIXES) {
    const flat = suffix.replace(/[^a-z0-9]/g, '')
    if (flat && normalized.endsWith(flat) && normalized.length > flat.length + 2) {
      out.push(normalized.slice(0, -flat.length))
    }
  }
  return [...new Set(out)]
}

/** 目录缓存（读一次，进程内复用）。 */
let cachedCatalog = null

/**
 * 读取上下文目录（带缓存）。
 * @returns {{ models: any[], codexModels: any[], version: number, updatedAt: string } | null}
 */
export function loadContextCatalog() {
  if (cachedCatalog !== null) return cachedCatalog
  try {
    const raw = readFileSync(CATALOG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    cachedCatalog = {
      models: Array.isArray(parsed?.models) ? parsed.models : [],
      codexModels: Array.isArray(parsed?.codexModels) ? parsed.codexModels : [],
      version: Number(parsed?.version) || 1,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    cachedCatalog = { models: [], codexModels: [], version: 1, updatedAt: '' }
  }
  return cachedCatalog
}

/**
 * 为一个模型查上下文窗口。
 *
 * @param {string} modelId 模型 id（如 `glm-5.3-flash`、`GLM-5.3-Flash`）
 * @param {{ cli?: string }} [opts] `cli` 用来优先在对应分组里找（codex 优先 codexModels）
 * @returns {{ contextWindow: number, matchedBy: string, matchedEntry: string, source: string | null, note: string } | null}
 */
export function matchContextForModel(modelId, opts = {}) {
  const wanted = normalizeModelId(modelId)
  if (!wanted) return null
  const catalog = loadContextCatalog()
  if (!catalog) return null

  // codex 的模型优先在 codex 分组查（避免和其他厂商同名冲突）
  const groups =
    opts.cli === 'codex'
      ? [catalog.codexModels, catalog.models]
      : [catalog.models, catalog.codexModels]

  /** @type {string[]} */
  const wantedVariants = stripSuffixCandidates(wanted)

  /** @type {null | { contextWindow: number, matchedBy: string, matchedEntry: string, source: string | null, note: string }} */
  let best = null

  for (const group of groups) {
    for (const entry of group) {
      if (!entry || typeof entry !== 'object') continue
      const ctx = Number(entry.contextWindow)
      if (!Number.isFinite(ctx) || ctx <= 0) continue

      const entryId = normalizeModelId(entry.id)
      const aliasIds = Array.isArray(entry.aliases) ? entry.aliases.map(normalizeModelId) : []

      /** 命中时构造结果 */
      const hit = (/** @type {string} */ matchedBy) => ({
        contextWindow: ctx,
        matchedBy,
        matchedEntry: String(entry.id),
        source: typeof entry.source === 'string' ? entry.source : null,
        note: typeof entry.note === 'string' ? entry.note : '',
      })

      // 1) 归一化精确
      if (entryId === wanted) {
        best = hit('exact')
        break
      }
      // 2) 别名精确
      if (aliasIds.includes(wanted)) {
        best = hit('alias')
        break
      }
      // 3) 去后缀后再比（两边都去）
      const entryVariants = stripSuffixCandidates(entryId)
      if (entryVariants.some((v) => wantedVariants.includes(v))) {
        best = hit('suffix-stripped')
        break
      }
      // 4) 包含匹配：一方是另一方的前缀（且长度够，避免 `hy` 误匹配一切）
      if (
        (wanted.startsWith(entryId) || entryId.startsWith(wanted)) &&
        Math.min(wanted.length, entryId.length) >= 4
      ) {
        best = best ?? hit('prefix')
        continue
      }
      // 5) 别名包含匹配
      for (const alias of aliasIds) {
        if (
          alias &&
          (wanted.startsWith(alias) || alias.startsWith(wanted)) &&
          Math.min(wanted.length, alias.length) >= 4
        ) {
          best = best ?? hit('alias-prefix')
          break
        }
      }
    }
    // 强命中（1/2/3）就不再找下一组
    if (best && best.matchedBy !== 'prefix' && best.matchedBy !== 'alias-prefix') break
  }

  return best
}

/**
 * 批量补上下文：给定模型列表，为没有 contextWindow 的补上。
 *
 * **不覆盖已有的值** —— 语法探测拿到的优先。
 *
 * @param {Array<{ id: string, contextWindow?: number, contextWindowSource?: string }>} models
 * @param {{ cli?: string }} [opts]
 * @returns {Array<{ id: string, contextWindow?: number, contextWindowSource?: string }>}
 */
export function fillContextWindows(models, opts = {}) {
  if (!Array.isArray(models)) return []
  return models.map((m) => {
    if (!m || typeof m !== 'object') return m
    if (Number.isFinite(m.contextWindow) && Number(m.contextWindow) > 0) return m
    const found = matchContextForModel(String(m.id ?? ''), opts)
    if (!found) return m
    return {
      ...m,
      contextWindow: found.contextWindow,
      // 明确标注这是查表得来的，不是探测到的
      contextWindowSource: `catalog:${found.matchedBy}`,
    }
  })
}
