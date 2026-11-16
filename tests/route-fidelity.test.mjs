// @ts-check
/**
 * 回归测试（2026-11-16 外部审查 F1/F2）：
 *
 * - F1：非进程内 provider 的模型固定在配置行上，声明 model 与 provider 固定 model
 *   不一致时必须拒绝，绝不静默跑成另一个模型。
 *   （已由 tests/dsh-adapter.test.mjs 的 [F1] 用例覆盖，这里补共享路由一致性。）
 *
 * - F2：roleAvailability 必须与真实派单走同一个路由解析（resolveRoleRoute），
 *   不能各算各的。典型故障：channels 把角色映射到 codex-b（已注册），
 *   旧实现却用 providerNameFor 查 codex（不存在）报 provider-unavailable，
 *   出现「能派但报不可用」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDshAdapter,
  providerNameFor,
  resolveRoleRoute,
} from '../src/dsh/adapter.js'
import { roleAvailability } from '../src/dsh/register.js'

function fakeCtx(providerNames) {
  const providers = new Map()
  for (const name of providerNames) {
    providers.set(name, {
      name,
      config: { providerName: name, model: 'model-B' },
      capabilities: {},
      start() {},
    })
  }
  return {
    subagents: {
      getProvider: (n) => providers.get(n),
      startActivation: async (spec) => ({ childId: 'fake', provider: spec.provider }),
    },
  }
}

test('[F2] channels 映射到已注册 provider：roleAvailability 报 available（与派单同源）', () => {
  // 角色只声明 kind+model，不写 provider；channels 把它映射到 codex-b。
  const role = {
    roleId: 'role-x',
    name: 'X',
    enabled: true,
    channel: { kind: 'codex', model: 'model-B', reasoning: 'high' },
  }
  const channels = [
    { channelId: 'b', kind: 'codex', provider: 'codex-b', model: 'model-B', reasoning: 'high' },
  ]
  const ctx = fakeCtx(['codex-b']) // 只注册 codex-b，没有 codex

  // 旧口径：providerNameFor 会回退到 kind 默认 'codex' → 查不到 → provider-unavailable
  assert.equal(providerNameFor(role), 'codex', '旧口径回退到 kind 默认 provider')

  // 新口径：共享路由解析命中 channels 的 codex-b
  const route = resolveRoleRoute(role, channels)
  assert.equal(route.provider, 'codex-b')
  assert.equal(route.source, 'capability')

  // roleAvailability 必须用新口径 → available
  assert.equal(
    roleAvailability(role, ctx, channels),
    'available',
    'channels 映射的 provider 已注册，应报 available（不能因旧口径报不可用）',
  )
})

test('[F2] 不传 channels 时退回角色声明（兼容旧路径）', () => {
  const role = {
    roleId: 'role-x',
    name: 'X',
    enabled: true,
    channel: { kind: 'codex', provider: 'codex-b', model: 'model-B' },
  }
  const ctx = fakeCtx(['codex-b'])
  assert.equal(roleAvailability(role, ctx, []), 'available')
  // 未注册该 provider → provider-unavailable
  const emptyCtx = { subagents: { getProvider: () => undefined } }
  assert.equal(roleAvailability(role, emptyCtx), 'provider-unavailable')
  // 完全没有 getProvider 能力 → unknown（不猜）
  assert.equal(roleAvailability(role, {}), 'unknown')
})

test('[F2] 路由解析失败（CHANNEL_AMBIGUOUS）如实报不可用，不猜', () => {
  const role = {
    roleId: 'role-x',
    name: 'X',
    enabled: true,
    channel: { kind: 'codex', model: 'model-B' },
  }
  const channels = [
    { channelId: 'b1', kind: 'codex', provider: 'codex-b', model: 'model-B' },
    { channelId: 'b2', kind: 'codex', provider: 'codex-c', model: 'model-B' },
  ]
  const ctx = fakeCtx(['codex-b', 'codex-c'])
  assert.throws(() => resolveRoleRoute(role, channels), /CHANNEL_AMBIGUOUS/)
  assert.equal(
    roleAvailability(role, ctx, channels),
    'provider-unavailable',
    '多义时如实报不可用，交给用户消歧',
  )
})

test('[F1 复核] 角色声明 kind 与 channelId 实例 kind 不一致 → 拒绝（堵住绕过）', async () => {
  // 复核发现的绕过：角色声明 kind=in-process 但 channelId 指向 codex 实例。
  // 之前合并顺序写反（声明覆盖实例），F1 看 in-process 跳过校验，
  // 但 buildChildAgentOptions 用实例 kind=codex 返回 {}，静默跑固定模型。
  const codexProvider = {
    name: 'codex',
    config: { model: 'model-A' },
    capabilities: {},
    start() {},
  }
  const { calls, ctx } = (() => {
    const calls = []
    return {
      calls,
      ctx: {
        subagents: {
          getProvider: (n) => (n === 'codex' ? codexProvider : undefined),
          startActivation: async (spec) => {
            calls.push(spec)
            return { childId: 'fake', provider: spec.provider }
          },
        },
      },
    }
  })()
  const channels = [{ channelId: 'c', kind: 'codex', provider: 'codex', model: 'model-B' }]
  const adapter = createDshAdapter(ctx, { channels, roles: [] })
  await assert.rejects(
    () =>
      adapter.start({
        role: {
          roleId: 'x', name: 'X', enabled: true,
          channel: { channelId: 'c', kind: 'in-process', provider: 'codex', model: 'model-B' },
        },
        task: 'x',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone', agent: { id: 'p1' } },
      }),
    /CHANNEL_MISMATCH/,
    '声明 kind 与实例 kind 冲突必须拒绝',
  )
  assert.equal(calls.length, 0, '不得启动')
})

test('[F1] 无 channelId、声明 model 无实例支持 → 启动层拒绝（不静默回退到 provider 固定模型）', async () => {
  // channels 里只有 gpt-6-astra，角色声明 gpt-6.1-sol 且无 channelId。
  // matchByCapability 找不到候选会 fallback 到 codex provider，但 start() 的 F1
  // 校验会核对 provider.config.model=astra ≠ 声明 sol → 拒绝，不静默跑错模型。
  const codexProvider = { name: 'codex', config: { model: 'gpt-6-astra' }, capabilities: {}, start() {} }
  const calls = []
  const ctx = {
    subagents: {
      getProvider: (n) => (n === 'codex' ? codexProvider : undefined),
      startActivation: async (spec) => {
        calls.push(spec)
        return { childId: 'fake', provider: spec.provider }
      },
    },
  }
  const channels = [{ channelId: 'a', kind: 'codex', provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' }]
  const adapter = createDshAdapter(ctx, { channels, roles: [] })
  await assert.rejects(
    () =>
      adapter.start({
        role: {
          roleId: 'x', name: 'X', enabled: true,
          channel: { kind: 'codex', model: 'gpt-6.1-sol', reasoning: 'high' },
        },
        task: 'x',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone', agent: { id: 'p1' } },
      }),
    /MODEL_MISMATCH/,
    '声明的 model 无实例支持时不能静默跑成 provider 固定模型',
  )
  assert.equal(calls.length, 0, '不得启动')
})

test('[F1 复核 v2] 实例缺省 model、角色声明 model-B、provider 固定 model-A → 拒绝', async () => {
  // 悟空最终复核发现的绕过：config.js 里实例 model 非必填。当实例没写 model 时：
  // - route 合并后 role.channel.model 保留角色的 model-B；
  // - 若 F1 从原始 route.instance.model 取会得到空串 → 跳过校验 → 静默跑固定 model-A。
  // 正确做法：model 从合并后的 effectiveRole.channel.model 取（保留角色意图）。
  const codexProvider = { name: 'codex', config: { model: 'model-A' }, capabilities: {}, start() {} }
  const calls = []
  const ctx = {
    subagents: {
      getProvider: (n) => (n === 'codex' ? codexProvider : undefined),
      startActivation: async (spec) => {
        calls.push(spec)
        return { childId: 'fake', provider: spec.provider }
      },
    },
  }
  // 实例缺省 model（合法配置）
  const channels = [{ channelId: 'c', kind: 'codex', provider: 'codex', reasoning: 'high' }]
  const adapter = createDshAdapter(ctx, { channels, roles: [] })
  for (const channel of [
    { channelId: 'c', kind: 'codex', provider: 'codex', model: 'model-B', reasoning: 'high' }, // channelId 分支
    { kind: 'codex', provider: 'codex', model: 'model-B', reasoning: 'high' }, // 能力匹配分支
  ]) {
    calls.length = 0
    await assert.rejects(
      () =>
        adapter.start({
          role: { roleId: 'x', name: 'X', enabled: true, channel },
          task: 'x',
          timeoutMs: 0,
          context: { projectRoot: 'D:/MeetingStone', agent: { id: 'p1' } },
        }),
      /MODEL_MISMATCH/,
      '实例缺省 model 时仍要核对角色声明的 model 与 provider 固定 model',
    )
  }
  assert.equal(calls.length, 0, '不得启动')
})

test('[F1 复核] 角色 reasoning 与 channelId 实例不一致 → 拒绝', async () => {
  const codexProvider = { name: 'codex', config: { model: 'model-B' }, capabilities: {}, start() {} }
  const ctx = {
    subagents: {
      getProvider: (n) => (n === 'codex' ? codexProvider : undefined),
      startActivation: async (spec) => ({ childId: 'fake', provider: spec.provider }),
    },
  }
  const channels = [{ channelId: 'c', kind: 'codex', provider: 'codex', model: 'model-B', reasoning: 'high' }]
  const adapter = createDshAdapter(ctx, { channels, roles: [] })
  await assert.rejects(
    () =>
      adapter.start({
        role: {
          roleId: 'x', name: 'X', enabled: true,
          channel: { channelId: 'c', kind: 'codex', model: 'model-B', reasoning: 'low' },
        },
        task: 'x',
        timeoutMs: 0,
        context: { projectRoot: 'D:/MeetingStone', agent: { id: 'p1' } },
      }),
    /CHANNEL_MISMATCH/,
    '声明 reasoning 与实例冲突必须拒绝',
  )
})

test('[F1+F2] 共享路由：派单与可用性用同一个 provider', async () => {
  const role = {
    roleId: 'role-x',
    name: 'X',
    enabled: true,
    channel: { kind: 'codex', model: 'model-B', reasoning: 'high' },
  }
  const channels = [
    { channelId: 'b', kind: 'codex', provider: 'codex-b', model: 'model-B', reasoning: 'high' },
  ]
  const ctx = fakeCtx(['codex-b'])
  const calls = []
  ctx.subagents.startActivation = async (spec) => {
    calls.push(spec)
    return { childId: 'fake', provider: spec.provider }
  }

  const adapter = createDshAdapter(ctx, { channels, roles: [] })
  await adapter.start({
    role,
    task: 'x',
    timeoutMs: 0,
    context: { projectRoot: 'D:/MeetingStone', agent: { id: 'parent-1' } },
  })

  assert.equal(calls[0]?.provider, 'codex-b', '实际派单 provider')
  assert.equal(
    roleAvailability(role, ctx, channels),
    'available',
    '可用性报告必须与派单 provider 一致',
  )
})
