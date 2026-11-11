// @ts-check
/**
 * 装配层的集成测试：用假 ctx 走一遍 apply()，确认
 *  配置 → 注册表 → 派单器 → 六个工具 真的接上了。
 *
 * 这里不碰 DSH 运行时；真实 provider 行为的验收在阶段 2 的真机联调里做。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name, PLUGIN_VERSION } from '../src/index.js'
import { registerTools } from '../src/dsh/register.js'

/** 记录注册了哪些工具，并提供最小可用的 ctx 形状。 */
function makeCtx() {
  const tools = []
  const logs = []
  const disposers = []
  const ctx = {
    effect(fn, label) {
      assert.equal(typeof label, 'string')
      disposers.push(fn())
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    logger: {
      info(line) {
        logs.push(line)
      },
    },
    // 故意不提供 subagents：适配器应在派单时失败关闭，而不是加载即崩
  }
  return { ctx, tools, logs, disposers }
}

const config = {
  roles: [
    {
      roleId: 'role-sashi',
      name: '沙僧',
      aliases: ['SS'],
      channel: { kind: 'acp-cli', cli: 'codebuddy' },
      enabled: true,
    },
    {
      roleId: 'role-reviewer',
      name: '审核员',
      aliases: ['RV'],
      channel: { kind: 'in-process' },
      enabled: true,
    },
  ],
  defaultRoleId: 'role-sashi',
}

test('inject 声明了 tools 依赖', () => {
  assert.deepEqual(inject, ['tools', 'subagents'], 'tools 用于注册，subagents 用于派单与可用性')
})

test('apply 注册八个工具且不抛错（即便宿主没有 subagents）', () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  assert.equal(tools.length, 8)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'meetingstone_cancel_task',
    'meetingstone_cli_status',
    'meetingstone_dispatch',
    'meetingstone_get_run_artifact',
    'meetingstone_get_task',
    'meetingstone_list_roles',
    'meetingstone_list_runs',
    'meetingstone_wait',
  ])
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function', `${t.name} 缺少 execute`)
    assert.ok(t.description && t.description.length > 5, `${t.name} 缺少描述`)
  }
})

test('注册给宿主的工具 schema 是合法 JSON Schema（不撞保留注解）', () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  // 回归：原样注册未编译的参数字典时，根上的字段名会被 DeepSeek 当成
  // JSON Schema 保留注解（要求 boolean），整轮请求被 400 INVALID_REQUEST 拒掉。
  for (const t of tools) {
    assert.equal(t.parameters.type, 'object', `${t.name}: parameters 未编译成 object 根`)
    assert.equal(typeof t.parameters.properties, 'object', `${t.name}: 缺 properties`)
    assert.equal(
      typeof t.output.schema.additionalProperties,
      'boolean',
      `${t.name}: object 输出 schema 必须显式声明 additionalProperties`,
    )
    for (const key of ['readOnly', 'writeOnly', 'deprecated']) {
      assert.ok(
        !Object.hasOwn(t.parameters, key),
        `${t.name}: parameters 根上出现保留注解 ${key}`,
      )
    }
  }
  const dispatch = tools.find((t) => t.name === 'meetingstone_dispatch')
  assert.equal(Object.hasOwn(dispatch.parameters.properties, 'readOnly'), false, '只读通道已移除')
  assert.deepEqual(dispatch.parameters.required, ['role', 'task'])
  assert.deepEqual(dispatch.parameters.properties.role.type, 'string')
})

test('注入宿主 defineTool 时传的是作者 spec 字典（不双重编译）', () => {
  const seen = []
  const fakeDefineTool = (spec) => {
    seen.push(spec)
    // 模拟真实 defineTool 的产物（编译后的 JSON Schema）；注册前自检不接受未编译字典
    return {
      ...spec,
      parameters: { type: 'object', properties: {} },
      output: { ...spec.output, schema: { type: 'object', additionalProperties: true } },
    }
  }
  const ctx = { tools: { register: () => () => {} } }
  registerTools(ctx, {
    registry: { list: () => [], errors: [] },
    dispatcher: { dispatch: async () => ({ ok: true }) },
    probe: { probe: async () => ({}), probeAll: async () => [] },
    defineTool: fakeDefineTool,
  })
  assert.equal(seen.length, 8)
  assert.equal(Object.hasOwn(seen[1].parameters, 'role'), true, '应把作者 DSL 交给 defineTool')
  assert.equal(seen[1].parameters.role.type, 'string')
  assert.equal(Object.hasOwn(seen[1].parameters, 'readOnly'), false, '只读通道已移除，参数里不得再出现')
  assert.equal(seen[1].parameters.type, undefined, '不能预先编译，否则 defineTool 会二次编译')
})

test('list_roles 返回配置里的角色', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  const listTool = tools.find((t) => t.name === 'meetingstone_list_roles')
  const res = await listTool.execute({})
  const roles = res?.roles ?? res
  assert.ok(Array.isArray(roles), '应返回角色数组')
  assert.equal(roles.length, 2)
  assert.deepEqual(roles.map((r) => r.roleId).sort(), ['role-reviewer', 'role-sashi'])
})

test('dispatch 在宿主没有 subagents 时失败关闭，给出可诊断原因', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  const dispatchTool = tools.find((t) => t.name === 'meetingstone_dispatch')
  const res = await dispatchTool.execute({ role: 'SS', task: '改个函数' })
  assert.equal(res.ok, false)
  assert.ok(
    ['PROVIDER_UNAVAILABLE', 'PARENT_AGENT_UNAVAILABLE'].includes(res.code),
    `应失败关闭，实际 code=${res.code}`,
  )
  assert.ok(res.message && res.message.length > 0)
})

test('dispatch 对未知角色报 ROLE_NOT_FOUND（不触达适配器）', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  const dispatchTool = tools.find((t) => t.name === 'meetingstone_dispatch')
  const res = await dispatchTool.execute({ role: '不存在的人', task: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'ROLE_NOT_FOUND')
})

test('dispose 幂等，且在 dispose 后再次 dispose 不报错', () => {
  const { ctx, disposers } = makeCtx()
  apply(ctx, config)
  assert.ok(disposers.length >= 1, '至少要有插件自己的生命周期 effect')
  for (const d of disposers) assert.doesNotThrow(() => d())
  for (const d of disposers) assert.doesNotThrow(() => d())
})

test('空配置也能加载（roles=0）', () => {
  const { ctx, tools, logs } = makeCtx()
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(tools.length, 8)
  assert.ok(logs.some((l) => l.includes('roles=0')))
})

test('插件标识与版本', () => {
  assert.equal(name, 'meetingstone')
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
})

// ─── 项目级配置接线（P2-02 剩余部分）────────────────────────────────────────

test('list_roles 按当前会话项目根读取 .meetingstone.json（项目角色可见）', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-wiring-'))
  fs.writeFileSync(
    path.join(dir, '.meetingstone.json'),
    JSON.stringify({
      version: 1,
      roles: [
        {
          roleId: 'role-scout',
          name: '斥候',
          aliases: ['SC'],
          channel: { kind: 'in-process' },
        },
      ],
      roleOverrides: { 'role-sashi': { description: '项目内改为复核' } },
    }),
    'utf8',
  )

  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, config)
    const listTool = tools.find((t) => t.name === 'meetingstone_list_roles')

    // 没有 exec.agent（无法确定项目根）→ 只有全局角色，并如实说明未启用项目域
    const globalOnly = await listTool.execute({})
    assert.equal(globalOnly.roles.length, 2)
    assert.equal(globalOnly.projectScoped, true, '注入了 resolveRegistry 就应标记为项目域可用')

    // 给出会话项目根 → 项目角色出现，且全局角色的字段被覆盖
    const exec = { agent: { session: { header: { cwd: dir } } } }
    const scoped = await listTool.execute({}, exec)
    const ids = scoped.roles.map((r) => r.roleId).sort()
    assert.deepEqual(ids, ['role-reviewer', 'role-sashi', 'role-scout'], '项目新增角色应出现')

    const sashi = scoped.roles.find((r) => r.roleId === 'role-sashi')
    assert.equal(sashi.description, undefined, '默认紧凑视图不返回 description')
    const verbose = await listTool.execute({ verbose: true }, exec)
    const sashiVerbose = verbose.roles.find((r) => r.roleId === 'role-sashi')
    assert.equal(sashiVerbose.description, '项目内改为复核', 'verbose:true 才返回项目覆盖后的描述')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('项目配置文件损坏时：仍能列角色，并把解析错误一起返回', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-wiring-bad-'))
  fs.writeFileSync(path.join(dir, '.meetingstone.json'), '{ broken json', 'utf8')

  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, config)
    const listTool = tools.find((t) => t.name === 'meetingstone_list_roles')
    const res = await listTool.execute({}, { agent: { session: { header: { cwd: dir } } } })
    assert.equal(res.roles.length, 2, '坏文件不应影响全局角色')
    assert.ok(
      res.errors.some((e) => e.code === 'PROJECT_CONFIG_INVALID_JSON'),
      '必须把解析错误暴露出来，不能静默忽略',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('list_roles verbose:true 暴露配置透明度字段（职责/人设/通道）', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, {
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        description: '技术骨干',
        prompt: '你是技术骨干。',
        channel: { kind: 'acp-cli', provider: 'acp', channelId: 'ch-acp', model: 'hy4' },
      },
      { roleId: 'role-xiaobai', name: '小白', description: '杂活' },
    ],
  })
  const listTool = tools.find((t) => t.name === 'meetingstone_list_roles')
  const res = await listTool.execute({ verbose: true })
  const byId = Object.fromEntries((res?.roles ?? res).map((r) => [r.roleId, r]))
  assert.equal(byId['role-sashi'].description, '技术骨干')
  assert.equal(byId['role-sashi'].hasPrompt, true)
  assert.equal(byId['role-sashi'].channelId, 'ch-acp')
  assert.equal(byId['role-sashi'].model, 'hy4')
  assert.equal(byId['role-xiaobai'].hasPrompt, false, '没配人设要如实 false')
  assert.equal(byId['role-xiaobai'].channelId, undefined)
})

test('dispatch 传入 projectKey（按项目隔离并发）', async () => {
  const registered = new Map()
  const calls = []
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: {
        list: () => [],
        resolve: () => ({
          roleId: 'role-sashi', name: '沙僧', description: '',
          channel: { kind: 'acp-cli' }, enabled: true, timeoutMs: 1000,
        }),
        errors: [],
      },
      dispatcher: { async dispatch(input) { calls.push(input); return { ok: true, taskRef: { childId: 'c1' } } } },
      probe: { probe: async () => ({}) },
    },
  )
  const spec = registered.get('meetingstone_dispatch')
  await spec.execute({ role: 'SS', task: 'x' }, { agent: { session: { header: { cwd: 'D:/proj-a' } } } })
  assert.equal(calls[0].projectKey, 'd:/proj-a', '必须把项目根归一化后作为并发计数键（Windows 折叠大小写）')
})

test('get_task：running 时以内存为准，不被磁盘快照覆盖', async () => {
  const registered = new Map()
  let diskReads = 0
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: { list: () => [], resolve: () => null, errors: [] },
      dispatcher: { dispatch: async () => ({}), getTask: async () => ({ status: 'running', childId: 'c1', output: '' }) },
      probe: { probe: async () => ({}) },
      loadPersistedRun: async () => { diskReads += 1; return { status: 'running', schemaVersion: 1 } },
    },
  )
  const spec = registered.get('meetingstone_get_task')
  const out = await spec.execute({ childId: 'c1' }, { agent: { session: { header: { cwd: 'D:/p' } } } })
  assert.equal(out.status, 'running')
  assert.equal(diskReads, 0, 'running 时不该读磁盘')
  assert.equal(out.schemaVersion, undefined)
})
