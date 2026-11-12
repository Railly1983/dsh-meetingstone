/**
 * 探测 WorkBuddy 桥的真实模型目录（DSH 的 59 个模型从这里来）。
 *
 * ## 为什么需要
 *
 * 用户反馈「deepseek harness 我现在接的起码有 20 个模型」，
 * 而我的 dsh probe 只报告 1 个。
 *
 * 根因：我把 `ctx.llm.listModels(provider)` 当成了唯一来源，
 * 但 WorkBuddy 的模型目录在**本地桥**上（`http://127.0.0.1:8790/v1/models`），
 * `listModels` 只是把桥的目录转成 DSH 的模型形状。
 *
 * 直接问桥能拿到**最全、最新**的目录（含 contextWindow / maxOutput /
 * 积分倍率 / 思考档位），比二次转换更可靠。
 *
 * ## 鉴权
 *
 * 桥用本地回环令牌，文件在 `<workbuddy-data-dir>/bridge-token`
 * （插件常量 `bridgeTokenPath()`）。请求头形如 `Authorization: Bearer <token>`。
 * 兼容 DSH 的 `WORKBUDDY_SEARCH_BRIDGE_KEY` 环境变量（web search 那份）。
 *
 * 用法：node scripts/probe-workbuddy-bridge.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST = process.env.WORKBUDDY_BRIDGE_HOST || '127.0.0.1'
const PORT = Number(process.env.WORKBUDDY_BRIDGE_PORT || 8790)

/** 令牌候选文件（按优先级）。 */
function tokenCandidates() {
  const home = homedir()
  const out = []
  if (process.env.WORKBUDDY_BRIDGE_TOKEN) out.push(process.env.WORKBUDDY_BRIDGE_TOKEN)
  const dataDir = process.env.WORKBUDDY_DATA_DIR
  if (dataDir) out.push(join(dataDir, 'bridge-token'))
  // **实测位置（2026-11-13）**：C:\Users\<user>\.workbuddy-bridge\bridge-token
  out.push(join(home, '.workbuddy-bridge', 'bridge-token'))
  // 插件目录
  out.push(join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'workbuddy-to-dsh', '.bridge-token'))
  out.push(join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'workbuddy-to-dsh', 'data', 'bridge-token'))
  out.push(join(home, '.workbuddy', 'bridge-token'))
  return out
}

/** 读令牌：先看环境变量，再看文件。 */
function resolveToken() {
  if (process.env.WORKBUDDY_BRIDGE_TOKEN) return process.env.WORKBUDDY_BRIDGE_TOKEN.trim()
  for (const p of tokenCandidates()) {
    try {
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf8').trim()
        if (t) return t
      }
    } catch {
      /* 读失败继续 */
    }
  }
  // 递归找（最多 4 层）
  const roots = [
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'workbuddy-to-dsh'),
    join(homedir(), '.workbuddy'),
  ]
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 4) return null
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'bridge-token') {
          const t = readFileSync(join(dir, e.name), 'utf8').trim()
          if (t) return t
        }
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          const found = walk(join(dir, e.name), depth + 1)
          if (found) return found
        }
      }
    } catch {
      /* 忽略不可读目录 */
    }
    return null
  }
  for (const r of roots) {
    const t = walk(r, 0)
    if (t) return t
  }
  return null
}

const token = resolveToken()

/** 尝试多个可能的模型端点。 */
//
// **关键（2026-11-13 实测）**：
// - `/v1/models` 只返回 **3 个**（桥按 dsh 侧 modelAllow / 可见性过滤过的对外路由）
// - `/v1/models?all=1` 返回 **59 个**（完整目录，含 context_window / max_output /
//   reasoning_efforts / credits 等全部字段）
//
// 所以必须带 `?all=1`。这是 plugin 面板与 `workbuddy_models` 工具看到的那份。
const ENDPOINTS = ['/v1/models?all=1', '/v1/models', '/models']

/** @param {string} path */
async function tryFetch(path) {
  const url = `http://${HOST}:${PORT}${path}`
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  return { status: res.status, url, text }
}

let payload = null
let usedUrl = ''
let lastError = ''
/** 记录每个端点的条数，便于诊断「为什么只有 3 个」。 */
/** @type {string[]} */
const probed = []

for (const ep of ENDPOINTS) {
  try {
    const r = await tryFetch(ep)
    if (r.status === 200) {
      const parsed = JSON.parse(r.text)
      const list = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.models ?? []
      probed.push(`${r.url} → ${list.length} 个`)
      // 取条数最多的那个端点（`?all=1` 应当是 59）
      if (!payload || list.length > (Array.isArray(payload) ? payload.length : (payload.data ?? payload.models ?? []).length)) {
        payload = parsed
        usedUrl = r.url
      }
    } else {
      probed.push(`${r.url} → HTTP ${r.status}`)
      lastError = `${r.url} → HTTP ${r.status}：${r.text.slice(0, 200)}`
    }
  } catch (error) {
    probed.push(`${ep} → 异常`)
    lastError = `${ep} 失败：${error?.message ?? error}`
  }
}

if (!payload) {
  console.error(`\n❌ 无法从桥获取模型目录`)
  console.error(`   令牌：${token ? `已找到（${token.length} 字符）` : '未找到（这通常是 401 的原因）'}`)
  console.error(`   最后错误：${lastError}`)
  process.exit(1)
}

// 兼容 OpenAI 形状（data[]）与自定义形状（models[]）
const list = Array.isArray(payload) ? payload : payload.data ?? payload.models ?? []

console.log(`\n=== WorkBuddy 桥模型目录（${usedUrl}）===`)
console.log(`共 ${list.length} 个\n`)

/** 提取上下文窗口（多种命名）。 */
function ctxOf(/** @type {any} */ m) {
  const n = Number(
    m?.contextWindow ?? m?.context_window ?? m?.maxInputTokens ?? m?.max_input_tokens ?? NaN,
  )
  return Number.isFinite(n) && n > 0 ? n : null
}

let withCtx = 0
for (const m of list) {
  const id = String(m?.id ?? m?.model ?? '')
  if (!id) continue
  const ctx = ctxOf(m)
  if (ctx) withCtx += 1
  const name = String(m?.name ?? m?.displayName ?? '')
  console.log(`  ${id.padEnd(28)} ${String(name).padEnd(26)} ${ctx ? `${(ctx / 1000).toFixed(0)}K` : '-'}`)
}

console.log(`\n有上下文窗口：${withCtx}/${list.length}`)

console.log('\n=== JSON（供 capabilities.js 复用）===')
console.log(
  JSON.stringify(
    {
      ok: true,
      source: 'workbuddy-bridge',
      endpoint: usedUrl,
      count: list.length,
      models: list
        .map((/** @type {any} */ m) => ({
          id: String(m?.id ?? m?.model ?? ''),
          label: String(m?.name ?? m?.displayName ?? m?.id ?? ''),
          contextWindow: ctxOf(m),
        }))
        .filter((/** @type {any} */ m) => m.id),
    },
    null,
    2,
  ).slice(0, 4000),
)
