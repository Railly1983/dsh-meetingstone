// @ts-check
/**
 * `src/session/config.js` 的 B3 语义测试。
 *
 * 背景（2026-11-12 产品体验复核抓到）：
 * 历史实现支持 global + project + session **三层**角色合并且代码仍然有效。
 * B3 决定「角色配置只有全局一层」，但当时只靠「src/index.js 不传 project」
 * 维持 —— 这是靠调用方纪律，不是代码保证。任何人加一个 `project:` 参数
 * 就会让项目覆盖悄悄生效，且不会有任何报错。
 *
 * 现在改为：主动剥掉项目/会话的角色字段 + 记录可诊断错误。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveEffectiveConfig } from '../src/session/config.js'

/** 一份最小的合法全局角色配置。 */
function globalWith(overrides = {}) {
  return {
    roles: [
      {
        roleId: 'role-a',
        name: 'Global',
        enabled: true,
        channel: { channelId: 'c1', kind: 'in-process', llmProvider: 'p', llmModel: 'm1' },
        ...overrides,
      },
    ],
  }
}

test('B3：只传 global 时正常产出角色', () => {
  const global = globalWith()
  const r = resolveEffectiveConfig({ global, globalRaw: { roles: global.roles } })
  assert.deepEqual(
    r.effective.roles.map((x) => x.name),
    ['Global'],
  )
  assert.equal(r.errors.length, 0)
})

test('B3：项目 roleOverrides 被忽略，并记录 PROJECT_ROLES_NOT_SUPPORTED', () => {
  const global = globalWith()
  const r = resolveEffectiveConfig({
    global,
    globalRaw: { roles: global.roles },
    project: { roleOverrides: { 'role-a': { name: 'Hacked' } } },
  })
  assert.deepEqual(
    r.effective.roles.map((x) => x.name),
    ['Global'],
    '项目覆盖必须被忽略，不能改到全局角色',
  )
  assert.ok(
    r.errors.some((e) => e.code === 'PROJECT_ROLES_NOT_SUPPORTED'),
    '必须记录可诊断的错误，而不是静默忽略',
  )
})

test('B3：项目 roles 也被忽略（名字不能被覆盖）', () => {
  const global = globalWith()
  const r = resolveEffectiveConfig({
    global,
    globalRaw: { roles: global.roles },
    project: {
      roles: [
        {
          roleId: 'role-a',
          name: 'ProjectWins',
          channel: { channelId: 'c1', kind: 'in-process', llmProvider: 'p', llmModel: 'm2' },
        },
      ],
    },
  })
  assert.deepEqual(
    r.effective.roles.map((x) => x.name),
    ['Global'],
    '项目声明的角色名不能覆盖全局',
  )
  // 规范化后的角色对象只保留 channel 的 kind/channelId（模型在通道配置里，不在角色对象上），
  // 所以这里断言 channelId 没被项目改写即可。
  assert.equal(r.effective.roles[0].channel.channelId, 'c1')
  assert.ok(r.errors.some((e) => e.code === 'PROJECT_ROLES_NOT_SUPPORTED'))
})

test('B3：会话配置被忽略，并记录 SESSION_ROLES_NOT_SUPPORTED', () => {
  const global = globalWith()
  const r = resolveEffectiveConfig({
    global,
    globalRaw: { roles: global.roles },
    session: { roleOverrides: { 'role-a': { name: 'SessionWins' } } },
  })
  assert.deepEqual(
    r.effective.roles.map((x) => x.name),
    ['Global'],
  )
  assert.ok(r.errors.some((e) => e.code === 'SESSION_ROLES_NOT_SUPPORTED'))
})

test('B3：正常路径不误报这两条错误', () => {
  const global = globalWith()
  const r = resolveEffectiveConfig({ global, globalRaw: { roles: global.roles } })
  assert.equal(
    r.errors.some(
      (e) =>
        e.code === 'PROJECT_ROLES_NOT_SUPPORTED' || e.code === 'SESSION_ROLES_NOT_SUPPORTED',
    ),
    false,
  )
})

test('B3：project 的非角色字段仍被接受（不误报）', () => {
  const global = globalWith()
  const r = resolveEffectiveConfig({
    global,
    globalRaw: { roles: global.roles },
    project: { projectRules: ['rule-1'], dispatchNotes: 'note' },
  })
  assert.deepEqual(
    r.effective.roles.map((x) => x.name),
    ['Global'],
  )
  assert.equal(
    r.errors.some((e) => e.code === 'PROJECT_ROLES_NOT_SUPPORTED'),
    false,
    '没有角色字段时不该报错',
  )
})

test('B3：空 project / 空 session 不报错（只有真的带角色才算）', () => {
  const global = globalWith()
  for (const input of [
    { global, globalRaw: { roles: global.roles }, project: {} },
    { global, globalRaw: { roles: global.roles }, project: { roles: [] } },
    { global, globalRaw: { roles: global.roles }, project: { roleOverrides: {} } },
  ]) {
    const r = resolveEffectiveConfig(input)
    assert.equal(
      r.errors.some((e) => e.code === 'PROJECT_ROLES_NOT_SUPPORTED'),
      false,
      `${JSON.stringify(input.project)} 是空的，不该报错`,
    )
  }
})
