// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROJECT_CONFIG_ERRORS,
  PROJECT_CONFIG_VERSION,
  emptyProjectConfig,
  normalizeProjectConfig,
  parseProjectConfig,
  toRegistryInput,
} from '../src/project/config-file.js'

const codes = (errors) => errors.map((e) => e.code)

test('空文本 → 空配置，不报错', () => {
  for (const input of ['', '   ', null, undefined]) {
    const { config, errors } = parseProjectConfig(/** @type {any} */ (input))
    assert.deepEqual(errors, [])
    assert.deepEqual(config, emptyProjectConfig())
  }
})

test('坏 JSON → 降级为空配置 + INVALID_JSON（不抛异常）', () => {
  const { config, errors } = parseProjectConfig('{ "version": 1, ')
  assert.deepEqual(codes(errors), [PROJECT_CONFIG_ERRORS.INVALID_JSON])
  assert.deepEqual(config.roles, [])
  assert.equal(config.version, PROJECT_CONFIG_VERSION)
})

test('顶层不是对象 → NOT_OBJECT', () => {
  for (const raw of [[], 1, 'x', true]) {
    const { errors } = normalizeProjectConfig(raw)
    assert.deepEqual(codes(errors), [PROJECT_CONFIG_ERRORS.NOT_OBJECT])
  }
})

test('未知版本 → UNSUPPORTED_VERSION 且不再继续解析', () => {
  const { config, errors } = normalizeProjectConfig({ version: 99, roles: [{ roleId: 'role-a' }] })
  assert.deepEqual(codes(errors), [PROJECT_CONFIG_ERRORS.UNSUPPORTED_VERSION])
  assert.deepEqual(config.roles, [], '版本不认识时应整体降级，避免半懂半不懂')
})

test('缺 version 视为当前版本（手写文件友好）', () => {
  const { config, errors } = normalizeProjectConfig({ dispatchNotes: '优先沙僧' })
  assert.deepEqual(errors, [])
  assert.equal(config.version, PROJECT_CONFIG_VERSION)
  assert.equal(config.dispatchNotes, '优先沙僧')
})

test('完整配置按字段解析', () => {
  const raw = {
    version: 1,
    defaultRoleId: ' role-sashi ',
    roles: [{ roleId: 'role-scout', name: '斥候' }],
    roleOverrides: { 'role-sashi': { description: '项目内改为复核' } },
    dispatchNotes: '关键改动交悟空复核',
    projectRules: ['未经确认不得改迁移文件', 123, null],
    limits: { serializeWrites: false },
  }
  const { config, errors } = normalizeProjectConfig(raw)
  assert.equal(config.defaultRoleId, 'role-sashi', 'defaultRoleId 应 trim')
  assert.equal(config.roles.length, 1)
  assert.deepEqual(config.roleOverrides, { 'role-sashi': { description: '项目内改为复核' } })
  assert.deepEqual(config.projectRules, ['未经确认不得改迁移文件'], '非字符串项丢弃')
  assert.equal(config.limits.serializeWrites, false)
  assert.deepEqual(codes(errors), [PROJECT_CONFIG_ERRORS.BAD_FIELD], 'projectRules 丢弃项要报出来')
})

test('字段类型不对 → 逐项降级并报 BAD_FIELD，其它字段照常生效', () => {
  const { config, errors } = normalizeProjectConfig({
    defaultRoleId: 123,
    roles: 'not-an-array',
    roleOverrides: ['nope'],
    dispatchNotes: {},
    projectRules: 'nope',
    limits: 'nope',
  })
  assert.equal(config.defaultRoleId, undefined)
  assert.deepEqual(config.roles, [])
  assert.deepEqual(config.roleOverrides, {})
  assert.equal(config.dispatchNotes, '')
  assert.deepEqual(config.projectRules, [])
  assert.deepEqual(config.limits, {})
  const fields = errors.map((e) => e.field)
  assert.deepEqual(fields.sort(), [
    'defaultRoleId',
    'dispatchNotes',
    'limits',
    'projectRules',
    'roleOverrides',
    'roles',
  ])
})

test('roles 里的非对象项被跳过并报错，合法项保留', () => {
  const { config, errors } = normalizeProjectConfig({
    roles: [{ roleId: 'role-a', name: 'A' }, null, 'x', 42],
  })
  assert.equal(config.roles.length, 1)
  assert.equal(config.roleOverrides && Object.keys(config.roleOverrides).length, 0)
  assert.equal(errors.filter((e) => e.code === PROJECT_CONFIG_ERRORS.BAD_FIELD).length, 3)
})

test('roleOverrides 里非对象值被跳过', () => {
  const { config, errors } = normalizeProjectConfig({
    roleOverrides: { 'role-a': { model: 'x' }, 'role-b': null },
  })
  assert.deepEqual(Object.keys(config.roleOverrides), ['role-a'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].field, 'roleOverrides.role-b')
})

test('limits 边界：serializeWrites 必须是布尔值', () => {
  const bad = normalizeProjectConfig({ limits: { serializeWrites: 'yes' } })
  assert.equal(bad.config.limits.serializeWrites, undefined)
  assert.equal(bad.errors.length, 1)
  assert.equal(bad.errors[0].field, 'limits.serializeWrites')
})

test('toRegistryInput：只搬移，不解释语义', () => {
  const globalConfig = { roles: [{ roleId: 'role-a', name: 'A' }] }
  const project = normalizeProjectConfig({
    defaultRoleId: 'role-a',
    roles: [{ roleId: 'role-b', name: 'B' }],
    roleOverrides: { 'role-a': { description: '项目内改名' } },
  }).config

  const input = toRegistryInput(globalConfig, project)
  assert.deepEqual(input.globalRoles.map((r) => r.roleId), ['role-a'])
  assert.deepEqual(input.projectRoles.map((r) => r.roleId), ['role-b'])
  assert.deepEqual(input.projectOverrides, { 'role-a': { description: '项目内改名' } })

  // 缺省输入不炸
  const empty = toRegistryInput(undefined, undefined)
  assert.deepEqual(empty, { globalRoles: [], projectRoles: [], projectOverrides: {} })
})

test('项目配置 + 注册表端到端：项目覆盖字段生效', async () => {
  const { createRegistry } = await import('../src/roles/registry.js')
  const globalConfig = {
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: ['SS'],
        channel: { kind: 'acp-cli' },
        enabled: true,
      },
    ],
  }
  const project = normalizeProjectConfig({
    roleOverrides: {
      // 注意：channel 是整值替换（与 DSH patch 语义一致），覆盖时必须重述 kind
      'role-sashi': {
        description: '项目内改为复核',
        channel: { kind: 'acp-cli', model: 'deepseek-v4.1-flash' },
      },
    },
  }).config

  const registry = createRegistry(toRegistryInput(globalConfig, project))
  const role = registry.resolve('SS')
  assert.ok(role)
  assert.equal(role.description, '项目内改为复核')
  assert.equal(role.channel.kind, 'acp-cli', '重述的 kind 生效')
  assert.equal(role.channel.model, 'deepseek-v4.1-flash')

  // 已移除的 permissionPreset 字段被忽略，不报错、不产出
  const legacy = normalizeProjectConfig({
    roleOverrides: { 'role-sashi': { permissionPreset: 'approval' } },
  }).config
  const reg2 = createRegistry(toRegistryInput(globalConfig, legacy))
  assert.equal(Object.hasOwn(reg2.get('role-sashi'), 'permissionPreset'), false)
  assert.deepEqual(reg2.errors, [])
})
