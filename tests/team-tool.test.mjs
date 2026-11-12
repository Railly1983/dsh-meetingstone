// @ts-check
/**
 * `src/dsh/team-tool.js` 的测试。
 *
 * 重点覆盖「建成员前后」的边界：
 * - 解析失败时**绝不能建成员**（避免建出一个跑错模型的成员，且成员名不可回收）
 * - 宿主没有 Agent Teams 时**静默跳过**（不是错误，未启用 Team 的 profile 很常见）
 * - 成员建成但路由写入失败时**保留成员并如实报告**（宿主无 removeMember）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerTeamRoleTool } from '../src/dsh/team-tool.js'

/** 造一个可观测的假 ctx + deps。 */
function makeCtx({ withTeams = true, agentFor = () => undefined } = {}) {
  /** @type {any[]} */
  const registered = []
  const ctx = {
    tools: { register: (def) => registered.push(def) },
  }
  const agents = { get: (id) => agentFor(id) }
  /** @type {any} */
  const deps = { agents }
  if (withTeams) {
    deps.agentTeams = {
      spawnTeammate: async (_parent, req) => ({ member: { id: `child-${req.name}`, name: req.name } }),
    }
  }
  return { ctx, deps, registered }
}

const IN_PROCESS_ROLE = {
  roleId: 'role-shaseng',
  name: '沙僧',
  aliases: ['shaseng', 'sha'],
  channel: {
    channelId: 'ch-inprocess',
    kind: 'in-process',
    llmProvider: 'workbuddy',
    llmModel: 'deepseek-v4.1-flash',
    reasoning: 'high',
  },
}

const registry = (roles) => ({ list: () => roles })

/** 从注册结果里取出 execute，避免每个测试重复样板。 */
function toolOf(registered) {
  assert.equal(registered.length, 1, '应恰好注册一个工具')
  return registered[0]
}

test('宿主没有 Agent Teams 时静默跳过（返回 null，不抛错）', () => {
  const { ctx, deps, registered } = makeCtx({ withTeams: false })
  const result = registerTeamRoleTool(ctx, { ...deps, registry: registry([]) })
  assert.equal(result, null)
  assert.equal(registered.length, 0, '不应注册任何工具')
})

test('ctx.tools.register 不可用时返回 null', () => {
  assert.equal(registerTeamRoleTool({}, { registry: registry([]) }), null)
  assert.equal(registerTeamRoleTool(null, { registry: registry([]) }), null)
})

test('registry 不可用时返回 null', () => {
  const { ctx } = makeCtx()
  assert.equal(registerTeamRoleTool(ctx, {}), null)
  assert.equal(registerTeamRoleTool(ctx, { registry: {} }), null)
})

test('正常路径：建成员并把路由切到角色的 llmProvider/llmModel', async () => {
  /** @type {any[]} */
  const selections = []
  const agent = { model: { select: (s) => selections.push(s) } }
  const { ctx, deps, registered } = makeCtx({ agentFor: () => agent })
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const tool = toolOf(registered)

  const out = await tool.execute(
    { role: '沙僧', description: '清理契约', prompt: '做点事' },
    { agent: { id: 'lead' }, signal: undefined },
  )

  assert.equal(out.ok, true)
  assert.equal(out.role, '沙僧')
  assert.equal(out.name, 'shaseng', '中文角色名应映射成拼音成员名')
  assert.equal(out.childId, 'child-shaseng')
  assert.equal(out.model.applied, true)
  assert.equal(out.model.provider, 'workbuddy')
  assert.equal(out.model.model, 'deepseek-v4.1-flash')
  assert.equal(out.model.reasoningEffort, 'high')
  assert.deepEqual(selections, [
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  ])
})

test('role 可用拼音 / 别名 / roleId 命中', async () => {
  for (const input of ['shaseng', 'sha', 'role-shaseng', '沙僧']) {
    const agent = { model: { select: () => {} } }
    const { ctx, deps, registered } = makeCtx({ agentFor: () => agent })
    registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
    const out = await toolOf(registered).execute(
      { role: input, description: 'd', prompt: 'p' },
      { agent: { id: 'lead' } },
    )
    assert.equal(out.ok, true, `「${input}」应能命中角色`)
    assert.equal(out.role, '沙僧')
  }
})

test('找不到角色时不建成员', async () => {
  /** @type {any[]} */
  const spawns = []
  const { ctx, deps, registered } = makeCtx()
  deps.agentTeams.spawnTeammate = async (_p, req) => {
    spawns.push(req)
    return { member: { id: 'x', name: req.name } }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const out = await toolOf(registered).execute(
    { role: '牛魔王', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(out.ok, false)
  assert.match(out.error, /ROLE_NOT_FOUND/)
  assert.match(out.error, /沙僧/, '错误里应列出可用角色')
  assert.equal(spawns.length, 0, '解析失败绝不能建成员')
})

test('角色绑定外部 CLI 通道时拒绝且不建成员', async () => {
  const acpRole = {
    roleId: 'role-tangseng',
    name: '唐僧',
    channel: { channelId: 'ch-acp-kimi', kind: 'acp-cli', provider: 'acp-kimi' },
  }
  /** @type {any[]} */
  const spawns = []
  const { ctx, deps, registered } = makeCtx()
  deps.agentTeams.spawnTeammate = async (_p, req) => {
    spawns.push(req)
    return { member: { id: 'x', name: req.name } }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([acpRole]) })
  const out = await toolOf(registered).execute(
    { role: '唐僧', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(out.ok, false)
  assert.match(out.error, /NO_ROUTE/)
  assert.match(out.error, /只能跑进程内通道/)
  assert.equal(spawns.length, 0, '拿不到路由绝不能建成员')
})

test('缺少 role 参数时拒绝', async () => {
  const { ctx, deps, registered } = makeCtx()
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const tool = toolOf(registered)
  for (const args of [{}, { role: '' }, { role: '   ' }, undefined]) {
    const out = await tool.execute(args, { agent: { id: 'lead' } })
    assert.equal(out.ok, false)
    assert.match(out.error, /ROLE_REQUIRED/)
  }
})

test('成员建成但拿不到 Agent 时，保留成员并如实报告未切换', async () => {
  const { ctx, deps, registered } = makeCtx({ agentFor: () => undefined })
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const out = await toolOf(registered).execute(
    { role: '沙僧', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(out.ok, true, '成员已建成，整体不算失败')
  assert.equal(out.model.applied, false)
  assert.match(out.note, /拿不到它的 Agent/)
  assert.equal(out.childId, 'child-shaseng', '必须回传 childId，否则成员成了孤儿')
})

test('成员建成但路由写入失败时，保留成员并给出原因', async () => {
  const agent = {
    model: {
      select: () => {
        throw new Error('select boom')
      },
    },
  }
  const { ctx, deps, registered } = makeCtx({ agentFor: () => agent })
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const out = await toolOf(registered).execute(
    { role: '沙僧', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(out.ok, true)
  assert.equal(out.model.applied, false)
  assert.match(out.note, /select boom/)
})

test('spawnTeammate 抛错时转成失败结果，不往外抛', async () => {
  const { ctx, deps, registered } = makeCtx()
  deps.agentTeams.spawnTeammate = async () => {
    throw new Error('quota exceeded')
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const out = await toolOf(registered).execute(
    { role: '沙僧', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(out.ok, false)
  assert.match(out.error, /SPAWN_FAILED/)
  assert.match(out.error, /quota exceeded/)
})

test('拿不到调用方 Agent 时拒绝，不建成员', async () => {
  /** @type {any[]} */
  const spawns = []
  const { ctx, deps, registered } = makeCtx()
  deps.agentTeams.spawnTeammate = async (_p, req) => {
    spawns.push(req)
    return { member: { id: 'x', name: req.name } }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const out = await toolOf(registered).execute({ role: '沙僧', description: 'd', prompt: 'p' }, {})
  assert.equal(out.ok, false)
  assert.match(out.error, /NO_AGENT/)
  assert.equal(spawns.length, 0)
})

test('显式 name 优先于角色推导', async () => {
  const agent = { model: { select: () => {} } }
  const { ctx, deps, registered } = makeCtx({ agentFor: () => agent })
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const out = await toolOf(registered).execute(
    { role: '沙僧', name: 'cleanup-bot', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(out.ok, true)
  assert.equal(out.name, 'cleanup-bot')
  assert.equal(out.childId, 'child-cleanup-bot')
})

test('非法 name（含 lead / 大写）被拒绝且不建成员', async () => {
  /** @type {any[]} */
  const spawns = []
  const { ctx, deps, registered } = makeCtx()
  deps.agentTeams.spawnTeammate = async (_p, req) => {
    spawns.push(req)
    return { member: { id: 'x', name: req.name } }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const tool = toolOf(registered)
  for (const bad of ['lead', 'Shaseng', 'sha_seng', '-bad']) {
    const out = await tool.execute({ role: '沙僧', name: bad, description: 'd', prompt: 'p' }, { agent: { id: 'lead' } })
    assert.equal(out.ok, false, `「${bad}」应被拒绝`)
    assert.match(out.error, /INVALID_NAME/)
  }
  assert.equal(spawns.length, 0, '名字非法时绝不能建成员（名字不可回收）')
})

test('provider 固定传 spawn（teammate 必须跑进程内）', async () => {
  /** @type {any[]} */
  const spawns = []
  const agent = { model: { select: () => {} } }
  const { ctx, deps, registered } = makeCtx({ agentFor: () => agent })
  deps.agentTeams.spawnTeammate = async (_p, req) => {
    spawns.push(req)
    return { member: { id: `child-${req.name}`, name: req.name } }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  await toolOf(registered).execute({ role: '沙僧', description: 'd', prompt: 'p' }, { agent: { id: 'lead' } })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].provider, 'spawn')
  assert.equal(spawns[0].context, 'fresh', '默认 fresh')
  assert.deepEqual(spawns[0].prompt, [{ type: 'text', text: 'p' }])
})

test('显式 context=fork 透传', async () => {
  /** @type {any[]} */
  const spawns = []
  const agent = { model: { select: () => {} } }
  const { ctx, deps, registered } = makeCtx({ agentFor: () => agent })
  deps.agentTeams.spawnTeammate = async (_p, req) => {
    spawns.push(req)
    return { member: { id: `child-${req.name}`, name: req.name } }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  await toolOf(registered).execute(
    { role: '沙僧', context: 'fork', description: 'd', prompt: 'p' },
    { agent: { id: 'lead' } },
  )
  assert.equal(spawns[0].context, 'fork')
})

test('注册的工具描述与参数形状可被模型理解', () => {
  const { ctx, deps, registered } = makeCtx()
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]) })
  const tool = toolOf(registered)
  assert.equal(tool.name, 'spawn_teammate_as')
  assert.ok(tool.description.length > 50, '描述要有实质内容')
  assert.match(tool.description, /role/, '描述要点出 role 参数')
  assert.ok(tool.parameters, '必须有参数字典')
  for (const key of ['role', 'description', 'prompt']) {
    assert.equal(tool.parameters[key]?.required, true, `${key} 应为必填`)
  }
  assert.equal(tool.parameters.name?.required, undefined, 'name 应为可选')
  assert.deepEqual(tool.parameters.context?.enum, ['fresh', 'fork'])
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, true, 'output schema 必须 object 根 + additionalProperties')
  assert.equal(typeof tool.output.render, 'function')
})

test('注入 defineTool 时用它包装（走宿主 args 校验）', () => {
  const { ctx, deps, registered } = makeCtx()
  let wrapped = null
  const defineTool = (spec) => {
    wrapped = spec
    return { ...spec, __wrapped: true }
  }
  registerTeamRoleTool(ctx, { ...deps, registry: registry([IN_PROCESS_ROLE]), defineTool })
  assert.ok(wrapped, 'defineTool 应被调用')
  assert.equal(wrapped.name, 'spawn_teammate_as')
  assert.equal(registered[0].__wrapped, true, '注册的应是 defineTool 的返回值')
})

test('反证：必须用注入的 agentTeams，不得把 ctx.agentTeams 当主路径', async () => {
  const { readFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'src', 'dsh', 'team-tool.js'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')
  // 只在 deps 缺失时允许一次兜底，不允许把它当主路径。
  const hits = code.match(/ctx\.agentTeams/g) ?? []
  assert.ok(hits.length <= 1, 'ctx.agentTeams 只允许作为一次兜底，实际出现 ' + hits.length + ' 次')
  assert.match(code, /const teams = agentTeams/, '应以注入的 agentTeams 为主')
})

test('反证：注册目标必须是 agent.ctx，且只给 Lead 装', async () => {
  const { readFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = await readFile(join(here, '..', 'src', 'index.js'), 'utf8')
  // 宿主 install() 用的是 agent.ctx；接线处也必须传 agent.ctx，否则模型看不到工具。
  assert.match(source, /registerTeamRoleTool\(\s*agent\.ctx/, '必须把 agent.ctx 传给 registerTeamRoleTool')
  assert.match(source, /tryMembership\(agent\)/, '必须用 tryMembership 判断 Lead')
  assert.match(source, /role !== 'lead'/, '必须显式过滤非 Lead')
})
