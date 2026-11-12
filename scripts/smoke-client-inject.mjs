// @ts-check
/**
 * 真机机制冒烟：用**安装版宿主 app.asar 里的 Cordis 4.1.0** 驱动
 * src/client/index.js，验证「Remote 动态注入」修复，而不是只靠 stub。
 *
 * 复现的两条路径：
 *   A. 旧写法（父 fiber 未声明 `remote.meetingstone`）：`ctx.remote.meetingstone`
 *      必然抛 `cannot get property "remote.meetingstone" without inject`
 *      （cordis/src/reflect.ts:152-178）。
 *   B. 现写法（0.2.0）：`ctx.remote.$mount(...)` 后**立即**注册 header / section /
 *      sidebar（不阻塞在 `ctx.inject` 回调里），服务读取走 `ctx.get()`；$mount 失败
 *      时 header 仍注册、loader 返回 unavailable。
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
import { z } from 'zod'

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
  /** U1a：strict 会话读取（侧栏只读面板的数据源）。 */
  async getSessionConfig(sessionId) {
    return {
      ok: true,
      value: {
        effective: {
          roles: [
            {
              roleId: 'role-sashi',
              name: '沙僧',
              aliases: ['SS'],
              channel: { channelId: 'ch-acp-flash', provider: 'acp', model: 'flash-1' },
            },
          ],
          defaultRoleId: 'role-sashi',
        },
        overrides: {},
        sources: {
          roles: { 'role-sashi': { layer: 'global' } },
          defaultRoleId: 'global',
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
  // U1a：不得 require primitives（不在 asar node_modules，官方禁止第三方插件 require）。
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    throw new Error('U1a: client must not require primitives')
  }
  if (name === 'zod') return { z }
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

/** stub JSX 树里找 svg（函数组件需手动展开一次）。 */
function findSvg(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'svg') return node
  if (typeof node.type === 'function' && node.props?.children === undefined) {
    return findSvg(node.type(node.props))
  }
  const children = node.props?.children
  const list = Array.isArray(children) ? children : children ? [children] : []
  for (const child of list) {
    const found = findSvg(child)
    if (found) return found
  }
  return null
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

// B. 现写法：真实 apply（模块级 inject 与真实 loader 一致）。
{
  registrations.length = 0
  injectCalls.length = 0
  const ctx = new Context()
  new Slots(ctx)
  new Locale(ctx)
  new Remote(ctx)
  const fiber = ctx.plugin({ inject: client.inject, apply: client.apply })
  await fiber
  await settle()
  assert.equal(registrations.length, 1, 'B3 之后只注册 settings.section')
  assert.equal(
    client.__test.REMOTE_CONTRIBUTION.descriptors.length,
    6,
    'list + 5 个配置方法（B3 已下线 3 个会话覆盖方法）',
  )
  assert.deepEqual(
    client.__test.REMOTE_CONTRIBUTION.descriptors.map((d) => d.method),
    [
      'list',
      'setCliEnabled',
      'refreshCli',
      'updateGlobalRole',
      'createGlobalRole',
      'deleteGlobalRole',
    ],
  )
  assert.deepEqual(
    registrations.map((r) => r.options.name),
    ['settings.section'],
    'B3 之后不再注册 header / sidebar tab',
  )
  const section = registrations.find((r) => r.options.name === 'settings.section')
  assert.equal(section.options.id, 'meetingstone')
  assert.equal(typeof section.Component, 'function')
  const snapshot = await section.options.inject().list()
  assert.equal(snapshot.roles[0].name, '沙僧')
  assert.equal(snapshot.global.defaultRoleId, 'role-sashi')
  assert.equal(snapshot.global.cli[0].label, 'Codex CLI')

  // B3 作废项：header action 与 sidebar tab 不得存在。
  assert.equal(
    registrations.some((r) => r.options.name === 'conversation.session.header.actions'),
    false,
    'B3：不应再有对话页头角色入口',
  )
  assert.equal(
    registrations.some((r) => r.options.name === 'sidebar.right.pane.tab'),
    false,
    'B3：不应再有右侧栏「本对话角色」面板',
  )
  console.log('PASS B: 真实 Cordis 下 mount → 只注册 settings.section → list 成功')
}

// C. $mount 失败：settings.section 仍注册，loader 返回 unavailable。
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
  const fiber = ctx.plugin({ inject: client.inject, apply: client.apply })
  await fiber
  await settle()
  assert.equal(registrations.length, 1, 'B3：mount 失败也必须注册 settings.section')
  const section = registrations.find((r) => r.options.name === 'settings.section')
  const snapshot = await section.options.inject().list()
  assert.equal(snapshot.unavailable.code, 'REMOTE_MOUNT_FAILED')
  assert.match(snapshot.unavailable.message, /mount boom/)
  console.log('PASS C: mount 失败时 settings.section 仍在，loader 返回 unavailable')
}

console.log(`\nOK: real Cordis ${extract('dsh/node_modules/@deepseek-ai/cordis/package.json').toString().match(/"version": "([^"]+)"/)?.[1]} from installed app.asar`)
