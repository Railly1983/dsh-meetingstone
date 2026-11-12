/**
 * 直接探测 codex 的 app-server model/list。
 *
 * ## 背景
 *
 * 我之前报告的「codex 只有 2 个模型」很可能不对 —— 那 2 个
 * （gpt-6-astra / gpt-6.1-sol）看起来像**静态表**而不是探测结果。
 *
 * 本脚本直接起 `codex app-server`，走 JSON-RPC 问 `model/list`，
 * 看真实返回什么。
 *
 * 用法：node scripts/probe-codex-models.mjs
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const CODEX = process.env.CODEX_BIN || 'C:/Users/30673/.codex/.sandbox-bin/codex.exe'
const TIMEOUT = 30_000

const child = spawn(CODEX, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

/** @type {Map<number, (m: any) => void>} */
const pending = new Map()
/** @type {any[]} */
const notices = []
/** @type {string[]} */
const stderrLines = []

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
    notices.push(msg)
  }
})

const errRl = createInterface({ input: child.stderr })
errRl.on('line', (l) => {
  stderrLines.push(l)
  if (stderrLines.length > 40) stderrLines.shift()
})

/** @param {any} m */
function send(m) {
  child.stdin.write(JSON.stringify(m) + '\n')
}

/**
 * @param {number} id
 * @param {string} method
 * @param {any} params
 */
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时（${TIMEOUT}ms）`))
    }, TIMEOUT)
    pending.set(id, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

try {
  // 1) initialize
  const init = await request(1, 'initialize', {
    clientInfo: { name: 'meetingstone-probe', version: '0.1.0' },
    capabilities: {},
  })
  console.log('=== initialize ===')
  console.log(JSON.stringify(init.result ?? init.error).slice(0, 500))
  console.log('')

  // 2) initialized 通知
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })

  // 3) model/list
  const list = await request(2, 'model/list', {})
  console.log('=== model/list 原始响应 ===')
  const text = JSON.stringify(list, null, 2)
  console.log(text.slice(0, 3000))
  console.log('')

  if (list.error) {
    console.log('❌ model/list 返回错误：' + JSON.stringify(list.error))
  } else {
    const result = list.result ?? {}
    // **实测**：codex app-server 的模型在 result.data（不是 result.models）
    const arr = Array.isArray(result) ? result : result.data ?? result.models ?? []
    console.log(`模型数：${Array.isArray(arr) ? arr.length : '?'}`)
    if (Array.isArray(arr)) {
      console.log('')
      for (const m of arr) {
        const id = m.id ?? m.model ?? '?'
        const name = m.displayName ?? m.name ?? ''
        // 上下文窗口字段（codex 可能用多种命名）
        const ctx =
          m.contextWindow ?? m.context_window ?? m.maxInputTokens ?? m.max_input_tokens ?? null
        const efforts = Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts.map((e) => e.reasoningEffort ?? e).join('/')
          : ''
        console.log(
          `  • ${String(id).padEnd(22)} ${String(name).padEnd(20)} ctx=${ctx ?? '-'}  efforts=${efforts}`,
        )
      }
    }
    console.log('')
    console.log('result 的键：' + Object.keys(result).join(', '))
  }
} catch (error) {
  console.error(`\n❌ 失败：${error?.message ?? error}`)
  if (stderrLines.length) {
    console.error('\nstderr 末 10 行：')
    console.error(stderrLines.slice(-10).join('\n'))
  }
} finally {
  try {
    child.stdin.end()
  } catch {}
  try {
    child.kill()
  } catch {}
}
