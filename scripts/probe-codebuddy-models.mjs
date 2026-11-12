/**
 * 探测 CodeBuddy 模型列表：走 ACP 的 session/new。
 *
 * ## 依据（都有出处）
 *
 * 1. **ACP 规范**（agentclientprotocol.com/protocol）：
 *    `session/new` 的 response 含
 *      models: SessionModelState | null
 *      models.availableModels: List of available model objects
 *      models.currentModelId: string
 *
 * 2. **社区实测**（farm-out/docs/observed-behaviour.md，2026-09-23）：
 *    > "The model list comes with the session. session/new returns the available
 *    >  model ids and a set of config options (model, thought_level, and
 *    >  context_window for some models). No inference is needed to read them,
 *    >  which is what probe, models and doctor use."
 *    >
 *    > "thought_level values differ per model. glm-5.3-flash offered
 *    >  low, high, max, enabled."
 *    >
 *    > "context_window exists only for some models. glm-5.3-flash,
 *    >  deepseek-v4.1-flash and hy4-preview-f offered 300000 and 1000000."
 *
 * 3. **本地实测**：
 *    - `codebuddy-headless.js` 里 `availableModels` 65 处、`getModelsInfo` 12 处、
 *      `session/new` 10 处
 *    - DSH 派单用的启动命令是
 *      `node <pkg>/bin/codebuddy --acp`（不是 lib/node/index.js）
 *      —— 必须用这个入口，用 lib/node/index.js 会因 ESM 少 .js 后缀而崩
 *    - `initialize` 能正常返回（已实测）
 *
 * ## 输出
 *
 * JSON，可直接被 `src/cli/capabilities.js` 的 codebuddy probe 复用。
 *
 * 用法：node scripts/probe-codebuddy-models.mjs
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const CODEBUDDY_ENTRY =
  process.env.CODEBUDDY_ENTRY ||
  'C:/Users/30673/AppData/Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'

/** 单个请求的超时。initialize 可能需要几秒（进程冷启动）。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 整体超时（兜底，避免挂住）。 */
const TOTAL_TIMEOUT_MS = 120_000

/**
 * 启动 ACP 子进程，完成 initialize + session/new，提取模型与配置项。
 */
async function probe() {
  const child = spawn(process.execPath, [CODEBUDDY_ENTRY, '--acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 社区实测：继承 SERVER__PORT / SERVER__HOST 会让 CLI 卡住
      // （Shells spawned by the desktop app carry these variables）
      SERVER__PORT: '',
      SERVER__HOST: '',
    },
  })

  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map()
  let nextId = 1
  /** @type {string[]} */
  const stderrLines = []

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return // 非 JSON 行（日志噪音）忽略
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  const errRl = createInterface({ input: child.stderr })
  errRl.on('line', (line) => {
    stderrLines.push(line)
    if (stderrLines.length > 60) stderrLines.shift()
  })

  function request(method, params) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new Error(
            `${method} 超时（${REQUEST_TIMEOUT_MS}ms）` +
              (stderrLines.length ? `\nstderr 末 5 行：\n${stderrLines.slice(-5).join('\n')}` : ''),
          ),
        )
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'meetingstone-probe', version: '0.1.0' },
    })
    if (init.error) throw new Error(`initialize 失败：${JSON.stringify(init.error)}`)

    const session = await request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    if (session.error) throw new Error(`session/new 失败：${JSON.stringify(session.error)}`)

    const result = session.result ?? {}
    return {
      agentCapabilities: init.result?.agentCapabilities ?? null,
      models: Array.isArray(result.models?.availableModels) ? result.models.availableModels : [],
      currentModelId: result.models?.currentModelId ?? null,
      configOptions: Array.isArray(result.configOptions) ? result.configOptions : [],
      rawResultKeys: Object.keys(result),
      raw: result,
      stderr: stderrLines.slice(-10),
    }
  } finally {
    try {
      child.stdin.end()
    } catch {}
    try {
      child.kill()
    } catch {}
  }
}

const timer = setTimeout(() => {
  console.error(`❌ 整体超时（${TOTAL_TIMEOUT_MS}ms）`)
  process.exit(3)
}, TOTAL_TIMEOUT_MS)
timer.unref?.()

const started = Date.now()
try {
  const out = await probe()
  clearTimeout(timer)
  const elapsed = Date.now() - started

  console.log(`\n=== CodeBuddy ACP 模型探测（${elapsed}ms）===\n`)

  if (out.models.length === 0) {
    console.log('⚠️  session/new 没有返回 availableModels')
    console.log('响应里的键：' + out.rawResultKeys.join(', ') || '(空)')
    console.log('\n完整 result（前 3000 字符）：')
    console.log(JSON.stringify(out.raw, null, 2).slice(0, 3000))
    if (out.stderr.length) {
      console.log('\nstderr 末 10 行：')
      console.log(out.stderr.join('\n'))
    }
    process.exit(2)
  }

  console.log(`✅ 拿到 ${out.models.length} 个模型（当前：${out.currentModelId ?? '未知'}）\n`)
  for (const m of out.models) {
    const id = m.id ?? m.name ?? '(无 id)'
    const name = m.name ?? m.id ?? ''
    const desc = m.description ? `\n      ${String(m.description).slice(0, 120)}` : ''
    console.log(`  • ${id}${name && name !== id ? `  (${name})` : ''}${desc}`)
  }

  if (out.configOptions.length > 0) {
    console.log(`\n=== configOptions（${out.configOptions.length} 项）===`)
    for (const opt of out.configOptions) {
      console.log(`  • ${opt.id ?? opt.name}`)
      if (opt.name) console.log(`      名称: ${opt.name}`)
      if (Array.isArray(opt.options)) {
        console.log(`      可选: ${opt.options.map((o) => o.value ?? o.id).join(', ')}`)
      }
      if (Array.isArray(opt.values)) {
        console.log(`      可选: ${opt.values.join(', ')}`)
      }
    }
  }

  console.log('\n=== JSON（供 capabilities.js probe 复用）===')
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: 'acp-session-new',
        currentModelId: out.currentModelId,
        models: out.models.map((m) => ({
          id: m.id ?? m.name,
          label: m.name ?? m.id,
          description: m.description ?? null,
        })),
        configOptions: out.configOptions.map((o) => ({
          id: o.id ?? o.name,
          options: (o.options ?? []).map((x) => x.value ?? x.id),
        })),
      },
      null,
      2,
    ),
  )
} catch (error) {
  clearTimeout(timer)
  console.error(`\n❌ 探测失败：${error?.message ?? error}`)
  process.exit(1)
}
