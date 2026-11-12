// @ts-check
/**
 * 验证**已安装版本**的 refreshCli（悟空方法的产品化版本）。
 *
 * ## 这个脚本解决什么问题
 *
 * 用户报「刷新能力一点就红字报错」，而我之前的所有验证都在**渲染层**，
 * 从来没执行过 refreshCli 的函数体。缺陷是跨作用域引用，只有真调用才暴露。
 *
 * ## 方法（比纯桩更强）
 *
 * 1. 用 **Node 24 的 `require(esm)`** 直接加载**已安装的** `host.js`
 *    —— 不是源码树，是运行中 DSH 实际加载的那一份
 * 2. 从宿主 `app.asar` 解包**真实** `@deepseek-ai/dsh-typert-protocol`
 *    —— 真实的 `Remote` 装饰器、真实的 `RemoteError`
 * 3. 仅把 `TypertRemoteService` 的 Cordis `Service` 基类换成最小桩
 *    （真实基类 `new Service` 要读 `ctx.provide`，脱离宿主进程无法实例化）
 * 4. 真正调用 `refreshCli`，检查是否抛 ReferenceError 形态的错误
 * 5. **负对照**：合成一份「修复前」的 host.js，确认它**会**抛
 *    `ReferenceError: capabilityCatalog is not defined`
 *    —— 证明本脚本能抓到原缺陷，前面的「不抛错」不是假阴性
 *
 * ## 边界（诚实声明）
 *
 * - 执行发生在**独立 Node 24 进程**，不是运行中的 DSH 宿主内部
 * - 没有经 Gateway 的 WS RPC，也没点 GUI 按钮
 * - 所以「真机」= 同机 + 同份已安装代码 + 同份宿主协议，但不是 live 进程内调用
 *
 * 用法（必须用 Node 24）：
 *   node scripts/verify-installed-refreshcli.mjs
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const requireCjs = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))

const INSTALLED_PKG = 'C:/Users/30673/.dsh/profiles/desktop/node_modules/dsh-meetingstone'
const INSTALLED_HOST = join(INSTALLED_PKG, 'src/gui/host.js')
const ASAR = 'C:/Users/30673/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const WORK = join(HERE, '..', '.meetingstone', 'runs', 'verify-installed-refresh')

const checks = []
const record = (name, pass, detail) => checks.push({ name, pass, detail })

// ── 前置检查 ─────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0])
record(
  `Node 版本 ≥ 22（当前 ${process.version}）`,
  nodeMajor >= 22,
  nodeMajor >= 22 ? '支持 require(esm)' : '需要 Node 22+ 才能 require 已安装的 ESM host.js',
)

if (!existsSync(INSTALLED_HOST)) {
  record('已安装 host.js 存在', false, INSTALLED_HOST)
  report()
}
record('已安装 host.js 存在', true, INSTALLED_HOST)

const installedVersion = JSON.parse(
  readFileSync(join(INSTALLED_PKG, 'package.json'), 'utf8'),
).version

// ── 从 app.asar 解包真实协议（只读）────────────────────
/**
 * 极简 asar 读取：头部 12 字节 + 16 字节 JSON 头 + 文件内容。
 * @param {string} asarPath
 * @param {(name: string) => boolean} match
 * @returns {Map<string, Buffer>}
 */
function readAsarFiles(asarPath, match) {
  const buf = readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
  const base = 16 + headerSize
  /** @type {Map<string, Buffer>} */
  const out = new Map()

  /** @param {any} node @param {string} prefix */
  function walk(node, prefix) {
    for (const [key, value] of Object.entries(node.files ?? {})) {
      const full = `${prefix}/${key}`
      if (value.files) walk(value, full)
      else if (match(full)) {
        const { offset, size } = /** @type {any} */ (value)
        out.set(full, buf.subarray(base + Number(offset), base + Number(offset) + Number(size)))
      }
    }
  }
  walk(header, '')
  return out
}

/** 解包真实协议到临时目录，返回它的入口路径。 */
function extractRealProtocol() {
  mkdirSync(WORK, { recursive: true })
  const vendorRoot = join(WORK, 'vendor')
  // 每次重解，避免残留
  rmSync(vendorRoot, { recursive: true, force: true })
  mkdirSync(vendorRoot, { recursive: true })

  const PREFIX = 'dsh/node_modules/@deepseek-ai/dsh-typert-protocol/'
  const files = readAsarFiles(
    ASAR,
    (name) => name.startsWith(`/${PREFIX}`) || name.startsWith(`/${PREFIX}node_modules/`),
  )
  if (files.size === 0) return null

  for (const [name, content] of files) {
    const rel = name.slice(1 + PREFIX.length)
    const target = join(vendorRoot, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  // 入口看 package.json 的 main（实测是 lib/index.js，不是根 index.js）
  let entry = join(vendorRoot, 'index.js')
  const pkgPath = join(vendorRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (typeof pkg.main === 'string' && pkg.main) entry = join(vendorRoot, pkg.main)
    } catch {
      /* 用默认入口 */
    }
  }
  return existsSync(entry) ? entry : null
}

let realProtocolPath = null
try {
  realProtocolPath = extractRealProtocol()
  record(
    '从 app.asar 解包真实 Typert 协议',
    Boolean(realProtocolPath),
    realProtocolPath ? `入口：${realProtocolPath}` : '未找到（回退到桩）',
  )
} catch (error) {
  record('从 app.asar 解包真实 Typert 协议', false, `失败：${error?.message ?? error}`)
}

// ── 构造协议替身（真实优先，仅基类兜底）────────────────
let protocolMode = 'stub-only'
let protocol = null

if (realProtocolPath) {
  try {
    const real = requireCjs(realProtocolPath)
    // Cordis 的 Service 基类脱离宿主进程无法实例化（new Service 要读 ctx.provide），
    // 用一个最小替身；Remote 装饰器与 RemoteError 都用**真实的**。
    class MinimalService {
      constructor() {}
    }
    protocol = {
      ...real,
      TypertRemoteService: class TypertRemoteService extends MinimalService {},
    }
    protocolMode = 'real(app.asar)+stub-base'
  } catch (error) {
    record('加载真实协议', false, `失败：${error?.message ?? error}`)
  }
}

if (!protocol) {
  // 兜底：全桩（能力弱于真实协议，但足以检测跨作用域引用）
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
  protocol = { TypertRemoteService, Remote, RemoteError }
  protocolMode = 'stub-only'
}

record('协议模式', true, protocolMode)

// ── 补丁 Module._load，让 host.js 的 require 拿到替身 ────
const originalLoad = requireCjs('node:module')._load
// @ts-expect-error 运行时打补丁
requireCjs('node:module')._load = function patched(request, parent, isMain) {
  if (request === '@deepseek-ai/dsh-typert-protocol') return protocol
  return originalLoad.call(this, request, parent, isMain)
}

/** 造一套最小 deps。 */
function makeDeps({ omitCapabilities = false } = {}) {
  /** @type {any[]} */
  const refreshCalls = []
  const capabilities = {
    async refresh(cli, opts) {
      refreshCalls.push({ cli, opts })
      return { ok: true, refreshed: [cli ?? 'all'], refreshedAt: 1, errors: [] }
    },
    snapshot() {
      return {
        capabilities: [
          { id: 'dsh', label: 'DSH', models: [{ id: 'm1', label: 'm1', source: 'discovered' }],
            strengths: [], sources: { models: 'discovered', strengths: 'unknown' }, refreshedAt: 1, errors: [] },
        ],
        refreshedAt: 1,
        errors: [],
      }
    },
  }
  const configApi = {
    preflightCli: async (cli) => ({ ok: true, preflight: { installed: true } }),
    getCliPreference: () => ({ ok: true, preference: 'enabled' }),
    setCliEnabled: async () => ({ ok: true }),
    updateGlobalRole: async () => ({ ok: true }),
    createGlobalRole: async () => ({ ok: true }),
    deleteGlobalRole: async () => ({ ok: true }),
  }
  return {
    refreshCalls,
    deps: {
      snapshot: async () => ({ roles: [], channels: [], lastError: null, global: {} }),
      configApi,
      ...(omitCapabilities ? {} : { capabilities }),
    },
  }
}

/** 加载 host.js 并注册 remote。 */
function loadAndRegister(hostPath, deps) {
  // 每次换 query 无效（CJS），用 delete cache 确保重新加载
  delete requireCjs.cache[requireCjs.resolve(hostPath)]
  const host = requireCjs(hostPath)
  const outcome = host.registerGuiRemote(
    {
      typert: { register: (spec) => spec },
      effect: () => {},
      get: () => null,
      logger: { info() {}, warn() {}, error() {} },
    },
    deps,
  )
  return { host, outcome }
}

// ── 主验证：已安装版本 ───────────────────────────────────
let mainOutcome = null
try {
  const { deps } = makeDeps()
  const { outcome } = loadAndRegister(INSTALLED_HOST, deps)
  mainOutcome = outcome

  record(
    'registerGuiRemote 注册成功',
    outcome.registered === true && Boolean(outcome.instance),
    `registered=${outcome.registered} reason=${outcome.reason ?? '-'} hasInstance=${Boolean(outcome.instance)}`,
  )

  if (outcome.instance) {
    let threw = false
    let error = null
    let result = null
    try {
      result = await outcome.instance.refreshCli('dsh', true)
    } catch (e) {
      threw = true
      error = e
    }

    const message = String(error?.message ?? '')
    record(
      'refreshCli 不抛 ReferenceError（用户报的红字）',
      !/is not defined/.test(message),
      threw ? `抛错：${message}` : '正常返回',
    )
    if (!threw) {
      record('refreshCli 返回 ok:true', result?.ok === true, `ok=${result?.ok}`)
      record(
        'refreshCli 返回 capabilities 数组',
        Array.isArray(result?.capabilities),
        Array.isArray(result?.capabilities) ? `${result.capabilities.length} 项` : '不是数组',
      )
      let serializable = true
      try {
        JSON.parse(JSON.stringify(result))
      } catch {
        serializable = false
      }
      record('refreshCli 返回值可 JSON 无损往返', serializable, 'gateway 用 JSON 传输')
    }
  }
} catch (error) {
  record('加载已安装 host.js', false, `抛错：${error?.message ?? error}`)
}

// ── 负对照 1：不传 capabilities ─────────────────────────
try {
  const { deps } = makeDeps({ omitCapabilities: true })
  const { outcome } = loadAndRegister(INSTALLED_HOST, deps)
  if (outcome.instance) {
    let error = null
    try {
      await outcome.instance.refreshCli('dsh', true)
    } catch (e) {
      error = e
    }
    const message = String(error?.message ?? '')
    record(
      '负对照·缺 capabilities → 抛结构化 RemoteError 而非 ReferenceError',
      Boolean(error) && !/is not defined/.test(message),
      error ? `${error.code ?? '(无 code)'}: ${message}` : '没抛错（应抛）',
    )
  }
} catch (error) {
  record('负对照·缺 capabilities', false, `准备失败：${error?.message ?? error}`)
}

// ── 负对照 2：合成「修复前」的 host.js，确认脚本能抓到原缺陷 ──
try {
  const syntheticDir = join(WORK, 'synthetic')
  rmSync(syntheticDir, { recursive: true, force: true })
  mkdirSync(syntheticDir, { recursive: true })
  // 复制已安装包，然后删掉 deps.capabilities 的取值（复刻修复前的形态）
  const source = readFileSync(INSTALLED_HOST, 'utf8')
  const broken = source.replace(
    /const capabilityCatalog =\s*deps\.capabilities && typeof deps\.capabilities\.refresh === 'function'\s*\?\s*deps\.capabilities\s*:\s*null/,
    'const capabilityCatalog = undefinedVariableForNegativeControl',
  )
  const brokeApplied = broken !== source
  if (brokeApplied) {
    // 只写一个单文件是不行的（host.js 依赖同目录其他模块），
    // 所以复制整个 src 目录
    const { cpSync } = await import('node:fs')
    cpSync(join(INSTALLED_PKG, 'src'), join(syntheticDir, 'src'), { recursive: true })
    writeFileSync(join(syntheticDir, 'src/gui/host.js'), broken, 'utf8')
    writeFileSync(
      join(syntheticDir, 'package.json'),
      readFileSync(join(INSTALLED_PKG, 'package.json')),
    )

    const { deps } = makeDeps()
    const { outcome } = loadAndRegister(join(syntheticDir, 'src/gui/host.js'), deps)
    let caught = false
    if (outcome.instance) {
      try {
        await outcome.instance.refreshCli('dsh', true)
      } catch (error) {
        caught = /is not defined/.test(String(error?.message ?? ''))
      }
    } else {
      // 注册阶段就崩了也算抓到
      caught = /is not defined/.test(String(outcome.error ?? ''))
    }
    record(
      '负对照·合成「修复前」版本 → 脚本确实能抓到原缺陷',
      caught,
      caught
        ? '✅ 抓到了 ReferenceError 形态的错误，证明主验证不是假阴性'
        : '❌ 没抓到 —— 说明本脚本无法检出该缺陷，主验证的「通过」不可信',
    )
  } else {
    record('负对照·合成「修复前」版本', false, '正则没匹配到目标代码，无法构造负对照')
  }
} catch (error) {
  record('负对照·合成「修复前」版本', false, `失败：${error?.message ?? error}`)
}

// 恢复 Module._load
// @ts-expect-error 还原
requireCjs('node:module')._load = originalLoad

/** 输出结果并退出。 */
function report() {
  const pass = checks.filter((c) => c.pass).length
  const fail = checks.length - pass
  console.log('\n=== 已安装版本 refreshCli 验证（悟空方法）===\n')
  console.log(`已安装版本：${existsSync(join(INSTALLED_PKG, 'package.json')) ? installedVersion : '?'}`)
  console.log(`协议模式：${protocolMode}`)
  console.log('')
  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'}  ${c.name}`)
    console.log(`    ${c.detail}`)
  }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL / ${checks.length} 项`)
  console.log('\n边界：独立 Node 进程执行，未经 Gateway WS RPC，未点 GUI 按钮。')
  process.exit(fail === 0 ? 0 : 1)
}

report()
