/**
 * 逐个模型探测 context_window。
 *
 * ## 思路
 *
 * 用户问「上下文长度在哪里设置」。社区实测说 CodeBuddy 的 ACP
 * `configOptions` 里**部分模型**有 `context_window`（glm-5.3-flash /
 * deepseek-v4.1-flash / hy4-preview-f 给 300000 与 1000000）。
 *
 * 但我之前只测了默认模型（hy4free），它没有。
 *
 * 所以：**能不能切换模型后重新读 configOptions，把每个模型的
 * context_window 都查出来？**
 *
 * ACP 有 `session/set_config_option`（按模型切）。切完再发一次
 * 让服务端回吐 configOptions 的请求（session/new 太重，试试看有没有
 * 轻量的方式）。
 *
 * 本脚本：对每个模型 set 一次，然后看有没有新的 configOptions 回来。
 *
 * 用法：node scripts/probe-context-window.mjs
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const CODEBUDDY_ENTRY =
  process.env.CODEBUDDY_ENTRY ||
  'C:/Users/30673/AppData/Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'

const REQ_TIMEOUT = 30_000

const child = spawn(process.execPath, [CODEBUDDY_ENTRY, '--acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SERVER__PORT: '', SERVER__HOST: '' },
})

/** @type {Map<number, (m: any) => void>} */
const pending = new Map()
let nextId = 1
/** @type {any[]} 所有收到的通知（session/update 等） */
const notifications = []

const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const fn = pending.get(msg.id)
    pending.delete(msg.id)
    fn(msg)
  } else if (msg.method) {
    notifications.push(msg)
  }
})

const errRl = createInterface({ input: child.stderr })
/** @type {string[]} */
const stderr = []
errRl.on('line', (l) => {
  stderr.push(l)
  if (stderr.length > 40) stderr.shift()
})

/**
 * @param {string} method
 * @param {any} params
 * @returns {Promise<any>}
 */
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时`))
    }, REQ_TIMEOUT)
    pending.set(id, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

/** 从 configOptions 里抽 context_window。 */
function extractContextWindow(configOptions) {
  if (!Array.isArray(configOptions)) return null
  const opt = configOptions.find((o) => o && o.id === 'context_window')
  if (!opt) return null
  const values = Array.isArray(opt.options)
    ? opt.options.map((o) => Number(o?.value ?? o)).filter((n) => Number.isFinite(n))
    : []
  return {
    values,
    max: values.length > 0 ? Math.max(...values) : null,
    current: opt.currentValue ?? opt.selected ?? null,
  }
}

try {
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'ctx-probe', version: '1' },
  })

  const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
  const result = session.result ?? {}
  const sessionId = result.sessionId
  const models = Array.isArray(result.models?.availableModels) ? result.models.availableModels : []
  const optionList = Array.isArray(result.configOptions) ? result.configOptions : []

  const modelOpt = optionList.find((o) => o && o.id === 'model')
  const wireIds = Array.isArray(modelOpt?.options)
    ? modelOpt.options.map((o) => String(o?.value ?? o ?? '')).filter(Boolean)
    : []

  console.log(`\n=== session/new ===`)
  console.log(`sessionId: ${sessionId}`)
  console.log(`可用模型: ${models.length}`)
  console.log(`初始 context_window: ${JSON.stringify(extractContextWindow(optionList))}`)
  console.log('')

  // 对每个模型试一次
  const results = []
  for (const modelId of wireIds) {
    notifications.length = 0
    let setError = null
    try {
      const setRes = await request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: modelId,
      })
      if (setRes.error) setError = JSON.stringify(setRes.error)
    } catch (error) {
      setError = String(error?.message ?? error)
    }

    // set 之后有没有通知带 configOptions？
    /** @type {any} */
    let found = null
    for (const n of notifications) {
      const params = n.params
      if (!params) continue
      const cw = extractContextWindow(params.configOptions)
      if (cw) {
        found = cw
        break
      }
      // 也可能在 _meta 里
      if (params._meta?.configOptions) {
        const cw2 = extractContextWindow(params._meta.configOptions)
        if (cw2) {
          found = cw2
          break
        }
      }
    }

    results.push({ model: modelId, contextWindow: found, setError })
    console.log(
      `${modelId.padEnd(28)} context_window=${found ? JSON.stringify(found) : '无'}` +
        (setError ? `  ⚠ set 失败: ${setError.slice(0, 60)}` : ''),
    )
  }

  console.log('\n=== 汇总 ===')
  const withCw = results.filter((r) => r.contextWindow)
  console.log(`${withCw.length} / ${results.length} 个模型报告了 context_window`)
  if (withCw.length > 0) {
    console.log('\n有 context_window 的模型：')
    for (const r of withCw) {
      console.log(`  ${r.model}: max=${r.contextWindow.max}  可选=${r.contextWindow.values.join('/')}`)
    }
  }

  console.log('\n=== 通知样本（看有没有别的地方带配置）===')
  const kinds = new Set(notifications.map((n) => n.method))
  console.log([...kinds].join(', ') || '(无通知)')
} catch (error) {
  console.error(`\n❌ 失败：${error?.message ?? error}`)
  if (stderr.length) console.error('stderr:\n' + stderr.slice(-5).join('\n'))
} finally {
  try {
    child.stdin.end()
  } catch {}
  try {
    child.kill()
  } catch {}
}
