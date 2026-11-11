// @ts-check
/**
 * DSH 接线层单测：全部用假 ctx（stub），不加载任何宿主包。
 *
 * 覆盖（任务 C）：
 * - canStart 在 provider 缺失时返回 ok:false 且带原因
 * - start 成功时把 role/task/cwd 正确透传给假 subagents
 * - start 抛错时向上抛（不吞）
 * - registerTools 用假 ctx.tools.register 验证注册了六个工具、名字正确、描述非空
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshAdapter, providerNameFor, PROVIDER_BY_KIND } from '../src/dsh/adapter.js'
import { registerTools, TOOL_NAMES, CLI_STATUS_CLIS } from '../src/dsh/register.js'

/** 一个永挂起的 result Promise：让内部句柄在测试期间不被自动清理。 */
const pendingResult = () => new Promise(() => {})

/**
 * 假 subagents：记录 getProvider / startActivation / dispose 调用。
 * @param {object} [over]
 */
function fakeSubagents(over = {}) {
  const calls = []
  const providers = over.providers ?? {}
  const disposed = []
  const subagents = {
    calls,
    disposed,
    getProvider(name) {
      calls.push({ method: 'getProvider', name })
      return providers[name] ?? null
    },
    async startActivation(spec) {
      calls.push({ method: 'startActivation', spec })
      // 与真实宿主一致：runtime 读的是 spec.request.*（见 src/dsh/adapter.js 注释）。
      // 扁平形状会在宿主里炸成 "Cannot read properties of undefined (reading 'maxDepth')"，
      // 这里把同样的错误提前到测试里，避免再靠真机试错。
      if (!spec || typeof spec !== 'object' || !spec.request) {
        throw new Error("Cannot read properties of undefined (reading 'maxDepth')")
      }
      if (!spec.request.parent) throw new Error('subagent creation requires the exact live parent agent')
      if (over.startError) throw over.startError
      if (over.activation) return over.activation
      return {
        childId: 'sess-1',
        name: 'agent-1',
        result: pendingResult(),
        async dispose() {
          disposed.push(spec)
        },
      }
    },
  }
  return subagents
}

/** 最小假 ctx：effect 只收集 disposer，不执行（模拟插件仍在运行）。 */
function fakeCtx(over = {}) {
  const disposers = []
  const registered = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    effect(fn) {
      disposers.push(fn())
      return disposers.length
    },
    logger: { info() {}, warn() {} },
    ...over,
  }
  return { ctx, disposers, registered }
}

const role = (over = {}) => ({
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli' },
  enabled: true,
  timeoutMs: 1000,
  ...over,
})

/** 建一个可用适配器（默认注入 getParent，见 TODO(P2-parent)）。 */
function makeAdapter(subagents, options = {}) {
  const { ctx, disposers } = fakeCtx({ subagents })
  const adapter = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    now: () => 1234,
    ...options,
  })
  return { adapter, ctx, disposers, subagents }
}

// ─── canStart ────────────────────────────────────────────────────────────────

test('canStart：拿不到查询能力时如实返回「无法确认 provider 是否注册」', () => {
  // 完全没有 ctx.subagents
  const bare = createDshAdapter(fakeCtx().ctx, { getParent: () => ({}) })
  assert.deepEqual(bare.canStart(role()), { ok: false, reason: '无法确认 provider 是否注册' })

  // 有 subagents 但没有 getProvider
  const noGetter = createDshAdapter(fakeCtx({ subagents: {} }).ctx, { getParent: () => ({}) })
  assert.deepEqual(noGetter.canStart(role()), { ok: false, reason: '无法确认 provider 是否注册' })

  // 未知 channel.kind（连 provider 名都解析不出）
  const unknown = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  assert.deepEqual(unknown.adapter.canStart(role({ channel: { kind: 'nope' } })), {
    ok: false,
    reason: '无法确认 provider 是否注册',
  })
})

test('canStart：provider 未注册时 ok:false 且原因包含 provider 名', () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: {} }))
  const res = adapter.canStart(role())
  assert.equal(res.ok, false)
  assert.match(res.reason ?? '', /acp/)
  // 必须是「真实查询」，不能靠猜
  assert.deepEqual(subagents.calls[0], { method: 'getProvider', name: 'acp' })
})

test('canStart：getProvider 抛错也被兜住，不假装 ok', () => {
  const { ctx } = fakeCtx()
  const subagents = {
    calls: [],
    getProvider() {
      throw new Error('boom')
    },
  }
  const adapter = createDshAdapter({ ...ctx, subagents }, { getParent: () => ({}) })
  const res = adapter.canStart(role())
  assert.equal(res.ok, false)
  assert.match(res.reason ?? '', /boom/)
})

test('canStart：provider 存在时 ok:true，并按 channel.kind 查正确名字', () => {
  const { adapter, subagents } = makeAdapter(
    fakeSubagents({ providers: { codex: { name: 'codex' } } }),
  )
  const res = adapter.canStart(role({ channel: { kind: 'codex' } }))
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(subagents.calls[0], { method: 'getProvider', name: 'codex' })
})

test('providerNameFor：四种 channel.kind 的映射与显式 provider 覆盖', () => {
  assert.equal(PROVIDER_BY_KIND['in-process'], 'spawn')
  assert.equal(providerNameFor(role({ channel: { kind: 'in-process' } })), 'spawn')
  assert.equal(providerNameFor(role({ channel: { kind: 'acp-cli' } })), 'acp')
  assert.equal(providerNameFor(role({ channel: { kind: 'codex' } })), 'codex')
  assert.equal(providerNameFor(role({ channel: { kind: 'claude-code' } })), 'claude-code')
  // channel.provider 是角色形状里明写的字段，优先于 kind 默认值
  assert.equal(providerNameFor(role({ channel: { kind: 'in-process', provider: 'fork' } })), 'fork')
  assert.equal(providerNameFor(role({ channel: { kind: 'unknown' } })), null)
})

// ─── start ───────────────────────────────────────────────────────────────────

test('start 成功：把 role/task/cwd 透传给宿主 startActivation', async () => {
  const { adapter, subagents } = makeAdapter(
    fakeSubagents({ providers: { acp: {} } }),
  )
  const res = await adapter.start({
    role: role(),
    task: '改个函数',
    cwd: 'D:/MeetingStone',
    timeoutMs: 0, // 不装定时器，避免测试进程被挂住
    // 项目根由宿主上下文给出；cwd 必须在其中（P2 Gate P0 的前置校验）
    context: { projectRoot: 'D:/MeetingStone' },
  })

  const startCall = subagents.calls.find((c) => c.method === 'startActivation')
  assert.ok(startCall, '必须真的调用宿主 startActivation')
  const spec = startCall.spec
  assert.ok(spec.request, 'spec 必须是嵌套 request 形状（运行时契约）')
  assert.equal(spec.provider, 'acp', 'role.channel.kind → provider')
  assert.match(spec.label, /role-sashi/, 'roleId 必须体现在 label 里')
  assert.equal(spec.request.prompt[0].type, 'text')
  assert.match(spec.request.prompt[0].text, /改个函数/, 'task 必须透传（允许带角色前缀）')
  assert.equal(spec.request.cwd, 'D:/MeetingStone', 'cwd 必须透传')
  assert.equal(spec.delivery, 'caller')
  assert.ok(spec.signal instanceof AbortSignal, '必须传 AbortSignal')
  assert.ok(spec.request.parent, 'parent: Agent 必须由注入的 getParent 提供')

  // taskRef 是宿主原生可查引用：childId(SessionId) + provider + name，且全可 JSON 序列化
  assert.equal(res.taskRef.kind, 'subagent-activation')
  assert.equal(res.taskRef.provider, 'acp')
  assert.equal(res.taskRef.childId, 'sess-1')
  assert.equal(res.taskRef.name, 'agent-1')
  assert.equal(res.taskRef.startedAt, 1234)
  assert.doesNotThrow(() => JSON.stringify(res.taskRef))
})

test('隔离启动：taskRef 带 operationId，running 记录带 worktree 元数据', async () => {
  const started = []
  const { adapter } = makeAdapter(fakeSubagents({ providers: { acp: {} } }), {
    onRunStart: (record) => started.push(record),
  })
  const worktree = {
    path: 'D:/MeetingStone/.meetingstone/worktrees/op-1',
    branch: 'meetingstone/op-1',
    baseSha: 'abc123',
    repositoryRoot: 'D:/MeetingStone',
    operationId: 'op-1',
  }
  const res = await adapter.start({
    role: role(),
    task: 'x',
    timeoutMs: 0,
    cwd: worktree.path,
    isolation: 'worktree',
    operationId: 'op-1',
    worktree,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  assert.equal(res.taskRef.operationId, 'op-1')
  assert.equal(started.length, 1)
  assert.equal(started[0].operationId, 'op-1')
  assert.deepEqual(started[0].worktree, worktree)
  assert.equal(started[0].isolation, 'worktree')
})

test('start 抛错时向上抛，不吞、不降级成成功', async () => {
  const { adapter } = makeAdapter(
    fakeSubagents({ providers: { acp: {} }, startError: new Error('spawn ENOENT') }),
  )
  await assert.rejects(
    () => adapter.start({ role: role(), task: 'x', timeoutMs: 0 }),
    /spawn ENOENT/,
  )
})

test('start 失败关闭：provider 未注册时抛 PROVIDER_UNAVAILABLE', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: {} }))
  await assert.rejects(
    () => adapter.start({ role: role(), task: 'x', timeoutMs: 0 }),
    /PROVIDER_UNAVAILABLE/,
  )
  assert.equal(
    subagents.calls.some((c) => c.method === 'startActivation'),
    false,
    'provider 未确认时不得触达 startActivation',
  )
})

test('start 失败关闭：未注入 getParent（拿不到必填的 parent Agent）时抛错', async () => {
  const { ctx } = fakeCtx({ subagents: fakeSubagents({ providers: { acp: {} } }) })
  const adapter = createDshAdapter(ctx, { now: () => 1 })
  await assert.rejects(
    () => adapter.start({ role: role(), task: 'x', timeoutMs: 0 }),
    /PARENT_AGENT_UNAVAILABLE/,
  )
})

test('startActivation 返回无效 activation 时抛 ADAPTER_FAILED', async () => {
  const { adapter } = makeAdapter(
    fakeSubagents({ providers: { acp: {} }, activation: { name: 'agent-1' } }),
  )
  await assert.rejects(
    () => adapter.start({ role: role(), task: 'x', timeoutMs: 0 }),
    /ADAPTER_FAILED/,
  )
})

test('cancel：abort 信号并调用宿主 activation.dispose()；重复取消无害', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  const res = await adapter.start({ role: role(), task: 'x', timeoutMs: 0 })
  await adapter.cancel(res.taskRef)
  assert.equal(subagents.disposed.length, 1)
  // 再取消一次：内部句柄已清理，不应重复 dispose
  await adapter.cancel(res.taskRef)
  assert.equal(subagents.disposed.length, 1)
})

// ─── registerTools ───────────────────────────────────────────────────────────

/** 构造注入 deps（全部假实现，不 import 具体实现）。 */
function makeDeps(over = {}) {
  const dispatchCalls = []
  const deps = {
    registry: {
      list: () => [
        {
          roleId: 'role-sashi',
          name: '沙僧',
          aliases: ['SS'],
          channel: { kind: 'acp-cli' },
          enabled: true,
        },
      ],
      errors: [{ code: 'ALIAS_CONFLICT', message: '示例错误' }],
    },
    dispatcher: {
      async dispatch(req) {
        dispatchCalls.push(req)
        return { ok: true, taskRef: { kind: 'subagent-activation' }, role: '沙僧' }
      },
    },
    probe: {
      async probe(cli) {
        return {
          cli,
          installed: true,
          path: `C:/bin/${cli}.exe`,
          version: '1.2.3',
          source: 'path',
          notes: [],
          checkedAt: 42,
        }
      },
      async probeAll() {
        return CLI_STATUS_CLIS.map((cli) => ({
          cli,
          installed: false,
          path: null,
          version: null,
          source: null,
          notes: ['未找到'],
          checkedAt: 42,
        }))
      },
    },
    ...over,
  }
  return { deps, dispatchCalls }
}

test('registerTools：恰好注册六个工具，名字正确、描述非空', () => {
  const { ctx, registered } = fakeCtx()
  const { deps } = makeDeps()
  const tools = registerTools(ctx, deps)

  assert.equal(registered.length, 6, '当前注册六个工具')
  assert.equal(tools.length, 6)
  assert.deepEqual(
    registered.map((t) => t.name),
    [
      TOOL_NAMES.LIST_ROLES,
      TOOL_NAMES.DISPATCH,
      TOOL_NAMES.LIST_RUNS,
      TOOL_NAMES.GET_TASK,
      TOOL_NAMES.CANCEL_TASK,
      TOOL_NAMES.CLI_STATUS,
    ],
  )
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.trim().length > 0, `${tool.name} 的 description 不能为空`)
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output && typeof tool.output.render === 'function')
  }
})

test('registerTools：defineTool 可注入（生产注入真实实现，测试注入 stub）', () => {
  const { ctx, registered } = fakeCtx()
  const { deps } = makeDeps()
  const seen = []
  registerTools(ctx, {
    ...deps,
    defineTool: (spec) => {
      seen.push(spec.name)
      // 模拟真实 defineTool 的产物（编译后的 JSON Schema）；注册前自检不接受未编译字典
      return {
        ...spec,
        parameters: { type: 'object', properties: {} },
        output: { ...spec.output, schema: { type: 'object', additionalProperties: true } },
        wrapped: true,
      }
    },
  })
  assert.deepEqual(seen, [
    TOOL_NAMES.LIST_ROLES,
    TOOL_NAMES.DISPATCH,
    TOOL_NAMES.LIST_RUNS,
    TOOL_NAMES.GET_TASK,
    TOOL_NAMES.CANCEL_TASK,
    TOOL_NAMES.CLI_STATUS,
  ])
  assert.ok(registered.every((t) => t.wrapped === true))
})

test('registerTools：ctx.tools.register 不可用时失败关闭', () => {
  const { deps } = makeDeps()
  assert.throws(() => registerTools({}, deps), /TOOLS_UNAVAILABLE/)
})

test('meetingstone_list_roles：默认紧凑；verbose 才给来源/描述，available 如实标注', async () => {
  const { ctx, registered } = fakeCtx()
  const { deps } = makeDeps()
  registerTools(ctx, deps)
  const out = await registered[0].execute({})
  assert.equal(out.roles.length, 1)
  const r = out.roles[0]
  assert.equal(r.roleId, 'role-sashi')
  assert.deepEqual(r.aliases, ['SS'])
  assert.equal(r.enabled, true)
  assert.equal(r.availability, 'unknown', '没有 ctx.subagents 查询能力，不得假装可用')
  assert.equal(Object.hasOwn(r, 'source'), false, '默认紧凑视图不返回 source')
  assert.equal(Object.hasOwn(r, 'channel'), false, '默认紧凑视图不返回 channel')
  assert.equal(out.errors[0].code, 'ALIAS_CONFLICT')

  const verbose = await registered[0].execute({ verbose: true })
  assert.equal(verbose.roles[0].source, 'unknown', 'registry 未暴露来源，不得编造')
  assert.equal(verbose.roles[0].hasPrompt, false)
  assert.equal(verbose.roles[0].channel.kind, 'acp-cli')
})

test('meetingstone_dispatch：直接返回 dispatcher 的结果，并把入参透传', async () => {
  const { ctx, registered } = fakeCtx()
  const { deps, dispatchCalls } = makeDeps()
  registerTools(ctx, deps)
  const out = await registered[1].execute({ role: 'SS', task: '改个函数', cwd: 'D:/x' })
  assert.equal(out.ok, true)
  // dispatcher 还会收到 registry（按项目上下文注入的注册表），这里只校验透传的业务字段
  assert.deepEqual(
    {
      role: dispatchCalls[0].role,
      task: dispatchCalls[0].task,
      cwd: dispatchCalls[0].cwd,
    },
    { role: 'SS', task: '改个函数', cwd: 'D:/x' },
  )
  assert.equal(Object.hasOwn(dispatchCalls[0], 'readOnly'), false, '只读通道已移除，不得再传 readOnly')
  assert.ok(dispatchCalls[0].registry, '必须把按项目解析出的注册表传给 dispatcher')
})

test('meetingstone_cli_status：只透传探测字段，不返回余额、不编造认证状态', async () => {
  const { ctx, registered } = fakeCtx()
  const { deps } = makeDeps()
  registerTools(ctx, deps)

  const all = await registered[5].execute({})
  assert.equal(all.clis.length, 3)
  for (const item of all.clis) {
    for (const key of ['installed', 'path', 'version', 'source', 'checkedAt', 'notes']) {
      assert.ok(Object.hasOwn(item, key))
    }
    for (const forbidden of ['balance', 'auth', 'authenticated', 'login', 'credits']) {
      assert.equal(Object.hasOwn(item, forbidden), false, `不得出现 ${forbidden}`)
    }
  }

  const one = await registered[5].execute({ cli: 'codex' })
  assert.equal(one.clis.length, 1)
  assert.equal(one.clis[0].cli, 'codex')
  assert.equal(one.clis[0].installed, true)

  const bad = await registered[5].execute({ cli: 'nope' })
  assert.equal(bad.error, 'UNKNOWN_CLI')
})

test('meetingstone_cli_status：探测器未注入时失败关闭，不编造状态', async () => {
  const { ctx, registered } = fakeCtx()
  const { deps } = makeDeps()
  registerTools(ctx, { ...deps, probe: null })
  const out = await registered[5].execute({})
  assert.equal(out.error, 'PROBE_UNAVAILABLE')
})

// ─── P2 Gate P0：启动前置校验（不满足就不许触达 startActivation） ────────────

test('角色指定了 model → 拒绝启动（配置成功不等于执行采用）', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  await assert.rejects(
    () =>
      adapter.start({
        role: role({ channel: { kind: 'acp-cli', model: 'deepseek-v4.1-flash' } }),
        task: 'x',
        timeoutMs: 0,
      }),
    /MODEL_UNSUPPORTED/,
  )
  assert.equal(
    subagents.calls.filter((c) => c.method === 'startActivation').length,
    0,
    '前置校验失败不得启动任务',
  )
})

test('cwd 越出项目根 → 拒绝启动', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  await assert.rejects(
    () =>
      adapter.start({
        role: role(),
        task: 'x',
        cwd: 'D:/OtherProject',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone' },
      }),
    /PATH_OUTSIDE_PROJECT/,
  )
  assert.equal(subagents.calls.filter((c) => c.method === 'startActivation').length, 0)
})

test('给不出项目根却指定了 cwd → 失败关闭', async () => {
  const { adapter } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  await assert.rejects(
    () =>
      adapter.start({
        role: role(),
        task: 'x',
        cwd: 'D:/MeetingStone',
        timeoutMs: 0,
      }),
    /PROJECT_ROOT_UNKNOWN/,
  )
})

test('parent 优先取当次 context.agent，不回退成上个会话', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  const agentA = { session: { header: { cwd: 'D:/MeetingStone' } }, tag: 'A' }
  await adapter.start({
    role: role(),
    task: 'x',
    timeoutMs: 0,
    context: { agent: agentA },
  })
  const spec = subagents.calls.find((c) => c.method === 'startActivation').spec
  assert.equal(spec.request.parent, agentA, 'parent 必须是本次上下文里的 agent')
})

test('context 没有 agent 时失败关闭（不做全局回退）', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }), {
    // 明确不注入 getParent：模拟旧 holder 被删除后的真实装配
    getParent: undefined,
  })
  await assert.rejects(
    () => adapter.start({ role: role(), task: 'x', timeoutMs: 0 }),
    /PARENT_AGENT_UNAVAILABLE/,
  )
  assert.equal(subagents.calls.filter((c) => c.method === 'startActivation').length, 0)
})

// ─── DD7 方案 B：模型由通道实例承载，角色声明必须与之一致 ──────────────────────

test('模型一致：角色声明 == 通道实例配置 → 允许启动', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }), {
    channels: [
      { channelId: 'ch-acp-flash', kind: 'acp-cli', provider: 'acp', model: 'deepseek-v4.1-flash' },
    ],
  })
  const res = await adapter.start({
    role: role({
      channel: { kind: 'acp-cli', channelId: 'ch-acp-flash', model: 'deepseek-v4.1-flash' },
    }),
    task: 'x',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone' },
  })
  assert.ok(res.taskRef, '一致时应正常启动')
  assert.equal(subagents.calls.filter((c) => c.method === 'startActivation').length, 1)
  // 模型不塞进 spec（官方 spec 没有该字段），而是由 provider 行承载
  const spec = subagents.calls.find((c) => c.method === 'startActivation').spec
  assert.equal(Object.hasOwn(spec.request, 'model'), false)
})

test('模型不一致：角色声明与通道实例冲突 → 拒绝并说明差异', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }), {
    channels: [{ channelId: 'ch-acp-flash', kind: 'acp-cli', provider: 'acp', model: 'other-model' }],
  })
  await assert.rejects(
    () =>
      adapter.start({
        role: role({
          channel: { kind: 'acp-cli', channelId: 'ch-acp-flash', model: 'deepseek-v4.1-flash' },
        }),
        task: 'x',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone' },
      }),
    /MODEL_UNSUPPORTED: 角色声明 model=deepseek-v4\.1-flash/,
  )
  assert.equal(subagents.calls.filter((c) => c.method === 'startActivation').length, 0)
})

test('引用了不存在的通道实例 → 拒绝', async () => {
  const { adapter } = makeAdapter(fakeSubagents({ providers: { acp: {} } }), { channels: [] })
  await assert.rejects(
    () =>
      adapter.start({
        role: role({ channel: { kind: 'acp-cli', channelId: 'ch-missing', model: 'm' } }),
        task: 'x',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone' },
      }),
    /通道实例 ch-missing 不存在/,
  )
})

// ─── 集成：配置 → 注册表 → 适配器（DD7 链路端到端） ──────────────────────────
// 曾有的 bug：registry 的 channel 白名单漏了 channelId，导致「模型由通道实例承载」
// 永远走到 MODEL_UNSUPPORTED。这里用真实 registry 走一遍，防止回归。

test('配置 → registry → adapter：channelId 保住，模型一致性校验通过并启动', async () => {
  const { createRegistry } = await import('../src/roles/registry.js')
  const { createDshAdapter } = await import('../src/dsh/adapter.js')

  const registry = createRegistry({
    globalRoles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: ['SS'],
        channel: { kind: 'acp-cli', channelId: 'ch-acp-flash', model: 'deepseek-v4.1-flash' },
        enabled: true,
      },
    ],
  })
  const role = registry.resolve('SS')
  assert.ok(role)
  assert.equal(role.channel.channelId, 'ch-acp-flash', 'registry 必须保留 channelId')

  const subagents = fakeSubagents({ providers: { acp: {} } })
  const adapter = createDshAdapter(
    { subagents, effect: () => {}, logger: { warn() {} } },
    { channels: [{ channelId: 'ch-acp-flash', kind: 'acp-cli', provider: 'acp', model: 'deepseek-v4.1-flash' }] },
  )

  const res = await adapter.start({
    role,
    task: 'x',
    timeoutMs: 0,
    context: {
      projectRoot: 'D:/MeetingStone',
      // parent 必须来自当次执行上下文（P2 Gate 删除全局 holder 后）
      agent: { session: { header: { cwd: 'D:/MeetingStone' } } },
    },
  })
  assert.ok(res.taskRef, '模型与实例一致时应启动成功')
})

// ─── 角色人设注入（替代 CLIWorker 的 persona prompt） ─────────────────────────

test('派单提示词包含角色身份与人设', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  await adapter.start({
    role: role({
      name: '沙僧',
      prompt: '你是技术骨干，负责主力开发。',
      channel: { kind: 'acp-cli' },
    }),
    task: '改个函数',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  const spec = subagents.calls.find((c) => c.method === 'startActivation').spec
  const text = spec.request.prompt[0].text
  assert.match(text, /沙僧/, '必须带角色名')
  assert.match(text, /技术骨干/, '必须带人设')
  assert.match(text, /改个函数/, '任务正文必须保留')
})

test('没有 prompt 时回退用 description；两者都没有则只发任务', async () => {
  const { adapter, subagents } = makeAdapter(fakeSubagents({ providers: { acp: {} } }))
  await adapter.start({
    role: role({ name: '甲', description: '负责文档', channel: { kind: 'acp-cli' } }),
    task: '写 README',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  const spec1 = subagents.calls.filter((c) => c.method === 'startActivation')[0].spec
  assert.match(spec1.request.prompt[0].text, /负责文档/)

  await adapter.start({
    role: role({ name: '', description: '', channel: { kind: 'acp-cli' } }),
    task: '裸任务',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  const spec2 = subagents.calls.filter((c) => c.method === 'startActivation')[1].spec
  assert.equal(spec2.request.prompt[0].text, '裸任务')
})

test('落盘钩子：终态记录的 result 字段必须有值（不能只传 output）', async () => {
  const started = []
  const finished = []
  const subagents = fakeSubagents({ providers: { acp: {} } })
  // 让 activation.result 立刻以文本结果结算
  subagents.startActivation = async (spec) => ({
    childId: 'child-1',
    name: 'child-1',
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PONG' }] }),
    dispose: async () => {},
  })
  const adapter = createDshAdapter(
    { subagents, effect: null },
    {
      channels: [],
      onRunStart: (r) => started.push(r),
      onRunFinish: (r) => finished.push(r),
    },
  )
  await adapter.start({
    role: role({ channel: { kind: 'acp-cli' } }),
    task: 'x',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(started.length, 1)
  assert.equal(started[0].status, 'running')
  assert.equal(finished.length, 1, '完成时应触发一次终态落盘')
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].result, 'PONG', 'result 必须映射成功输出')
  assert.equal(finished[0].output, 'PONG')
  assert.equal(finished[0].role, 'role-sashi')
})

test('安全回归：channelId 指向的实例与角色声明的 provider 不一致 → 拒绝', async () => {
  const subagents = fakeSubagents({ providers: { acp: {}, 'acp-ro': {}, codex: {} } })
  const adapter = createDshAdapter(
    { subagents, effect: null },
    {
      channels: [
        { channelId: 'ch-acp-ro', kind: 'acp-cli', provider: 'acp-ro' },
      ],
    },
  )
  await assert.rejects(
    () =>
      adapter.start({
        role: role({
          channel: { kind: 'acp-cli', channelId: 'ch-acp-ro', provider: 'acp' },
        }),
        task: 'review',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
      }),
    /CHANNEL_MISMATCH/,
    '声明 provider 与实例不一致必须拒绝，否则配置与实际执行的通道不一致',
  )
})

test('安全回归：执行的 provider 取自通道实例，而不是角色声明', async () => {
  const subagents = fakeSubagents({ providers: { 'codex-ro': {} } })
  const adapter = createDshAdapter(
    { subagents, effect: null },
    { channels: [{ channelId: 'ch-ro', kind: 'codex', provider: 'codex-ro' }] },
  )
  await adapter.start({
    role: role({ channel: { kind: 'codex', channelId: 'ch-ro' } }),
    task: 'review',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  const spec = subagents.calls.find((c) => c.method === 'startActivation').spec
  assert.equal(spec.provider, 'codex-ro', '必须用实例的 provider 执行')
})

test('安全回归：canStart 对实例与声明不一致给出可诊断原因', () => {
  const subagents = fakeSubagents({ providers: { 'acp-ro': {} } })
  const adapter = createDshAdapter(
    { subagents, effect: null },
    { channels: [{ channelId: 'ch-ro', kind: 'acp-cli', provider: 'acp-ro' }] },
  )
  const res = adapter.canStart(role({ channel: { kind: 'acp-cli', channelId: 'ch-ro', provider: 'acp' } }))
  assert.equal(res.ok, false)
  assert.match(res.reason, /CHANNEL_MISMATCH/)
})

test('refusal+空输出：补 429/限流 诊断提示（不伪造成功）', async () => {
  const subagents = fakeSubagents({ providers: { acp: {} } })
  subagents.startActivation = async () => ({
    childId: 'child-refusal',
    name: 'child-refusal',
    result: Promise.resolve({ stopReason: 'refusal', output: [] }),
    dispose: async () => {},
  })
  const finished = []
  const adapter = createDshAdapter(
    { subagents, effect: null },
    { channels: [], onRunFinish: (r) => finished.push(r) },
  )
  await adapter.start({
    role: role({ channel: { kind: 'acp-cli' } }),
    task: 'x',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(finished.length, 1)
  assert.equal(finished[0].stopReason, 'refusal')
  assert.match(finished[0].diagnostic, /429|限流|频率/, '必须提示可能是限流，而不是空结果')
})
