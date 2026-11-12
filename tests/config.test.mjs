// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ChannelInstanceSchema,
  Config,
  CHANNEL_KINDS,
  RoleSchema,
  normalizeConfig,
} from '../src/config.js'

const validRole = {
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli', provider: 'acp', cli: 'codebuddy' },
}

test('常量与审计结论一致', () => {
  assert.deepEqual([...CHANNEL_KINDS], ['in-process', 'acp-cli', 'codex', 'claude-code'])
})

test('空配置得到安全默认值', () => {
  const cfg = normalizeConfig(undefined)
  assert.deepEqual(cfg.roles, [])
  assert.equal(cfg.defaultRoleId, undefined)
  assert.equal(cfg.projectConfigFile, '.meetingstone.json')
  assert.deepEqual(cfg.limits, {
    serializeWrites: true,
    maxParallelWritesTotal: 8,
    maxParallelWritesPerSession: 4,
    defaultIsolation: 'worktree',
  })
})

test('limits 部分覆盖：其余字段回退默认值', () => {
  const cfg = normalizeConfig({ limits: { defaultIsolation: 'none' } })
  assert.deepEqual(cfg.limits, {
    serializeWrites: true,
    maxParallelWritesTotal: 8,
    maxParallelWritesPerSession: 4,
    defaultIsolation: 'none',
  })
  assert.throws(() => normalizeConfig({ limits: { defaultIsolation: 'sandbox' } }))
})

test('角色缺省值：别名空数组、启用、30 分钟超时', () => {
  const role = RoleSchema({ roleId: 'role-a', name: 'A' })
  assert.deepEqual(role.aliases, [])
  assert.equal(role.enabled, true)
  assert.equal(role.timeoutMs, 30 * 60 * 1000)
  assert.equal(role.channel.kind, 'in-process')
})

test('通道 kind 只接受已知枚举', () => {
  assert.throws(() => RoleSchema({ roleId: 'role-a', name: 'A', channel: { kind: 'bogus' } }))
})

test('permissionPreset 已移除：旧配置里的该字段被忽略，不阻断加载', () => {
  const role = RoleSchema({ ...validRole, permissionPreset: 'root' })
  assert.equal(Object.hasOwn(role, 'permissionPreset'), false, '角色上不应再产出 permissionPreset')
  const channel = ChannelInstanceSchema({ channelId: 'ch-a', permissionPreset: 'read-only' })
  assert.equal(Object.hasOwn(channel, 'permissionPreset'), false, '通道实例上也不应再产出 permissionPreset')
})

test('roleId / name 必填', () => {
  assert.throws(() => RoleSchema({ name: '没有 id' }))
  assert.throws(() => RoleSchema({ roleId: 'role-a' }))
})

test('完整角色可以往返', () => {
  const role = RoleSchema(validRole)
  assert.equal(role.roleId, 'role-sashi')
  assert.equal(role.channel.provider, 'acp')
})

test('cliPreferences：缺省为空对象（unset），只接受布尔值', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg.cliPreferences, {})
  assert.deepEqual(normalizeConfig({ cliPreferences: { codex: false, claude: true } }).cliPreferences, {
    codex: false,
    claude: true,
  })
  // 直接走严格 schema：类型错会抛（normalizeConfig 会先容错清洗）。
  assert.throws(() => Config({ cliPreferences: { codex: 'false' } }))
})

test('cliPreferences：normalizeConfig 容错清洗，不拖垮角色表', () => {
  const cfg = normalizeConfig({
    roles: [validRole],
    cliPreferences: { codex: false, codebuddy: 'yes', claude: 1 },
  })
  assert.equal(cfg.roles.length, 1)
  assert.deepEqual(cfg.cliPreferences, { codex: false })
})

test('cliPreferences：未知键被忽略（向前兼容）', () => {
  const cfg = normalizeConfig({ cliPreferences: { future: true, codex: true } })
  assert.deepEqual(cfg.cliPreferences, { codex: true })
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
