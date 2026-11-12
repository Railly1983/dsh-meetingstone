// @ts-check
/**
 * 用**已安装版本**的插件代码，跑一遍 refreshCli 的真实路径。
 *
 * ## 为什么需要这个脚本
 *
 * 用户真机报告「刷新能力一点就红字报错」，我无法通过 GUI 验证
 * （Gateway 需要鉴权，外部拿不到 token）。所以退一步：
 *
 * **直接加载 `node_modules/dsh-meetingstone/src/gui/host.js`**（部署产物，
 * 不是源码树），用桩协议 + 真实形状的 ctx，把 refreshCli 真调一遍。
 *
 * 这能覆盖：
 * - 已安装产物里的代码是否正确（不是源码树对、装进去错）
 * - 跨作用域引用是否已修
 * - 返回值是否可 JSON 序列化（gateway 边界的必要条件）
 *
 * 覆盖不了：
 * - 真实 Gateway 的 HTTP 往返
 * - 真实 ctx.llm.listModels() 的实际返回
 * - 浏览器端 React 渲染
 *
 * 用法：node scripts/verify-installed-refresh.mjs
 */

import { Module, createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const requireCjs = createRequire(import.meta.url)

/** 已安装路径（部署产物）。 */
const INSTALLED = 'C:/Users/30673/.dsh/profiles/desktop/node_modules/dsh-meetingstone'

if (!existsSync(INSTALLED)) {
  console.error(`❌ 未找到已安装版本：${INSTALLED}`)
  process.exit(1)
}

// ── 桩掉 Typert 协议（它只在宿主 app.asar 里）──────────────
class RemoteError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
  }
}
class TypertRemoteService {}
function Remote() {
  return function decorator(_v, context) {
    if (context && typeof context.addInitializer === 'function') {
      context.addInitializer(function () {})
    }
  }
}
const protocolStub = { TypertRemoteService, Remote, RemoteError }

const checks = []
const record = (name, pass, detail) => checks.push({ name, pass, detail })

/**
 * 在一个「桩已生效」的同步窗口里加载 host.js。
 *
 * 关键：`Module._load` 补丁必须**在 import 期间**生效，且 import 完立即恢复。
 * 与 `tests/host-remote-impl.test.mjs` 里 `makeInstance()` 的做法一致。
 */
async function loadHostWithStub() {
  const restore = installProtocolStub()
  try {
    const url = pathToFileURL(join(INSTALLED, 'src/gui/host.js')).href
    return await import(url + '?t=' + Math.random())
  } finally {
    restore()
  }
}

// 把桩的安装/恢复抽成函数（原来内联在顶部，import 时桩已失效）
function installProtocolStub() {
  const original = Module._load
  // @ts-expect-error 运行时打补丁
  Module._load = function patched(request, parent, isMain) {
    if (request === '@deepseek-ai/dsh-typert-protocol') return protocolStub
    return original.call(this, request, parent, isMain)
  }
  return () => {
    // @ts-expect-error 还原
    Module._load = original
  }
}

const hostModule = await loadHostWithStub()

record(
  '已安装 host.js 可加载',
  typeof hostModule.registerGuiRemote === 'function',
  typeof hostModule.registerGuiRemote === 'function' ? '有 registerGuiRemote' : '缺导出',
)

// ── 造真实形状的 deps ─────────────────────────────────────
/** @type {Array<{cli: string, opts: any}>} */
const refreshCalls = []

const capabilityCatalog = {
  async refresh(cli, opts) {
    refreshCalls.push({ cli, opts })
    return { ok: true, refreshed: [cli ?? 'all'], refreshedAt: Date.now(), errors: [] }
  },
  snapshot() {
    return {
      capabilities: [
        {
          id: 'dsh',
          label: 'DeepSeek Harness',
          provider: 'spawn',
          models: [
            {
              id: 'deepseek-v4.1-flash',
              label: 'deepseek-v4.1-flash',
              provider: 'workbuddy',
              source: 'discovered',
            },
          ],
          strengths: [{ id: 'high', label: 'high', source: 'discovered' }],
          sources: { models: 'discovered', strengths: 'discovered' },
          refreshedAt: Date.now(),
          errors: [],
        },
        {
          id: 'codex',
          label: 'Codex',
          provider: 'codex',
          models: [{ id: 'gpt-6-astra', label: 'gpt-6-astra', provider: 'codex', source: 'config' }],
          strengths: [],
          sources: { models: 'config', strengths: 'unknown' },
          refreshedAt: null,
          errors: [],
        },
      ],
      refreshedAt: Date.now(),
      errors: [],
    }
  },
}

const configApi = {
  async preflightCli(cli) {
    return { ok: true, cli, preflight: { installed: true, version: '1.0.0', path: `C:/${cli}.exe` } }
  },
  getCliPreference() {
    return { ok: true, preference: 'enabled' }
  },
  async setCliEnabled(cli, enabled) {
    return { ok: true, cli, enabled }
  },
  async updateGlobalRole(roleId, patch) {
    return { ok: true, roleId, patch }
  },
  async createGlobalRole(role) {
    return { ok: true, role }
  },
  async deleteGlobalRole(roleId) {
    return { ok: true, roleId }
  },
}

/** 造一个可注册的假 ctx。 */
function makeCtx() {
  return {
    typert: { register: (spec) => spec },
    effect: () => {},
    get: () => null,
    logger: { info() {}, warn() {}, error() {} },
  }
}

const deps = {
  snapshot: async () => ({ roles: [], channels: [], lastError: null, global: {} }),
  configApi,
  capabilities: capabilityCatalog,
}

const outcome = hostModule.registerGuiRemote(makeCtx(), deps)
record(
  'registerGuiRemote 注册成功',
  outcome.registered === true,
  `registered=${outcome.registered}${outcome.reason ? ` reason=${outcome.reason}` : ''}`,
)

const instance = outcome.instance ?? null
record('拿到 remote 实例', Boolean(instance), instance ? '有实例' : '无实例（无法继续验证）')

if (instance) {
  // ── 核心：真调 refreshCli（用户红字报错的位置）────────────
  let refreshError = null
  let refreshResult = null
  try {
    refreshResult = await instance.refreshCli('codex', true)
  } catch (error) {
    refreshError = error
  }

  if (refreshError) {
    const message = String(refreshError?.message ?? refreshError)
    record(
      'refreshCli 不抛 ReferenceError',
      !/is not defined/.test(message),
      /is not defined/.test(message)
        ? `❌ 仍是 ReferenceError 形态（宿主会包成红字）：${message}`
        : `抛了已知错误：${message}`,
    )
  } else {
    record('refreshCli 不抛 ReferenceError', true, '正常返回，无异常')
    record(
      'refreshCli 返回 ok:true',
      refreshResult?.ok === true,
      `ok=${refreshResult?.ok}`,
    )
    record(
      'refreshCli 返回 capabilities 数组',
      Array.isArray(refreshResult?.capabilities),
      Array.isArray(refreshResult?.capabilities)
        ? `${refreshResult.capabilities.length} 项`
        : '不是数组',
    )
    record(
      'refreshCli 返回值可 JSON 无损往返',
      JSON.stringify(JSON.parse(JSON.stringify(refreshResult))) === JSON.stringify(refreshResult),
      'gateway 用 JSON 传输，必须可序列化',
    )
    record(
      'refreshCli 真的调了 capabilityCatalog.refresh',
      refreshCalls.length === 1,
      `调用 ${refreshCalls.length} 次`,
    )
  }

  // ── dsh 路径（内置通道，不回 CLI 状态）───────────────────
  refreshCalls.length = 0
  try {
    const dshResult = await instance.refreshCli('dsh', true)
    record('refreshCli("dsh") 正常', dshResult?.ok === true, `ok=${dshResult?.ok}, cli=${JSON.stringify(dshResult?.cli)}`)
    record(
      'refreshCli("dsh") 不回 CLI 状态（内置通道）',
      dshResult?.cli === null,
      `cli=${JSON.stringify(dshResult?.cli)}`,
    )
  } catch (error) {
    record('refreshCli("dsh") 正常', false, `抛错：${error?.message ?? error}`)
  }

  // ── 其余方法全量调一遍 ──────────────────────────────────
  const calls = [
    ['list', []],
    ['setCliEnabled', ['codex', true]],
    ['updateGlobalRole', ['role-x', { name: 'n' }]],
    ['createGlobalRole', [{ roleId: 'role-x', name: 'n' }]],
    ['deleteGlobalRole', ['role-x']],
  ]
  let allOk = true
  const details = []
  for (const [name, args] of calls) {
    const fn = instance[name]
    if (typeof fn !== 'function') {
      allOk = false
      details.push(`${name}:缺失`)
      continue
    }
    try {
      const result = await fn.apply(instance, args)
      const serializable = JSON.stringify(result) !== undefined
      if (!serializable) {
        allOk = false
        details.push(`${name}:不可序列化`)
      } else {
        details.push(`${name}:ok`)
      }
    } catch (error) {
      allOk = false
      details.push(`${name}:抛错(${String(error?.message ?? error).slice(0, 30)})`)
    }
  }
  record('其余 5 个 remote 方法全部可调用且可序列化', allOk, details.join(' | '))
}

// ── 输出 ─────────────────────────────────────────────────
const pass = checks.filter((c) => c.pass).length
const fail = checks.length - pass

console.log('\n=== 已安装版本 refreshCli 真机路径验证 ===\n')
console.log(`路径: ${INSTALLED}\n`)
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'}  ${c.name}`)
  console.log(`    ${c.detail}`)
}
console.log(`\n结果：${pass} PASS / ${fail} FAIL / ${checks.length} 项`)
console.log('\n覆盖不到：真实 Gateway HTTP 往返、真实 ctx.llm.listModels 返回、浏览器渲染。')
process.exit(fail === 0 ? 0 : 1)
