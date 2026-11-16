// @ts-check
/**
 * 默认角色（开箱即用）的契约测试。
 *
 * 2026-11-14 用户决策：装完插件不能是空角色表，否则用户不知道怎么用。
 * 但必须满足两条硬约束，否则就是回归：
 *   1. 用户配过角色（哪怕只有一个）→ 默认角色完全不介入，绝不覆盖
 *   2. 默认角色不绑定具体 CLI / 模型（跟随用户自己的会话默认设置）
 *
 * 每个断言都带负对照或反向用例，确保它真的会失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_IDS,
  defaultRolesFor,
  hasUserRoles,
  resolveEffectiveRoles,
} from '../src/roles/defaults.js'
import { createRegistry } from '../src/roles/registry.js'
import { deriveRoleView } from '../src/gui/state-model.js'
import { buildChildAgentOptions } from '../src/dsh/adapter.js'

test('空配置时给出默认角色（开箱即用）', () => {
  const roles = resolveEffectiveRoles([])
  assert.equal(roles.length, DEFAULT_ROLE_IDS.length)
  assert.deepEqual(
    roles.map((r) => r.roleId),
    [...DEFAULT_ROLE_IDS],
    'roleId 顺序稳定',
  )
  // 负对照：如果默认表是空的，上面的 length 断言会失败。
  assert.ok(roles.length >= 1, '默认角色表不得为空')
})

test('undefined / null / 非数组都当作「没有角色」，仍给默认值', () => {
  for (const value of [undefined, null, 'oops', 42, {}]) {
    assert.equal(hasUserRoles(value), false, `${String(value)} 不算用户角色`)
    assert.equal(resolveEffectiveRoles(value).length, DEFAULT_ROLE_IDS.length)
  }
})

test('**用户已有角色时，默认角色完全不介入**（核心约束）', () => {
  const user = [{ roleId: 'role-mine', name: '我的角色', channel: { kind: 'in-process' }, enabled: true }]
  const roles = resolveEffectiveRoles(user)
  assert.equal(roles.length, 1, '不得追加默认角色')
  assert.equal(roles[0].roleId, 'role-mine')
  // 负对照：若实现改成「合并」，这里会变成 4 个。
  assert.ok(
    !roles.some((r) => DEFAULT_ROLE_IDS.includes(r.roleId)),
    '用户配置里不得出现任何默认角色',
  )
})

test('用户只配了一个角色也算「已有」，不会被补到三个', () => {
  assert.equal(defaultRolesFor([{ roleId: 'role-only-one' }]).length, 0)
})

test('**默认角色不绑定 CLI / 模型**（跟随用户自己的默认设置）', () => {
  for (const role of DEFAULT_ROLES) {
    assert.equal(role.channel.kind, 'in-process', `${role.name} 走进程内子 Agent`)
    for (const key of ['provider', 'cli', 'model', 'reasoning', 'channelId', 'llmProvider', 'llmModel']) {
      assert.equal(
        Object.hasOwn(role.channel, key),
        false,
        `${role.name} 不得声明 ${key}（否则会覆盖用户的默认模型）`,
      )
    }
  }
})

test('默认角色不钉死模型路由：buildChildAgentOptions 返回空对象', () => {
  for (const role of DEFAULT_ROLES) {
    assert.deepEqual(
      buildChildAgentOptions(role, undefined),
      {},
      `${role.name} 应跟随用户会话路由，不得注入 agentOptions`,
    )
  }
  // 负对照：给同一个角色写上 llmProvider/llmModel 后，必须变成非空。
  const pinned = { ...DEFAULT_ROLES[0], channel: { kind: 'in-process', llmProvider: 'x', llmModel: 'y' } }
  assert.notDeepEqual(buildChildAgentOptions(pinned, undefined), {}, '钉了模型就必须返回 agentOptions')
})

test('默认角色能进注册表，且没有别名/ID 冲突', () => {
  const registry = createRegistry({ globalRoles: resolveEffectiveRoles([]) })
  assert.deepEqual(registry.errors, [], `默认角色不得产生注册错误：${JSON.stringify(registry.errors)}`)
  assert.equal(registry.list().length, DEFAULT_ROLE_IDS.length)
})

test('默认角色在 spawn 可用时判为 ready/绿色（能直接派单）', () => {
  const ctx = { sources: {}, subagents: { getProvider: (p) => (p === 'spawn' ? { name: 'spawn' } : null) } }
  for (const role of resolveEffectiveRoles([])) {
    const view = deriveRoleView(role, ctx)
    assert.equal(view.readiness, 'ready', `${role.name} 应可派单`)
    assert.equal(view.color, 'green')
  }
  // 负对照（2026-11-16 调整）：provider 不可用时 readiness 仍如实报 blocked，
  // 但**颜色不再是灰** —— 颜色只反映开关，能不能跑由派单结果反馈。
  const blocked = deriveRoleView(resolveEffectiveRoles([])[0], {
    sources: {},
    subagents: { getProvider: () => null },
  })
  assert.equal(blocked.readiness, 'blocked', '诊断如实保留')
  assert.equal(blocked.color, 'green', '已启用就是绿，不用灰点暗示不可用')
})

test('默认角色各自有可读的职责设定（不是空壳）', () => {
  for (const role of DEFAULT_ROLES) {
    assert.ok(role.name.length > 0, 'roleId ' + role.roleId + ' 缺 name')
    assert.ok(role.setting.length > 20, `${role.name} 的 setting 太短，用户看不出该角色干什么`)
    assert.ok(role.aliases.length > 0, `${role.name} 应有别名便于自然语言指派`)
  }
})

test('resolveEffectiveRoles 返回可变副本（改它不影响常量表）', () => {
  const first = resolveEffectiveRoles([])
  first[0].name = '被改坏了'
  first[0].aliases.push('脏数据')
  const second = resolveEffectiveRoles([])
  assert.notEqual(second[0].name, '被改坏了')
  assert.equal(second[0].aliases.length, DEFAULT_ROLES[0].aliases.length)
})
