// @ts-check
/**
 * 五人角色模板（P0-S1）单元测试。
 *
 * 覆盖：固定五人/职责、不绑定 CLI 或模型、宿主能力不可得时标「待配置」、
 * 不覆盖用户已有角色、派生状态不伪造 ready、配置化时能剥掉派生标记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FIVE_ROLE_IDS,
  FIVE_ROLE_TEMPLATE,
  TEMPLATE_PENDING_LABEL,
  TEMPLATE_PENDING_REASON,
  TEMPLATE_SETUP,
  createTemplateRoles,
  normalizeHostCapability,
  seedFiveRoleTemplate,
  toConfigRoles,
} from '../src/roles/template.js'
import { createRegistry } from '../src/roles/registry.js'
import { isValidRoleId } from '../src/roles/ids.js'
import { deriveRoleView } from '../src/gui/state-model.js'
import { fieldSource, resolveEffectiveConfig } from '../src/session/config.js'

test('固定五人：ID、姓名、职责完整且顺序稳定', () => {
  assert.deepEqual(FIVE_ROLE_IDS, [
    'role-tangtang',
    'role-wukong',
    'role-bajie',
    'role-sashi',
    'role-xiaobai',
  ])
  assert.deepEqual(
    FIVE_ROLE_TEMPLATE.map((role) => [role.roleId, role.name, role.duty]),
    [
      ['role-tangtang', '唐僧', '架构、战略、关键决策、最终质量把关'],
      ['role-wukong', '悟空', '疑难问题、审核验收、长时间 Agent 任务'],
      ['role-bajie', '八戒', '调度、监工、整合（主 Agent 本体，不参与派单）'],
      ['role-sashi', '沙僧', '主力开发、苦工、各类实现任务'],
      ['role-xiaobai', '小白', '打杂、辅助、杂项实现'],
    ],
  )
  assert.ok(Object.isFrozen(FIVE_ROLE_TEMPLATE), '模板数组必须冻结')
  for (const role of FIVE_ROLE_TEMPLATE) {
    assert.ok(Object.isFrozen(role), `模板角色 ${role.roleId} 必须冻结`)
    assert.ok(isValidRoleId(role.roleId), `roleId 必须合法：${role.roleId}`)
    assert.ok(role.description.length > 0, '每个角色都要有可读职责说明')
  }
})

test('模板不绑定外部 CLI、provider、通道或具体模型', () => {
  for (const role of FIVE_ROLE_TEMPLATE) {
    for (const forbidden of ['channel', 'channelId', 'provider', 'cli', 'model', 'reasoning', 'enabled']) {
      assert.equal(Object.hasOwn(role, forbidden), false, `${role.name} 不应绑定 ${forbidden}`)
    }
  }
  // 别名只在模板内部唯一，交给注册表时不得互相冲突
  const aliases = FIVE_ROLE_TEMPLATE.flatMap((role) => [role.name, ...role.aliases])
  assert.equal(new Set(aliases).size, aliases.length, '模板内姓名/别名不得重复')
})

test('宿主能力不可得：五个角色都标「待配置」，绝不 ready', () => {
  const cases = [
    [undefined, TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNKNOWN],
    ['unknown', TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNKNOWN],
    ['unavailable', TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNAVAILABLE],
    [false, TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNAVAILABLE],
  ]
  for (const [hostCapability, expectedReason] of cases) {
    const roles = createTemplateRoles({ hostCapability })
    assert.equal(roles.length, 5)
    for (const role of roles) {
      assert.equal(role.setupState, TEMPLATE_SETUP.PENDING)
      assert.equal(role.setupLabel, TEMPLATE_PENDING_LABEL)
      assert.notEqual(role.setupState, 'ready')
      assert.equal(role.setupReason, expectedReason)
      const view = deriveRoleView(role)
      assert.notEqual(view.readiness, 'ready')
      assert.equal(view.color, 'gray')
      assert.equal(view.availability, 'unknown')
    }
  }

  // 明确不可用与未知区分原因，但仍是待配置
  const unavailable = createTemplateRoles({ hostCapability: false })
  assert.equal(unavailable[0].setupReason, TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNAVAILABLE)

  // 宿主能力可用，但模板本身没选通道 -> 仍待配置
  const capable = createTemplateRoles({ hostCapability: true })
  for (const role of capable) {
    assert.equal(role.setupState, TEMPLATE_SETUP.PENDING)
    assert.equal(role.setupReason, TEMPLATE_PENDING_REASON.CHANNEL_NOT_CONFIGURED)
  }

  assert.equal(normalizeHostCapability(true), 'available')
  assert.equal(normalizeHostCapability('unavailable'), 'unavailable')
  assert.equal(normalizeHostCapability({ available: false }), 'unavailable')
  assert.equal(normalizeHostCapability('bogus'), 'unknown')
})

test('初始化补缺失角色，不覆盖用户已有角色，也不改入参', () => {
  const existing = [
    {
      roleId: 'role-sashi',
      name: '沙僧（我的改法）',
      description: '用户自定义职责',
      enabled: false,
      channel: { kind: 'codex', provider: 'codex', model: 'my-model' },
    },
    { roleId: 'role-custom', name: '自定义' },
  ]
  const before = JSON.stringify(existing)
  const result = seedFiveRoleTemplate(existing, { hostCapability: 'unknown' })

  assert.equal(result.added.length, 4, '只补缺失的四个')
  assert.deepEqual(
    result.added.map((role) => role.roleId),
    ['role-tangtang', 'role-wukong', 'role-bajie', 'role-xiaobai'],
  )
  assert.deepEqual(result.pending.map((item) => item.roleId), result.added.map((role) => role.roleId))
  assert.equal(result.roles.length, 6)
  const kept = result.roles.find((role) => role.roleId === 'role-sashi')
  assert.equal(kept.name, '沙僧（我的改法）', '已有角色不得被模板覆盖')
  assert.equal(kept.enabled, false)
  assert.equal(JSON.stringify(existing), before, '初始化不得修改传入数组/对象')

  // 五个都在时不重复追加
  const all = seedFiveRoleTemplate(FIVE_ROLE_TEMPLATE, { hostCapability: true })
  assert.equal(all.added.length, 0)
  assert.deepEqual(all.pending, [])
})

test('模板角色可被注册表接受；默认 enabled 不算显式偏好', () => {
  const templateRoles = createTemplateRoles({ hostCapability: true })
  const registry = createRegistry({ globalRoles: templateRoles })
  assert.deepEqual(registry.errors, [], '模板不得自带别名/ID 冲突')
  assert.equal(registry.list().length, 5)
  assert.equal(registry.list()[0].enabled, true, '注册表按默认启用')

  const resolved = resolveEffectiveConfig({
    global: { roles: templateRoles },
    globalRaw: { roles: templateRoles },
  })
  const sashi = resolved.effective.roles.find((role) => role.roleId === 'role-sashi')
  assert.equal(fieldSource(resolved.sources, 'role-sashi', 'enabled'), 'default')
  const view = deriveRoleView(sashi, { sources: resolved.sources })
  assert.equal(view.userPreference, 'unset', '模板默认启用不等于用户偏好')
})

test('派生标记可剥离：写盘前只留角色配置字段', () => {
  const roles = createTemplateRoles({ hostCapability: false })
  const configRoles = toConfigRoles(roles)
  assert.equal(configRoles.length, 5)
  for (const role of configRoles) {
    assert.equal(Object.hasOwn(role, 'setupState'), false)
    assert.equal(Object.hasOwn(role, 'setupLabel'), false)
    assert.equal(Object.hasOwn(role, 'setupReason'), false)
    assert.equal(Object.hasOwn(role, 'duty'), true, 'duty 是模板职责说明，可保留')
  }
  // 剥掉标记后仍是合法角色配置
  const registry = createRegistry({ globalRoles: configRoles })
  assert.deepEqual(registry.errors, [])
})
