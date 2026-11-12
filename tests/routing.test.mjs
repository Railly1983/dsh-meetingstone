// @ts-check
/**
 * P1-B：确定性角色路由 + 默认角色接线。
 *
 * 覆盖三层：
 * 1. `src/dispatch/routing.js` 纯规则（review/edit/research/architecture、优先级、可用性）
 * 2. `meetingstone_dispatch` 工具层（显式优先、ROLE_REQUIRED、回执 routing、兜底）
 * 3. 真实链路落盘（apply → dispatch → adapter → run-store，记录里能查到 reason）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import {
  DEFAULT_ROUTING_RULES,
  ROUTING_ERRORS,
  normalizeRoutingRules,
  routeTask,
} from '../src/dispatch/routing.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'
import { createRunStore } from '../src/run-store.js'
import { waitFor } from './helpers.mjs'

/** @param {Record<string, unknown>} [over] */
const role = (over = {}) => ({
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  description: '技术骨干：主力开发、苦工、实现',
  channel: { kind: 'in-process' },
  enabled: true,
  availability: 'available',
  ...over,
})

/** 贴近真实配置的四角色：领导 / 复核 / 主力 / 杂活。 */
const ROLES = [
  role({
    roleId: 'role-tangtang',
    name: '唐僧',
    aliases: ['TT', '领导'],
    description: '团队领导：架构、战略、关键决策、最终质量把关',
  }),
  role({
    roleId: 'role-wukong',
    name: '悟空',
    aliases: ['WK', '专家'],
    description: '核心资深专家：疑难问题、审核验收、长时间 Agent 任务',
  }),
  role({
    roleId: 'role-sashi',
    name: '沙僧',
    aliases: ['SS', '主力执行'],
    description: '技术骨干：主力开发、苦工、全能型',
  }),
  role({
    roleId: 'role-xiaobai',
    name: '小白',
    aliases: ['XB', '打杂'],
    description: '牛马：主力干活、文档、测试、调研',
  }),
]

/** @param {string} task @param {Partial<{ roles: any[], defaultRoleId: string, rules: any[] }>} [over] */
function route(task, over = {}) {
  return routeTask({
    task,
    roles: over.roles ?? ROLES,
    defaultRoleId: over.defaultRoleId,
    rules: over.rules,
  })
}

// ─── 1. 纯规则 ───────────────────────────────────────────────────────────────

test('review / edit / research / architecture 各命中对应角色', () => {
  const review = route('请审查登录鉴权实现')
  assert.equal(review.ok, true)
  assert.equal(review.roleId, 'role-wukong')
  assert.equal(review.taskType, 'review')
  assert.match(review.reason, /审查/)
  assert.match(review.reason, /role-wukong/)

  const edit = route('实现登录超时重试')
  assert.equal(edit.ok, true)
  assert.equal(edit.roleId, 'role-sashi')
  assert.equal(edit.taskType, 'edit')

  const research = route('调研现有鉴权方案')
  assert.equal(research.ok, true)
  assert.equal(research.roleId, 'role-xiaobai')
  assert.equal(research.taskType, 'research')

  const architecture = route('调整架构：拆分鉴权模块')
  assert.equal(architecture.ok, true)
  assert.equal(architecture.roleId, 'role-tangtang')
  assert.equal(architecture.taskType, 'architecture')
})

test('多类型关键词：以任务中首次出现的位置为准（不是固定类型优先级）', () => {
  const fixFirst = route('修复 review 指出的问题')
  assert.equal(fixFirst.ok, true)
  assert.equal(fixFirst.roleId, 'role-sashi', '修复在前 → 执行角色')
  assert.equal(fixFirst.taskType, 'edit')

  const reviewFirst = route('review 并修复登录问题')
  assert.equal(reviewFirst.ok, true)
  assert.equal(reviewFirst.roleId, 'role-wukong', 'review 在前 → 评审角色')
  assert.equal(reviewFirst.taskType, 'review')
})

test('角色描述很泛时：合并后的角色设定（含原 prompt）里的关键词作为兜底信号', () => {
  const scout = role({
    roleId: 'role-assistant',
    name: '助手',
    aliases: [],
    description: '通用助手，什么都会干',
    prompt: '负责调研、资料检索与长文分析，结论必须附证据。',
  })
  const res = route('调研现有鉴权方案', { roles: [scout] })
  assert.equal(res.ok, true)
  assert.equal(res.roleId, 'role-assistant')
  assert.match(res.reason, /角色设定含「调研」/)
})

test('只从 enabled 且 availability=available 的角色中选；不可用则回退 defaultRoleId', () => {
  const roles = [
    role({
      roleId: 'role-wukong',
      name: '悟空',
      aliases: ['WK'],
      description: '审核验收',
      availability: 'provider-unavailable',
    }),
    role({ roleId: 'role-sashi', name: '沙僧', aliases: ['SS'] }),
  ]
  const res = route('审查登录实现', { roles, defaultRoleId: 'role-sashi' })
  assert.equal(res.ok, true)
  assert.equal(res.roleId, 'role-sashi')
  assert.equal(res.source, 'default')
  assert.match(res.reason, /没有匹配到可用的评审角色/)
  assert.match(res.reason, /defaultRoleId/)

  // 停用角色同样不参与
  const disabled = route('审查登录实现', {
    roles: [
      role({ roleId: 'role-wukong', name: '悟空', enabled: false }),
      role({ roleId: 'role-sashi', name: '沙僧' }),
    ],
    defaultRoleId: 'role-sashi',
  })
  assert.equal(disabled.roleId, 'role-sashi')
})

test('没有任何可用角色 → AUTO_ROUTE_FAILED（不猜、不误派）', () => {
  const res = route('审查登录实现', {
    roles: [
      role({ roleId: 'role-wukong', name: '悟空', availability: 'unknown' }),
      role({ roleId: 'role-sashi', name: '沙僧', enabled: false }),
    ],
    defaultRoleId: 'role-sashi',
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, ROUTING_ERRORS.AUTO_ROUTE_FAILED)
  assert.match(res.message, /没有可参与自动路由的角色/)
})

test('未知任务类型：有 defaultRoleId 走兜底，没有则报错', () => {
  const fallback = route('hello there', { defaultRoleId: 'role-sashi' })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.roleId, 'role-sashi')
  assert.equal(fallback.source, 'default')
  assert.match(fallback.reason, /没有命中任务类型关键词/)

  const failed = route('hello there')
  assert.equal(failed.ok, false)
  assert.equal(failed.code, ROUTING_ERRORS.AUTO_ROUTE_FAILED)
  assert.match(failed.message, /defaultRoleId/)
})

test('defaultRoleId 只认 enabled+available 的角色；不可用时同样报错', () => {
  const res = route('审查登录实现', {
    roles: [role({ roleId: 'role-wukong', name: '悟空' })],
    defaultRoleId: 'role-sashi',
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, ROUTING_ERRORS.AUTO_ROUTE_FAILED)
  assert.match(res.message, /未配置或不可用/)
})

test('规则表可配置：自定义规则覆盖内置表', () => {
  const writer = role({
    roleId: 'role-writer',
    name: '文书',
    aliases: [],
    description: '文档撰写与整理',
  })
  const res = route('文档整理与校对', {
    roles: [writer],
    rules: [
      {
        taskType: 'docs',
        label: '文档',
        keywords: ['文档'],
        roleKeywords: ['文档'],
      },
    ],
  })
  assert.equal(res.ok, true)
  assert.equal(res.roleId, 'role-writer')
  assert.equal(res.taskType, 'docs')

  // 自定义表里没有 edit 规则 → 未知任务类型走 default，而不是偷偷用内置表
  const unknown = route('实现登录', {
    roles: [writer],
    defaultRoleId: 'role-writer',
    rules: [{ taskType: 'docs', label: '文档', keywords: ['文档'], roleKeywords: ['文档'] }],
  })
  assert.equal(unknown.ok, true)
  assert.equal(unknown.source, 'default')
})

test('规则的 roleIds 优先于 roleKeywords（显式钉死角色）', () => {
  const res = route('审查登录实现', {
    roles: ROLES,
    rules: [
      {
        taskType: 'review',
        label: '评审',
        keywords: ['审查'],
        roleKeywords: ['review', '审核'],
        roleIds: ['role-xiaobai'],
      },
    ],
  })
  assert.equal(res.ok, true)
  assert.equal(res.roleId, 'role-xiaobai', 'roleIds 指定的角色优先于关键词匹配')
  assert.match(res.reason, /roleIds/)
})

test('规则规范化：空/非法配置退回内置表，非法条目跳过', () => {
  assert.deepEqual(normalizeRoutingRules([]), normalizeRoutingRules(DEFAULT_ROUTING_RULES))
  const custom = normalizeRoutingRules([
    { taskType: '', keywords: ['x'] }, // 无 taskType → 跳过
    { taskType: 'docs', keywords: [] }, // 无关键词 → 跳过
    { taskType: 'docs', keywords: ['文档', ' 文档 '], roleKeywords: ['文档'] },
  ])
  assert.equal(custom.length, 1)
  assert.equal(custom[0].taskType, 'docs')
  assert.deepEqual(custom[0].keywords, ['文档'])
})

// ─── 2. 工具层（meetingstone_dispatch） ─────────────────────────────────────

/**
 * @param {any[]} roles
 * @param {{ defaultRoleId?: string, routingRules?: any[], unavailableProviders?: string[] }} [options]
 */
function makeHarness(roles, options = {}) {
  const registered = new Map()
  const calls = []
  const unavailable = new Set(options.unavailableProviders ?? [])
  const ctx = {
    subagents: {
      getProvider(name) {
        return name && !unavailable.has(name) ? { name } : undefined
      },
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
        return () => {}
      },
    },
  }
  const registry = {
    list: () => roles.map((item) => ({ ...item, aliases: [...(item.aliases ?? [])] })),
    resolve: (ref) => {
      const key = String(ref ?? '').trim().toLowerCase()
      return (
        roles.find(
          (item) =>
            String(item.roleId).toLowerCase() === key ||
            String(item.name).toLowerCase() === key ||
            (item.aliases ?? []).some((alias) => String(alias).toLowerCase() === key),
        ) ?? null
      )
    },
    errors: [],
  }
  const dispatcher = {
    async dispatch(input) {
      calls.push(input)
      const resolved = registry.resolve(input.role) ?? { roleId: input.role, name: input.role }
      return {
        ok: true,
        taskRef: { childId: `child-${calls.length}` },
        role: resolved,
        isolation: input.isolation ?? 'worktree',
        ...(input.routing ? { routing: input.routing } : {}),
      }
    },
  }
  registerTools(ctx, {
    registry,
    dispatcher,
    probe: { probe: async () => ({}), probeAll: async () => [] },
    ...(options.defaultRoleId ? { defaultRoleId: options.defaultRoleId } : {}),
    ...(options.routingRules ? { routingRules: options.routingRules } : {}),
  })
  return { tool: registered.get(TOOL_NAMES.DISPATCH), calls }
}

test('工具层：autoRoute=true 未指定 role → 按规则选角色，回执带 reason', async () => {
  const { tool, calls } = makeHarness(ROLES, { defaultRoleId: 'role-sashi' })
  const out = await tool.execute({ autoRoute: true, task: '审查登录鉴权实现' })
  assert.equal(out.ok, true)
  assert.equal(out.roleId, 'role-wukong')
  assert.equal(out.routing.auto, true)
  assert.equal(out.routing.roleId, 'role-wukong')
  assert.match(out.routing.reason, /审查/)
  assert.equal(calls[0].role, 'role-wukong')
  assert.deepEqual(calls[0].routing, out.routing)
})

test('工具层：显式 role 优先，autoRoute=true 也不路由', async () => {
  const { tool, calls } = makeHarness(ROLES, { defaultRoleId: 'role-sashi' })
  const out = await tool.execute({ role: 'SS', autoRoute: true, task: '审查登录实现' })
  assert.equal(out.ok, true)
  assert.equal(calls[0].role, 'SS', '显式角色原样交给 dispatcher')
  assert.deepEqual(out.routing, { roleId: 'role-sashi', auto: false })
  assert.equal(Object.hasOwn(out.routing, 'reason'), false, '手动指定不写 reason')
})

test('工具层：未指定 role 且未开 autoRoute → ROLE_REQUIRED（不触达 dispatcher）', async () => {
  const { tool, calls } = makeHarness(ROLES)
  const missing = await tool.execute({ task: '审查登录实现' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'ROLE_REQUIRED')
  const off = await tool.execute({ task: '审查登录实现', autoRoute: false })
  assert.equal(off.code, 'ROLE_REQUIRED')
  assert.equal(calls.length, 0)
})

test('工具层：未知任务类型走 defaultRoleId；没有可用角色报 AUTO_ROUTE_FAILED', async () => {
  const { tool } = makeHarness(ROLES, { defaultRoleId: 'role-sashi' })
  const out = await tool.execute({ autoRoute: true, task: 'hello there' })
  assert.equal(out.ok, true)
  assert.equal(out.roleId, 'role-sashi')
  assert.equal(out.routing.auto, true)
  assert.match(out.routing.reason, /defaultRoleId/)

  const unavailable = makeHarness(ROLES, {
    defaultRoleId: 'role-sashi',
    unavailableProviders: ['spawn'],
  })
  const failed = await unavailable.tool.execute({ autoRoute: true, task: '审查登录实现' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, ROUTING_ERRORS.AUTO_ROUTE_FAILED)
  assert.equal(unavailable.calls.length, 0)
})

test('工具层：自定义 routingRules 走配置表而不是内置表', async () => {
  const writer = role({
    roleId: 'role-writer',
    name: '文书',
    aliases: [],
    description: '文档撰写与整理',
  })
  const { tool } = makeHarness([writer], {
    routingRules: [
      { taskType: 'docs', label: '文档', keywords: ['文档'], roleKeywords: ['文档'] },
    ],
  })
  const out = await tool.execute({ autoRoute: true, task: '文档整理与校对' })
  assert.equal(out.ok, true)
  assert.equal(out.roleId, 'role-writer')
  assert.match(out.routing.reason, /文档/)
})

// ─── 3. 真实链路：reason 同时写进回执与落盘记录 ─────────────────────────────

test('真实链路：自动路由的 reason 同时出现在回执与 .meetingstone/runs 记录里', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-routing-chain-'))
  try {
    const tools = new Map()
    /** @type {Map<string, (value: any) => void>} */
    const pending = new Map()
    let serial = 0
    const ctx = {
      effect(fn) {
        fn()
      },
      tools: {
        register(tool) {
          tools.set(tool.name, tool)
          return () => {}
        },
      },
      logger: { info() {} },
      subagents: {
        getProvider(name) {
          return name === 'acp' || name === 'spawn' ? { name } : undefined
        },
        async startActivation() {
          const childId = `route-${++serial}`
          const result = new Promise((resolve) => pending.set(childId, resolve))
          return { childId, name: childId, result, async dispose() {} }
        },
      },
    }
    apply(ctx, {
      roles: [
        {
          roleId: 'role-reviewer',
          name: '审核员',
          aliases: ['RV'],
          description: '代码审查',
          channel: { kind: 'acp-cli', provider: 'acp' },
          enabled: true,
          timeoutMs: 0,
        },
        {
          roleId: 'role-sashi',
          name: '沙僧',
          aliases: ['SS'],
          description: '主力开发',
          channel: { kind: 'in-process' },
          enabled: true,
          timeoutMs: 0,
        },
      ],
      defaultRoleId: 'role-sashi',
      limits: { defaultIsolation: 'none' },
    })
    const exec = { agent: { session: { header: { cwd: root } } } }
    const dispatchTool = tools.get(TOOL_NAMES.DISPATCH)
    const store = createRunStore({ root })

    /** @param {Record<string, unknown>} args */
    async function run(args, text) {
      const reply = await dispatchTool.execute({ isolation: 'none', ...args }, exec)
      assert.equal(reply.ok, true, JSON.stringify(reply))
      const childId = reply.taskRef.childId
      pending.get(childId)?.({ stopReason: 'completed', output: [{ type: 'text', text }] })
      const record = await waitFor(async () => {
        const next = await store.loadRun(childId)
        return next?.status === 'completed' ? next : null
      })
      return { reply, record }
    }

    const auto = await run({ autoRoute: true, task: '请审查鉴权实现' }, 'PONG')
    assert.equal(auto.reply.routing.auto, true)
    assert.equal(auto.reply.routing.roleId, 'role-reviewer')
    assert.match(auto.reply.routing.reason, /审查/)
    assert.deepEqual(auto.record.routing, auto.reply.routing, '记录里的 routing 必须可解释')

    // 手动指定：记录里 auto:false 且不写 reason
    const manual = await run({ role: 'SS', task: '改一下登录' }, 'PONG')
    assert.deepEqual(manual.reply.routing, { roleId: 'role-sashi', auto: false })
    assert.deepEqual(manual.record.routing, { roleId: 'role-sashi', auto: false })
    assert.equal(Object.hasOwn(manual.record.routing, 'reason'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
