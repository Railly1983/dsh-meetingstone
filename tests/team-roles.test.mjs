// @ts-check
/**
 * `src/dsh/team-roles.js` 的单元测试。
 *
 * 覆盖三类风险：
 * 1. 名字映射 —— 中文角色名能否转成宿主认可的 lower-kebab-case；
 * 2. 路由解析 —— 哪些通道能/不能给 teammate 用，失败时必须给原因而不是静默；
 * 3. 路由写入 —— `agent.model.select` 优先、`session.append` 后备、两者都没有时如实失败。
 *
 * 特别加一条**反证测试**：确保 `agent/request` 覆写那条错路不会被重新引入。
 * 宿主 `dsh-agent-loop` 的 `prepareRequest()` 会断言 provider/model 不能被
 * `agent/request` 改动，所以模块里不应出现请求期钩子。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MEMBER_ROLE_NAMES,
  ROLE_MEMBER_NAMES,
  isMemberName,
  memberNameForRole,
  resolveSelection,
  selectAgentModel,
  writeModelSelection,
} from '../src/dsh/team-roles.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 宿主的 member name 校验规则（roster.js:10），测试独立复述一遍以便对照。 */
const HOST_MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

test('角色名映射：五个中文角色都有拼音 member name', () => {
  const expected = { 唐僧: 'tangseng', 悟空: 'wukong', 八戒: 'bajie', 沙僧: 'shaseng', 小白: 'xiaobai' }
  assert.deepEqual({ ...ROLE_MEMBER_NAMES }, expected)
  for (const [zh, en] of Object.entries(expected)) {
    assert.equal(memberNameForRole(zh), en, `中文名「${zh}」应映射为 ${en}`)
    assert.equal(MEMBER_ROLE_NAMES[en], zh, `${en} 应能反查回「${zh}」`)
  }
})

test('角色名映射：所有产出的名字都符合宿主 MEMBER_NAME 正则', () => {
  for (const zh of Object.keys(ROLE_MEMBER_NAMES)) {
    const name = memberNameForRole(zh)
    assert.match(name, HOST_MEMBER_NAME, `「${zh}」→「${name}」必须能通过宿主校验`)
    assert.ok(name.length <= 64)
    assert.notEqual(name, 'lead', '不得与 Lead 保留名冲突')
  }
})

test('角色名映射：已合法的 kebab 名原样返回', () => {
  assert.equal(memberNameForRole('shaseng'), 'shaseng')
  assert.equal(memberNameForRole('d1-verifier'), 'd1-verifier')
  assert.equal(memberNameForRole('  xiaobai  '), 'xiaobai', '首尾空白应被裁掉')
})

test('角色名映射：未登记的名字降级成 ascii，不抛异常', () => {
  // 用户直接写英文时不该报错；写未登记中文时尽力给出可用形态（可能为空）。
  assert.equal(memberNameForRole('Reviewer'), 'reviewer')
  assert.equal(memberNameForRole('code-review'), 'code-review')
  assert.equal(memberNameForRole(''), '')
  assert.equal(memberNameForRole(null), '')
  assert.equal(memberNameForRole(123), '')
  // 未登记的中文：不抛错，交给宿主校验去拒绝。
  assert.doesNotThrow(() => memberNameForRole('牛魔王'))
})

test('isMemberName：与宿主规则一致（含 lead 与长度）', () => {
  assert.equal(isMemberName('shaseng'), true)
  assert.equal(isMemberName('a-b-c'), true)
  assert.equal(isMemberName('lead'), false, 'lead 是保留名')
  assert.equal(isMemberName('Shaseng'), false, '大写不合法')
  assert.equal(isMemberName('sha_seng'), false, '下划线不合法')
  assert.equal(isMemberName('-abc'), false, '不能以连字符开头')
  assert.equal(isMemberName('a'.repeat(65)), false, '超过 64 字符')
  assert.equal(isMemberName(''), false)
})

test('resolveSelection：in-process 通道能解析出路由', () => {
  const role = {
    channel: {
      channelId: 'ch-inprocess',
      kind: 'in-process',
      llmProvider: 'workbuddy',
      llmModel: 'deepseek-v4.1-flash',
      reasoning: 'high',
    },
  }
  const { selection, reason } = resolveSelection(role)
  assert.equal(reason, undefined)
  assert.deepEqual(selection, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  })
})

test('resolveSelection：in-process 但没声明 llmModel 时如实拒绝并给原因', () => {
  const role = { channel: { channelId: 'ch-inprocess', kind: 'in-process', llmProvider: 'workbuddy' } }
  const { selection, reason } = resolveSelection(role)
  assert.equal(selection, undefined)
  assert.match(reason, /没有同时声明 llmProvider 与 llmModel/)
})

test('resolveSelection：外部 CLI 通道拒绝（teammate 跑宿主 LLM，不能挂外部进程）', () => {
  for (const kind of ['acp-cli', 'codex', 'claude-code']) {
    const role = { channel: { channelId: `ch-${kind}`, kind, provider: 'acp' } }
    const { selection, reason } = resolveSelection(role)
    assert.equal(selection, undefined, `${kind} 不应产出 selection`)
    assert.match(reason, /只能跑进程内通道/, `${kind} 的拒绝原因要说清楚`)
  }
})

test('resolveSelection：没有通道时如实拒绝', () => {
  for (const role of [undefined, null, {}, { channel: null }]) {
    const { selection, reason } = resolveSelection(role)
    assert.equal(selection, undefined)
    assert.ok(reason, '必须给原因，不能静默返回空')
  }
})

test('resolveSelection：instance 优先于 role.channel', () => {
  const role = { channel: { kind: 'acp-cli', provider: 'acp' } }
  const instance = { channelId: 'ch-inprocess', kind: 'in-process', llmProvider: 'p', llmModel: 'm' }
  const { selection } = resolveSelection(role, instance)
  assert.deepEqual(selection, { provider: 'p', model: 'm' })
})

test('selectAgentModel：优先走 agent.model.select', () => {
  /** @type {any[]} */
  const calls = []
  const agent = { model: { select: (s) => calls.push(s) } }
  const result = selectAgentModel(agent, { provider: 'workbuddy', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(result, { ok: true, via: 'agent.model.select' })
  assert.deepEqual(calls, [{ provider: 'workbuddy', model: 'm', reasoningEffort: 'high' }])
})

test('selectAgentModel：没有 reasoningEffort 时不塞这个字段', () => {
  /** @type {any[]} */
  const calls = []
  const agent = { model: { select: (s) => calls.push(s) } }
  selectAgentModel(agent, { provider: 'p', model: 'm' })
  assert.deepEqual(calls, [{ provider: 'p', model: 'm' }])
})

test('selectAgentModel：没有 model.select 时回退到 session.append', () => {
  /** @type {any[]} */
  const appends = []
  const agent = { session: { append: (type, data) => appends.push([type, data]) } }
  const result = selectAgentModel(agent, { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.deepEqual(result, { ok: true, via: 'session.append' })
  assert.deepEqual(appends, [['model/selection', { provider: 'p', model: 'm', reasoningEffort: 'low' }]])
})

test('selectAgentModel：两条路都不通时如实失败', () => {
  const result = selectAgentModel({}, { provider: 'p', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /拿不到 agent\.model\.select/)
})

test('selectAgentModel：selection 缺字段时拒绝', () => {
  const agent = { model: { select: () => {} } }
  for (const bad of [undefined, {}, { provider: 'p' }, { model: 'm' }]) {
    const result = selectAgentModel(agent, bad)
    assert.equal(result.ok, false)
    assert.match(result.reason, /缺少 provider 或 model/)
  }
})

test('selectAgentModel：agent.model.select 抛错时转成失败结果，不往外抛', () => {
  const agent = {
    model: {
      select: () => {
        throw new Error('boom')
      },
    },
  }
  const result = selectAgentModel(agent, { provider: 'p', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /boom/)
})

test('writeModelSelection：写入正确的 payload 形状', () => {
  /** @type {any[]} */
  const appends = []
  const session = { append: (type, data) => appends.push([type, data]) }
  const result = writeModelSelection(session, { provider: 'p', model: 'm' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(appends, [['model/selection', { provider: 'p', model: 'm' }]])
})

test('writeModelSelection：session 无效时如实失败', () => {
  for (const session of [undefined, null, {}, { append: 'not-fn' }]) {
    const result = writeModelSelection(session, { provider: 'p', model: 'm' })
    assert.equal(result.ok, false)
  }
})

test('writeModelSelection：append 抛错时兜住', () => {
  const session = {
    append: () => {
      throw new Error('append boom')
    },
  }
  const result = writeModelSelection(session, { provider: 'p', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /append boom/)
})

test('反证：可执行代码里不得出现 agent/request 覆写（宿主会断言拒绝）', async () => {
  const source = await readFile(join(HERE, '..', 'src', 'dsh', 'team-roles.js'), 'utf8')
  // 注释里必须保留这条路走不通的记录（那是给后来人看的），但**代码**里不能真的挂钩子。
  // 所以先剥掉注释再断言。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '') // 块注释
    .replace(/(^|[^:])\/\/.*$/gmu, '$1') // 行注释（避免误伤 https://）
  // 宿主 dsh-agent-loop 的 prepareRequest 会断言 provider/model 不被 request 改动，
  // 改了直接抛 "use agent.model.select() before step preparation"。
  assert.doesNotMatch(code, /agent\/request/, '代码里不得挂 agent/request 钩子覆写路由')
  assert.doesNotMatch(code, /\.waterfall\s*\(/, '不得用 waterfall 改模型路由')
  // 必须用宿主认可的方式。
  assert.match(code, /model\.select|model\/selection/, '必须走 agent.model.select 或 model/selection 事件')
  // 注释里仍要保留警告，避免后来人重新踩坑。
  assert.match(source, /agent\/request[\s\S]{0,400}use agent\.model\.select/, '注释应保留「这条路不通」的记录')
})
