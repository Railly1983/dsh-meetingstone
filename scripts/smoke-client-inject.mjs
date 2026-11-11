// @ts-check
/**
 * 真机机制冒烟：用**安装版宿主 app.asar 里的 Cordis 4.1.0** 驱动
 * src/client/index.js，验证「Remote 动态注入」修复，而不是只靠 stub。
 *
 * 复现的两条路径：
 *   A. 旧写法（父 fiber 未声明 `remote.meetingstone`）：`ctx.remote.meetingstone`
 *      必然抛 `cannot get property "remote.meetingstone" without inject`
 *      （cordis/src/reflect.ts:152-178）。
 *   B. 新写法：`ctx.remote.$mount(...)` 后在 `ctx.inject(['remote.meetingstone'], cb)`
 *      里注册 settings.section 并读取服务；cb 只在服务就绪后执行
 *      （cordis/src/registry.ts:300-302、fiber.ts:603-628）。
 *
 * 只读诊断：从 app.asar 抽 cordis/cosmokit 到临时目录，不安装、不改宿主。
 * 用法：node scripts/smoke-client-inject.mjs
 *       DSH_ASAR=<path> node scripts/smoke-client-inject.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const DEFAULT_ASAR =
  'C:/Users/30673/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const asarPath = process.env.DSH_ASAR || DEFAULT_ASAR

let buf
try {
  buf = readFileSync(asarPath)
} catch {
  console.log(`SKIP: 找不到宿主 app.asar：${asarPath}（可设 DSH_ASAR 指定）`)
  process.exit(0)
}

const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const baseOffset = 16 + headerSize

/** @param {string} innerPath */
function extract(innerPath) {
  const parts = innerPath.replace(/\\/g, '/').split('/')
  let node = header
  for (const part of parts) {
    node = node?.files?.[part]
    if (!node) throw new Error(`asar 内不存在：${innerPath}`)
  }
  const start = baseOffset + Number(node.offset)
  return buf.subarray(start, start + Number(node.size))
}

const root = mkdtempSync(join(tmpdir(), 'mt-cordis-'))
const files = [
  ['node_modules/@deepseek-ai/cordis/lib/index.js', 'node_modules/@deepseek-ai/cordis/lib/index.js'],
  ['node_modules/@deepseek-ai/cordis/package.json', 'node_modules/@deepseek-ai/cordis/package.json'],
  ['node_modules/@deepseek-ai/cosmokit/lib/index.js', 'node_modules/@deepseek-ai/cosmokit/lib/index.js'],
  ['node_modules/@deepseek-ai/cosmokit/package.json', 'node_modules/@deepseek-ai/cosmokit/package.json'],
]
for (const [inner, rel] of files) {
  const target = join(root, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, extract(`dsh/${inner}`))
}

const { Context, Service } = await import(
  pathToFileURL(join(root, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href
)

const registrations = []
const injectCalls = []
const unmountCalls = []

class Slots extends Service {
  constructor(ctx) {
    super(ctx, 'slots')
  }
  inject(name, callback) {
    return callback()
  }
  register(options, Component) {
    registrations.push({ options, Component })
    return () => {}
  }
}

class Locale extends Service {
  constructor(ctx) {
    super(ctx, 'locale')
  }
  bind() {
    return (key) => key
  }
  register() {
    return () => {}
  }
}

/** Host 命名空间服务的等价物：`Service` 在子 fiber 里 provide `remote.<ns>`。 */
class Namespace extends Service {
  constructor(ctx) {
    super(ctx, 'remote.meetingstone')
  }
  async list() {
    return {
      ok: true,
      value: {
        roles: [
          {
            roleId: 'role-sashi',
            name: '沙僧',
            aliases: ['SS'],
            enabled: true,
            availability: 'available',
            channelId: 'ch-acp-flash',
            model: 'flash-1',
          },
        ],
        channels: [{ channelId: 'ch-acp-flash', kind: 'acp-cli' }],
        lastError: null,
        global: {
          defaultRoleId: 'role-sashi',
          dispatchNotes: '高难任务优先悟空',
          projectConfigFile: '.meetingstone.json',
          limits: { serializeWrites: true, maxParallelWritesTotal: 4, defaultIsolation: 'worktree' },
          channels: [
            {
              channelId: 'ch-acp-flash',
              description: '',
              kind: 'acp-cli',
              provider: 'acp',
              model: 'flash-1',
              reasoning: 'low',
            },
          ],
          cli: [{ cli: 'codex', label: 'Codex CLI', installed: true, version: '0.167.0', path: 'x', notes: [] }],
          cliError: null,
        },
      },
    }
  }
}

class Remote extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }
  async $mount() {
    const fiber = this.ctx.plugin({
      name: 'remote.meetingstone',
      apply: (ctx) => {
        new Namespace(ctx)
      },
    })
    await fiber
    const unmount = async () => {
      unmountCalls.push(true)
      await fiber.dispose()
    }
    return unmount
  }
}

const fakeReact = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}
const fakeRequire = (name) => {
  if (name === 'react/jsx-runtime') {
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  }
  if (name === 'react') return fakeReact
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tag: function Tag() {} }
  throw new Error(`unexpected module ${name}`)
}

let entry
globalThis.window = { __ModuleLoader__: { load: (value) => (entry = value) } }
const clientURL = pathToFileURL(join(process.cwd(), 'src/client/index.js')).href
await import(`${clientURL}?smoke=${Date.now()}`)
assert.equal(entry?.id, 'dsh-meetingstone', 'client 入口 id 必须是包名')
const client = entry.factory(fakeRequire)

/** 等待 Cordis 子 fiber 完成激活。 */
async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// A. 复现原错误：父 fiber 只声明 remote，直接读 remote.meetingstone 必抛。
{
  const ctx = new Context()
  new Slots(ctx)
  new Locale(ctx)
  new Remote(ctx)
  let error = null
  const fiber = ctx.plugin({
    inject: ['slots', 'locale', 'remote'],
    apply: async (inner) => {
      await inner.remote.$mount()
      try {
        void inner.remote.meetingstone
      } catch (e) {
        error = e
      }
    },
  })
  await fiber
  assert.ok(error, '旧写法必须复现 Cordis 拒绝')
  assert.match(String(error.message), /cannot get property "remote\.meetingstone" without inject/)
  console.log('PASS A: 复现旧错误 cannot get property "remote.meetingstone" without inject')
}

// B. 新写法：真实 apply（模块级 inject 与真实 loader 一致）。
{
  registrations.length = 0
  injectCalls.length = 0
  const ctx = new Context()
  // Cordis 在创建每个 fiber 时发 internal/plugin；借此观察动态注入声明。
  const fiberInjects = []
  ctx.on('internal/plugin', (fiber) => fiberInjects.push(Object.keys(fiber.inject)))
  new Slots(ctx)
  new Locale(ctx)
  new Remote(ctx)
  const fiber = ctx.plugin({ inject: client.inject, apply: client.apply })
  await fiber
  await settle()
  assert.deepEqual(registrations.length, 1, '应注册一个 settings.section')
  assert.ok(
    fiberInjects.some((keys) => keys.includes('remote.meetingstone')),
    '必须存在声明 remote.meetingstone 的动态注入子 fiber',
  )
  const { options, Component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'meetingstone')
  assert.equal(typeof Component, 'function')
  const snapshot = await options.inject().list()
  assert.equal(snapshot.roles[0].name, '沙僧')
  assert.equal(snapshot.global.defaultRoleId, 'role-sashi')
  assert.equal(snapshot.global.cli[0].label, 'Codex CLI')
  console.log('PASS B: 真实 Cordis 下 mount → dynamic inject → section 注册 → list 成功')
}

// C. $mount 失败：仍注册 section，loader 返回 unavailable（页面不抛错）。
{
  registrations.length = 0
  injectCalls.length = 0
  const ctx = new Context()
  new Slots(ctx)
  new Locale(ctx)
  class BrokenRemote extends Service {
    constructor(c) {
      super(c, 'remote')
    }
    async $mount() {
      throw new Error('mount boom')
    }
  }
  new BrokenRemote(ctx)
  const fiberInjects = []
  ctx.on('internal/plugin', (fiber) => fiberInjects.push(Object.keys(fiber.inject)))
  const fiber = ctx.plugin({ inject: client.inject, apply: client.apply })
  await fiber
  await settle()
  assert.equal(registrations.length, 1)
  assert.ok(
    !fiberInjects.some((keys) => keys.includes('remote.meetingstone')),
    'mount 失败不应创建动态注入子 fiber',
  )
  const snapshot = await registrations[0].options.inject().list()
  assert.equal(snapshot.unavailable.code, 'REMOTE_MOUNT_FAILED')
  assert.match(snapshot.unavailable.message, /mount boom/)
  console.log('PASS C: mount 失败时 section 仍在，loader 返回 unavailable')
}

console.log(`\nOK: real Cordis ${extract('dsh/node_modules/@deepseek-ai/cordis/package.json').toString().match(/"version": "([^"]+)"/)?.[1]} from installed app.asar`)
