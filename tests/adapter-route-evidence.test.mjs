// @ts-check
/**
 * `buildRunBase` 的生效路由证据测试。
 *
 * 背景（2026-11-12 路由矩阵缺口 2/3，悟空报告）：
 *
 * 1. **in-process 的 `model` 恒为 null** —— `buildRunBase` 只读 `role.channel.model`，
 *    但 in-process 通道的模型声明在 `llmModel`，**实际生效值在 `agentOptions` 里**。
 *    后果：明明派单时钉了 `workbuddy/deepseek-v4.1-flash`，记录里看不到，
 *    路由矩阵只能静态推断。
 *
 * 2. **`reasoningEffort` 全通道不落盘** —— 只能在配置里看，运行时不可观测。
 *
 * 修法（按悟空方案）：新增 `effectiveProvider` / `effectiveModel` / `reasoningEffort`
 * 三个字段，**`model` 原样保留不动**。
 *
 * 为什么不重载 `model`：它的历史语义是「通道声明的模型」，存量 100+ 条记录都按这个
 * 理解。改含义会让新旧记录无法直接对比，也说不清某条记录的 `model` 是声明值还是生效值。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRunBase } from '../src/dsh/adapter.js'

/** in-process 角色：模型声明在 llmModel，生效值在 agentOptions。 */
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

/** 外部 CLI 角色：模型声明在 model。 */
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
const base = (role, provider = 'spawn', agentOptions = undefined) =>
  buildRunBase({ input: {}, role, provider, childId: 'c1', startedAt: START, agentOptions })

test('in-process：effectiveModel 来自 agentOptions（这才是生效值）', () => {
  const r = base(inProcessRole(), 'spawn', {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  })
  assert.equal(r.effectiveModel, 'deepseek-v4.1-flash')
  assert.equal(r.effectiveProvider, 'workbuddy')
  assert.equal(r.reasoningEffort, 'high')
})

test('in-process：model 保持历史语义（通道声明的 model），不被重载', () => {
  const r = base(inProcessRole(), 'spawn', { model: 'deepseek-v4.1-flash' })
  // in-process 通道没有 channel.model，所以 model 仍是 null —— 这是历史语义
  assert.equal(r.model, null, 'model 只反映 channel.model，不反映生效值')
  assert.equal(r.effectiveModel, 'deepseek-v4.1-flash', '生效值在 effectiveModel')
})

test('外部 CLI：model 与 effectiveModel 都正确', () => {
  const r = base(acpRole(), 'acp', { model: 'glm-5.3-flash', reasoningEffort: 'high' })
  assert.equal(r.model, 'glm-5.3-flash', '历史字段：通道声明的模型')
  assert.equal(r.effectiveModel, 'glm-5.3-flash', '生效值同上（外部 CLI 模型由 provider 行承载）')
  assert.equal(r.effectiveProvider, null, '外部 CLI 没有宿主 LLM 覆盖，应显式 null')
  assert.equal(r.reasoningEffort, 'high')
})

test('effectiveModel 回退链：agentOptions > channel.model > channel.llmModel', () => {
  // 全都有 → agentOptions 优先
  const role = { roleId: 'r', channel: { kind: 'in-process', llmModel: 'from-llm', model: 'from-model' } }
  assert.equal(base(role, 'spawn', { model: 'from-agent' }).effectiveModel, 'from-agent')
  // 没有 agentOptions → channel.model
  assert.equal(base(role, 'spawn').effectiveModel, 'from-model')
  // 只有 llmModel → llmModel
  const onlyLlm = { roleId: 'r', channel: { kind: 'in-process', llmModel: 'only-llm' } }
  assert.equal(base(onlyLlm, 'spawn').effectiveModel, 'only-llm')
})

test('没有任何模型信息时三个字段都是 null（不编造）', () => {
  const r = base({ roleId: 'r', channel: { kind: 'acp-cli', provider: 'acp' } }, 'acp')
  assert.equal(r.model, null)
  assert.equal(r.effectiveProvider, null)
  assert.equal(r.effectiveModel, null)
  assert.equal(r.reasoningEffort, null)
})

test('空字符串 / 纯空白不算有效值', () => {
  for (const bad of ['', '   ', '\t\n']) {
    const r = base(
      { roleId: 'r', channel: { kind: 'in-process', llmModel: bad, model: bad, reasoning: bad } },
      'spawn',
      { provider: bad, model: bad, reasoningEffort: bad },
    )
    assert.equal(r.model, null, `model: ${JSON.stringify(bad)}`)
    assert.equal(r.effectiveModel, null, `effectiveModel: ${JSON.stringify(bad)}`)
    assert.equal(r.effectiveProvider, null)
    assert.equal(r.reasoningEffort, null)
  }
})

test('角色没有 channel 时不崩、字段为 null', () => {
  const r = base(null)
  assert.equal(r.model, null)
  assert.equal(r.effectiveModel, null)
  assert.equal(r.effectiveProvider, null)
  assert.equal(r.reasoningEffort, null)
  assert.equal(r.role, null)
  assert.equal(r.channel, null)
})

test('字段始终存在（不是 undefined），旧记录读侧才能统一 ?? null', () => {
  const r = base(acpRole(), 'acp')
  for (const key of ['effectiveProvider', 'effectiveModel', 'reasoningEffort']) {
    assert.ok(key in r, `${key} 必须始终存在（值可为 null）`)
    assert.notEqual(r[key], undefined, `${key} 不能是 undefined`)
  }
})

test('兼容性：既有字段语义完全不变', () => {
  const r = base(inProcessRole(), 'spawn')
  assert.equal(r.childId, 'c1')
  assert.equal(r.role, 'role-bajie')
  assert.equal(r.channel, 'in-process')
  assert.equal(r.provider, 'spawn', 'provider 仍是子进程协议')
  assert.equal(r.status, 'running')
  assert.equal(r.createdAt, START)
  assert.equal(r.startedAt, START)
})
