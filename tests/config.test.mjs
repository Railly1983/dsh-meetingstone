// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  Config,
  CHANNEL_KINDS,
  PERMISSION_PRESETS,
  RoleSchema,
  normalizeConfig,
} from '../src/config.js'

const validRole = {
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli', provider: 'acp', cli: 'codebuddy' },
  permissionPreset: 'project-write',
}

test('常量与审计结论一致', () => {
  assert.deepEqual([...CHANNEL_KINDS], ['in-process', 'acp-cli', 'codex', 'claude-code'])
  // 顺序即宽松度，registry 的"只能收紧"依赖它
  assert.deepEqual([...PERMISSION_PRESETS], [
    'read-only',
    'restricted',
    'project-write',
    'approval',
  ])
})

test('空配置得到安全默认值', () => {
  const cfg = normalizeConfig(undefined)
  assert.deepEqual(cfg.roles, [])
  assert.equal(cfg.defaultRoleId, undefined)
  assert.equal(cfg.projectConfigFile, '.meetingstone.json')
  assert.deepEqual(cfg.limits, { maxParallelReadonly: 3, serializeWrites: true })
})

test('角色缺省值：别名空数组、只读档位、启用、30 分钟超时', () => {
  const role = RoleSchema({ roleId: 'role-a', name: 'A' })
  assert.deepEqual(role.aliases, [])
  assert.equal(role.permissionPreset, 'read-only')
  assert.equal(role.enabled, true)
  assert.equal(role.timeoutMs, 30 * 60 * 1000)
  assert.equal(role.channel.kind, 'in-process')
})

test('通道 kind 只接受已知枚举', () => {
  assert.throws(() => RoleSchema({ roleId: 'role-a', name: 'A', channel: { kind: 'bogus' } }))
})

test('权限档位只接受四档', () => {
  assert.throws(() => RoleSchema({ ...validRole, permissionPreset: 'root' }))
})

test('roleId / name 必填', () => {
  assert.throws(() => RoleSchema({ name: '没有 id' }))
  assert.throws(() => RoleSchema({ roleId: 'role-a' }))
})

test('完整角色可以往返', () => {
  const role = RoleSchema(validRole)
  assert.equal(role.roleId, 'role-sashi')
  assert.equal(role.channel.provider, 'acp')
  assert.equal(role.permissionPreset, 'project-write')
})

test('simplify 会把等于默认值的字段剥掉（保持配置文件紧凑）', () => {
  const cfg = Config({
    roles: [validRole],
    defaultRoleId: 'role-sashi',
  })
  const slim = Config.simplify(cfg)
  assert.equal(slim.defaultRoleId, 'role-sashi')
  assert.equal(slim.dispatchNotes, undefined, '等于默认值的文本应被剥掉')
  assert.ok(Array.isArray(slim.roles))
})
