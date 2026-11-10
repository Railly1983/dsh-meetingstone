// @ts-check
/**
 * 装配层的集成测试：用假 ctx 走一遍 apply()，确认
 *  配置 → 注册表 → 派单器 → 三个工具 真的接上了。
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
      permissionPreset: 'project-write',
      enabled: true,
    },
    {
      roleId: 'role-reviewer',
      name: '审核员',
      aliases: ['RV'],
      channel: { kind: 'in-process' },
      permissionPreset: 'read-only',
      enabled: true,
    },
  ],
  defaultRoleId: 'role-sashi',
}

test('inject 声明了 tools 依赖', () => {
  assert.deepEqual(inject, ['tools', 'subagents'], 'tools 用于注册，subagents 用于派单与可用性')
})

test('apply 注册五个工具且不抛错（即便宿主没有 subagents）', () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  assert.equal(tools.length, 5)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'meetingstone_cancel_task',
    'meetingstone_cli_status',
    'meetingstone_dispatch',
    'meetingstone_get_task',
    'meetingstone_list_roles',
  ])
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function', `${t.name} 缺少 execute`)
    assert.ok(t.description && t.description.length > 5, `${t.name} 缺少描述`)
  }
})

test('注册给宿主的工具 schema 是合法 JSON Schema（不撞 readOnly 保留注解）', () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, config)
  // 回归：原样注册未编译的参数字典时，根上的 readOnly 会被 DeepSeek 当成
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
  assert.equal(dispatch.parameters.properties.readOnly.type, 'boolean')
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
  assert.equal(seen.length, 5)
  assert.equal(Object.hasOwn(seen[1].parameters, 'readOnly'), true, '应把作者 DSL 交给 defineTool')
  assert.equal(seen[1].parameters.readOnly.type, 'boolean')
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
  assert.equal(tools.length, 5)
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
          permissionPreset: 'read-only',
        },
      ],
      roleOverrides: { 'role-sashi': { permissionPreset: 'read-only' } },
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

    // 给出会话项目根 → 项目角色出现，且全局角色的权限被收紧
    const exec = { agent: { session: { header: { cwd: dir } } } }
    const scoped = await listTool.execute({}, exec)
    const ids = scoped.roles.map((r) => r.roleId).sort()
    assert.deepEqual(ids, ['role-reviewer', 'role-sashi', 'role-scout'], '项目新增角色应出现')

    const sashi = scoped.roles.find((r) => r.roleId === 'role-sashi')
    assert.equal(sashi.permissionPreset, 'read-only', '项目覆盖应把权限收紧')
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
