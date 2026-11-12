// @ts-check
/**
 * P0-S0 strict Remote 契约测试（真实 zod + 真实 createTypertRemoteInfo）。
 *
 * 关键目标：
 *  - 三个会话方法的参数/结果 codec 都是 `mode:"strict"` 且 typeSymbol 非空；
 *  - `create()` 返回真实 zod schema，非法参数被 parse 拒绝；
 *  - Host manifest 经 `ctx.typert.register()` 注册（stub 捕获真实 descriptor）；
 *  - 非 strict / 空壳 create 被 `assertStrictDescriptors` 拒绝；
 *  - typeSymbol 与 Client 侧一致（Client 对比在 tests/gui.test.mjs）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'

import {
  GUI_STRICT_METHODS,
  SESSION_REMOTE_TYPES,
  TYPERT_PACKAGE,
  assertStrictDescriptors,
  createSessionRemoteSpec,
} from '../src/gui/typert-spec.js'
import {
  buildSessionRemoteManifest,
  registerSessionStrictRemotes,
} from '../src/gui/typert.js'

/** 用真实协议把 spec 变成 descriptor（与生产同一路径）。 */
function buildDescriptors() {
  return createTypertRemoteInfo(createSessionRemoteSpec(z), z).descriptors
}

test('strict 契约：八个方法都存在，参数/结果全部 strict + 非空 typeSymbol + 真实 zod', () => {
  const descriptors = buildDescriptors()
  assert.equal(descriptors.length, 8)
  assert.deepEqual(descriptors.map((d) => d.method), GUI_STRICT_METHODS)
  assert.doesNotThrow(() => assertStrictDescriptors(descriptors))

  for (const descriptor of descriptors) {
    assert.equal(descriptor.service, 'meetingstone')
    assert.equal(descriptor.namespace, 'meetingstone')
    assert.match(descriptor.id, /^dsh-meetingstone#meetingstone\//)
    assert.equal(descriptor.result.mode, 'strict')
    assert.ok(descriptor.result.typeSymbol.length > 0)
    const resultSchema = descriptor.result.create()
    assert.equal(typeof resultSchema.parse, 'function')
  }

  const byMethod = Object.fromEntries(descriptors.map((d) => [d.method, d]))
  assert.deepEqual(
    byMethod.getSessionConfig.parameters.map((p) => p.wire),
    ['sessionId'],
  )
  assert.deepEqual(
    byMethod.setSessionOverride.parameters.map((p) => p.wire),
    ['sessionId', 'roleId', 'field', 'value'],
  )
  assert.deepEqual(
    byMethod.clearSessionOverride.parameters.map((p) => p.wire),
    ['sessionId', 'roleId', 'field'],
  )
  assert.equal(byMethod.clearSessionOverride.parameters[2].acceptsUndefined, true)

  assert.equal(byMethod.getSessionConfig.parameters[0].codec.typeSymbol, SESSION_REMOTE_TYPES.sessionId)
  assert.equal(byMethod.setSessionOverride.parameters[1].codec.typeSymbol, SESSION_REMOTE_TYPES.roleId)
  assert.equal(byMethod.setSessionOverride.parameters[2].codec.typeSymbol, SESSION_REMOTE_TYPES.field)
  assert.equal(byMethod.setSessionOverride.parameters[3].codec.typeSymbol, SESSION_REMOTE_TYPES.value)
})

test('参数校验：zod 在边界拒绝空串/错误类型，接受合法值', () => {
  const byMethod = Object.fromEntries(buildDescriptors().map((d) => [d.method, d]))
  const sessionCodec = byMethod.getSessionConfig.parameters[0].codec
  assert.equal(sessionCodec.create().parse('sess-1'), 'sess-1')
  assert.throws(() => sessionCodec.create().parse(''), /too small/i)
  assert.throws(() => sessionCodec.create().parse(42))
  assert.throws(() => sessionCodec.create().parse(null))

  const setParams = byMethod.setSessionOverride.parameters
  assert.throws(() => setParams[1].codec.create().parse(''))
  assert.throws(() => setParams[2].codec.create().parse(123))
  assert.deepEqual(setParams[3].codec.create().parse({ channel: { model: 'm-1' } }), {
    channel: { model: 'm-1' },
  })
  assert.equal(setParams[3].codec.create().parse('任意 JSON'), '任意 JSON')

  // 结果 schema 能解析真实返回形状（strict codec 不是空壳）。
  const view = byMethod.getSessionConfig.result.create()
  assert.doesNotThrow(() =>
    view.parse({ effective: { roles: [] }, overrides: {}, sources: { roles: {} } }),
  )
  // P0-S2：warnings 必须能穿过 strict result codec（zod 默认会剥未知键）。
  assert.deepEqual(
    view.parse({
      effective: { roles: [] },
      overrides: {},
      sources: { roles: {} },
      warnings: [{ code: 'SESSION_CONFIG_INVALID_JSON', message: 'bad' }],
    }).warnings,
    [{ code: 'SESSION_CONFIG_INVALID_JSON', message: 'bad' }],
  )

  const override = byMethod.setSessionOverride.result.create()
  assert.doesNotThrow(() => override.parse({ ok: true, written: true, patch: {} }))
  // P0-S2：scope/idempotent/code 也必须能穿过 strict result codec。
  assert.deepEqual(
    override.parse({ ok: true, written: false, idempotent: true, scope: 'field', code: null }),
    { ok: true, written: false, idempotent: true, scope: 'field', code: null },
  )
})

test('非 strict / 空壳 create 被拒绝（不允许退回 src-json 绕过）', () => {
  assert.throws(
    () =>
      assertStrictDescriptors([
        { id: 'meetingstone/x', parameters: [{ name: 'a', codec: { mode: 'src-json' } }], result: { mode: 'src-json' } },
      ]),
    /must be mode "strict"/,
  )
  assert.throws(
    () =>
      assertStrictDescriptors([
        {
          id: 'meetingstone/x',
          parameters: [{ name: 'a', codec: { mode: 'strict', typeSymbol: '', create: () => z.string() } }],
          result: { mode: 'strict', typeSymbol: 'T', create: () => z.unknown() },
        },
      ]),
    /non-empty typeSymbol/,
  )
  assert.throws(
    () =>
      assertStrictDescriptors([
        {
          id: 'meetingstone/x',
          parameters: [{ name: 'a', codec: { mode: 'strict', typeSymbol: 'T', create: () => ({}) } }],
          result: { mode: 'strict', typeSymbol: 'T', create: () => z.unknown() },
        },
      ]),
    /must return a real zod schema/,
  )
})

test('Host manifest：经真实 createTypertRemoteInfo 生成，可交给 ctx.typert.register', () => {
  const built = buildSessionRemoteManifest({ zod: z, createInfo: createTypertRemoteInfo })
  assert.equal(built.ok, true)
  assert.equal(built.manifest.package, TYPERT_PACKAGE)
  assert.equal(built.manifest.face, 'host')
  assert.deepEqual(built.manifest.schemas, [])
  assert.equal(built.manifest.invocations.length, 8)
  assert.doesNotThrow(() => assertStrictDescriptors(built.manifest.invocations))
  assert.deepEqual(built.manifest.model, { services: [], events: [], objects: [] })
})

test('registerSessionStrictRemotes：typert 就绪后注册；重复/失败只记录不抛出', () => {
  const registered = []
  const logs = []
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['typert'])
      callback({
        effect: (fn) => fn(),
        typert: { register: (manifest) => registered.push(manifest) },
      })
      return {}
    },
  }
  const result = registerSessionStrictRemotes(ctx, {
    zod: z,
    createInfo: createTypertRemoteInfo,
    log: (level, line) => logs.push([level, line]),
  })
  assert.equal(result.registered, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].invocations.length, 8)
  assert.ok(logs.some(([level, line]) => level === 'info' && line.includes('phase=strict') && line.includes('status=ok')))

  // 注册抛错（例如 HMR 重复注册）：捕获并记录，调用方不需要 try/catch。
  const failing = registerSessionStrictRemotes(
    {
      inject(_deps, callback) {
        callback({
          effect: (fn) => fn(),
          typert: {
            register() {
              throw new Error('already registered')
            },
          },
        })
      },
    },
    { zod: z, createInfo: createTypertRemoteInfo, log: (level, line) => logs.push([level, line]) },
  )
  assert.equal(failing.registered, false)
  assert.equal(failing.reason, 'TYPERT_REGISTER_FAILED')
  assert.ok(logs.some(([level, line]) => level === 'error' && line.includes('already registered')))
})

test('registerSessionStrictRemotes：缺少 zod / typert / ctx.inject 时安全降级', () => {
  assert.deepEqual(registerSessionStrictRemotes({}), {
    registered: false,
    reason: 'CTX_INJECT_UNAVAILABLE',
  })
  const noZod = registerSessionStrictRemotes({ inject() {} }, { zod: null, createInfo: createTypertRemoteInfo })
  assert.equal(noZod.registered, false)
  assert.equal(noZod.reason, 'ZOD_UNAVAILABLE')
  const noProtocol = registerSessionStrictRemotes({ inject() {} }, { zod: z, createInfo: null })
  assert.equal(noProtocol.registered, false)
  assert.equal(noProtocol.reason, 'TYPERT_PROTOCOL_UNAVAILABLE')
})

test('真实 TypertRegistry：接受 manifest、端点可查、dispose 后注销、重复注册被拒', async () => {
  const ctx = new Context()
  const registry = new TypertRegistry(ctx)
  const built = buildSessionRemoteManifest({ zod: z, createInfo: createTypertRemoteInfo })
  assert.equal(built.ok, true)

  const dispose = registry.register(built.manifest)
  const descriptor = ctx.typert.local.get('meetingstone/getSessionConfig')
  assert.ok(descriptor, 'Host strict 端点应可查')
  assert.equal(descriptor.id, 'dsh-meetingstone#meetingstone/getSessionConfig')
  assert.equal(descriptor.parameters[0].codec.mode, 'strict')
  assert.equal(descriptor.parameters[0].codec.typeSymbol, SESSION_REMOTE_TYPES.sessionId)
  assert.equal(typeof descriptor.parameters[0].codec.create().parse, 'function')

  // 三个端点都在
  assert.ok(ctx.typert.local.get('meetingstone/setSessionOverride'))
  assert.ok(ctx.typert.local.get('meetingstone/clearSessionOverride'))

  // 重复注册同一个 package-face 必须被 registry 拒绝（HMR 场景由调用方捕获）。
  assert.throws(() => registry.register(built.manifest), /already registered/)

  await dispose()
  assert.equal(ctx.typert.local.get('meetingstone/getSessionConfig'), undefined, 'dispose 后端点应注销')
})

test('真实 TypertRegistry：空 typeSymbol / 空壳 create 被拒；src-json 仅作 SRC 回退', () => {
  const base = buildDescriptors()[0]

  const badTypeSymbolCtx = new Context()
  const badTypeSymbol = new TypertRegistry(badTypeSymbolCtx)
  assert.throws(
    () =>
      badTypeSymbol.register({
        package: 'dsh-meetingstone-reject-1',
        face: 'host',
        schemas: [],
        invocations: [
          {
            ...base,
            id: 'x#reject/a',
            service: 'reject',
            namespace: 'reject',
            method: 'a',
            parameters: [
              {
                name: 'sessionId',
                wire: 'sessionId',
                source: 'json',
                codec: { mode: 'strict', typeSymbol: '', create: () => z.string() },
              },
            ],
          },
        ],
      }),
    /nonempty/,
  )

  const hollowCtx = new Context()
  const hollow = new TypertRegistry(hollowCtx)
  assert.throws(
    () =>
      hollow.register({
        package: 'dsh-meetingstone-reject-2',
        face: 'host',
        schemas: [],
        invocations: [
          {
            ...base,
            id: 'x#reject/b',
            service: 'reject',
            namespace: 'reject',
            method: 'b',
            parameters: [
              { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'T' } },
            ],
          },
        ],
      }),
    /no create\(\) factory/,
  )

  // src-json 是 registry 的合法 SRC 回退，但客户端 `requireStrictInputs` 会拒绝；
  // 因此我们绝不能用它作为带参方法的参数 codec。
  const srcCtx = new Context()
  const srcRegistry = new TypertRegistry(srcCtx)
  assert.doesNotThrow(() =>
    srcRegistry.register({
      package: 'dsh-meetingstone-reject-3',
      face: 'host',
      schemas: [],
      invocations: [
        {
          ...base,
          id: 'x#reject/c',
          service: 'reject',
          namespace: 'reject',
          method: 'c',
          parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }],
        },
      ],
    }),
  )
})

test('真实 Cordis + registry：deferred 的 ctx.inject 最终注册 8 个 strict 端点', async () => {
  const ctx = new Context()
  new TypertRegistry(ctx)
  const logs = []
  const result = registerSessionStrictRemotes(ctx, {
    zod: z,
    createInfo: createTypertRemoteInfo,
    log: (level, line) => logs.push([level, line]),
  })
  assert.equal(result.registered, true)

  // ctx.inject 的子 fiber 异步 apply；等到端点出现或超时。
  for (let i = 0; i < 100 && ctx.typert.local.list().length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const endpoints = ctx.typert.local.list().map((d) => d.id).sort()
  assert.deepEqual(endpoints, [
    'dsh-meetingstone#meetingstone/clearSessionOverride',
    'dsh-meetingstone#meetingstone/createGlobalRole',
    'dsh-meetingstone#meetingstone/deleteGlobalRole',
    'dsh-meetingstone#meetingstone/getSessionConfig',
    'dsh-meetingstone#meetingstone/refreshCli',
    'dsh-meetingstone#meetingstone/setCliEnabled',
    'dsh-meetingstone#meetingstone/setSessionOverride',
    'dsh-meetingstone#meetingstone/updateGlobalRole',
  ])
  assert.ok(logs.some(([level, line]) => level === 'info' && line.includes('phase=strict') && line.includes('status=ok')))
})

test('真实 Cordis 生命周期：生产 effect 路径注册，插件 dispose 后端点注销', async () => {
  const root = new Context()
  new TypertRegistry(root)
  const fiber = root.plugin({
    name: 'meetingstone-strict-lifecycle-test',
    apply(ctx) {
      ctx.effect(() => {
        registerSessionStrictRemotes(ctx, { zod: z, createInfo: createTypertRemoteInfo })
        return () => {}
      }, 'meetingstone: lifecycle')
    },
  })
  await fiber

  const waitFor = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  await waitFor(() => root.typert.local.list().length > 0)
  assert.equal(root.typert.local.list().length, 8, '插件存活时八个 strict 端点都在')

  await fiber.dispose()
  await waitFor(() => root.typert.local.list().length === 0)
  assert.equal(root.typert.local.list().length, 0, '插件 dispose 后端点必须注销')
})
