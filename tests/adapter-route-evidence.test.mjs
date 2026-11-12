// @ts-check
/**
 * `buildRunBase` 的路由证据测试。
 *
 * 背景（2026-11-12 路由矩阵缺口 2/3，悟空报告指出）：
 *
 * 1. **in-process 的 model 恒为 null** —— `buildRunBase` 只读 `role.channel.model`，
 *    但 in-process 通道的模型声明在 `llmModel`（见 `buildChildAgentOptions` 注释）。
 *    后果：明明派单时钉了 `workbuddy/deepseek-v4.1-flash`，run 记录里看不到，
 *    路由矩阵只能静态推断。
 *
 * 2. **reasoningEffort 全通道不落盘** —— 只能在配置里看，运行时不可观测。
 *
 * 本测试锁住修复：`model` 要同时认 `llmModel`，并新增 `llmProvider` / `reasoning`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRunBase } from '../src/dsh/adapter.js'

/** 造一个 in-process 角色（模型在 llmModel，不在 model）。 */
function inProcessRole(overrides = {}) {
  return {
    roleId: 'role-bajie',
    channel: {
      channelId: 'ch-inprocess',
      kind: 'in-process',
      provider: 'spawn',
      llmProvider: 'workbuddy',
      llmModel: 'deepseek-v4.1-flash',
      reasoning: 'high',
      ...overrides,
    },
  }
}

/** 造一个外部 CLI 角色（模型在 model）。 */
function acpRole(overrides = {}) {
  return {
    roleId: 'role-sashi',
    channel: {
      channelId: 'ch-acp-flash',
      kind: 'acp-cli',
      provider: 'acp',
      model: 'glm-5.3-flash',
      reasoning: 'high',
      ...overrides,
    },
  }
}

const START = 1700000000000
const base = (role, provider = 'spawn') =>
  buildRunBase({ input: {}, role, provider, childId: 'c1', startedAt: START })

test('in-process：model 从 llmModel 取（修复前恒为 null）', () => {
  const r = base(inProcessRole())
  assert.equal(r.model, 'deepseek-v4.1-flash', 'llmModel 必须落到 run 记录的 model')
  assert.equal(r.llmProvider, 'workbuddy', 'llmProvider 也要落盘（跑在哪个网关）')
  assert.equal(r.reasoning, 'high', 'reasoning 也要落盘')
})

test('外部 CLI：model 从 channel.model 取（原有行为不变）', () => {
  const r = base(acpRole(), 'acp')
  assert.equal(r.model, 'glm-5.3-flash')
  assert.equal(r.llmProvider, undefined, '外部 CLI 没有 llmProvider，不该编造')
  assert.equal(r.reasoning, 'high')
})

test('模型优先取 llmModel，其次 model（两者都有的极端情况）', () => {
  const role = {
    roleId: 'role-x',
    channel: { kind: 'in-process', llmProvider: 'p', llmModel: 'from-llm', model: 'from-model' },
  }
  assert.equal(base(role).model, 'from-llm', 'llmModel 优先（它是派单实际用的那个）')
})

test('channel 只有 model 时用 model（兼容旧配置）', () => {
  const role = { roleId: 'role-x', channel: { kind: 'acp-cli', provider: 'acp', model: 'm1' } }
  assert.equal(base(role, 'acp').model, 'm1')
})

test('没有模型信息时 model 为 null（不编造）', () => {
  const r = base({ roleId: 'role-x', channel: { kind: 'acp-cli', provider: 'acp' } }, 'acp')
  assert.equal(r.model, null)
  assert.equal(r.llmProvider, undefined)
  assert.equal(r.reasoning, undefined)
})

test('空字符串 / 纯空白不算有效模型', () => {
  for (const bad of ['', '   ', '\t\n']) {
    const r = base({ roleId: 'r', channel: { kind: 'in-process', llmModel: bad, model: bad } })
    assert.equal(r.model, null, `「${JSON.stringify(bad)}」应被视为没有模型`)
  }
})

test('角色没有 channel 时不崩、字段为 null', () => {
  const r = base(null)
  assert.equal(r.model, null)
  assert.equal(r.role, null)
  assert.equal(r.channel, null)
  assert.equal(r.llmProvider, undefined)
})

test('兼容性：provider / role / channel / status 等既有字段不受影响', () => {
  const r = base(inProcessRole())
  assert.equal(r.childId, 'c1')
  assert.equal(r.role, 'role-bajie')
  assert.equal(r.channel, 'in-process')
  assert.equal(r.provider, 'spawn')
  assert.equal(r.status, 'running')
  assert.equal(r.createdAt, START)
  assert.equal(r.startedAt, START)
})

test('可选字段：没有 reasoning 时不写这个键（不塞 undefined）', () => {
  const r = base(inProcessRole({ reasoning: undefined }))
  assert.equal('reasoning' in r, false, '没有值就不该有这个键')
  assert.equal('llmProvider' in r, true, 'llmProvider 有值就该在')
})
