// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROLE_ID_PATTERN, isValidRoleId, normalizeAlias } from '../src/roles/ids.js'
import {
  createRegistry,
  DEFAULT_TIMEOUT_MS,
} from '../src/roles/registry.js'

/**
 * 造一个结构完整的角色，测试里只写关心的字段。
 *
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
function makeRole(patch) {
  return {
    roleId: 'role-sashi',
    name: '沙僧',
    aliases: [],
    description: '主力开发',
    channel: { kind: 'acp-cli', provider: 'acp', cli: 'codebuddy', model: 'deepseek-v4.1-flash', reasoning: 'high' },
    enabled: true,
    fallbackRoleId: null,
    timeoutMs: 1800000,
    ...patch,
  }
}

/** @param {import('../src/roles/registry.js').RegistryError[]} errors */
function codes(errors) {
  return errors.map((error) => error.code)
}

// ---------------------------------------------------------------- ids.js

test('ids: ROLE_ID_PATTERN 与 isValidRoleId', () => {
  assert.ok(ROLE_ID_PATTERN instanceof RegExp)
  assert.equal(isValidRoleId('role-sashi'), true)
  assert.equal(isValidRoleId('role-lead-2'), true)
  assert.equal(isValidRoleId('role-0'), true)

  assert.equal(isValidRoleId('role-'), false, '末尾必须有字符')
  assert.equal(isValidRoleId('role--x'), false, '首个字符不能是连字符')
  assert.equal(isValidRoleId('Role-Sashi'), false, '必须全小写')
  assert.equal(isValidRoleId('sashi'), false, '必须带 role- 前缀')
  assert.equal(isValidRoleId(' role-sashi'), false, '不允许带空白')
  assert.equal(isValidRoleId(undefined), false)
  assert.equal(isValidRoleId(42), false)
})

test('ids: normalizeAlias 去空白、压内部空白、忽略大小写', () => {
  assert.equal(normalizeAlias('  SS  '), 'ss')
  assert.equal(normalizeAlias('主力   执行'), '主力 执行')
  assert.equal(normalizeAlias('主力\t\n执行'), '主力 执行')
  assert.equal(normalizeAlias('  '), '')
  assert.equal(normalizeAlias(''), '')
  assert.equal(normalizeAlias(/** @type {any} */ (null)), '')
  assert.equal(normalizeAlias(/** @type {any} */ (123)), '')
})

// ------------------------------------------------------------ 正常解析

test('resolve：roleId / name / 别名都能命中同一个角色', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ aliases: ['SS', '主力执行'] })],
  })

  for (const ref of ['role-sashi', '沙僧', 'SS', 'ss', '主力执行']) {
    const role = registry.resolve(ref)
    assert.ok(role, `应当能解析 ${ref}`)
    assert.equal(role.roleId, 'role-sashi')
    assert.equal(role.name, '沙僧')
  }
})

test('resolve：大小写与前后/内部空白都不敏感', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ name: 'Sha Seng', aliases: ['Main   Executor'] })],
  })

  assert.equal(registry.resolve('  sha   seng ')?.roleId, 'role-sashi')
  assert.equal(registry.resolve('MAIN EXECUTOR')?.roleId, 'role-sashi')
  assert.equal(registry.resolve('main executor')?.roleId, 'role-sashi')
})

test('resolve：找不到返回 null，空串/非字符串也返回 null', () => {
  const registry = createRegistry({ globalRoles: [makeRole()] })

  assert.equal(registry.resolve('role-nobody'), null)
  assert.equal(registry.resolve('路人甲'), null)
  assert.equal(registry.resolve('   '), null)
  assert.equal(registry.resolve(''), null)
  assert.equal(registry.resolve(/** @type {any} */ (null)), null)
  assert.equal(registry.resolve(/** @type {any} */ ({})), null)
})

// ------------------------------------------------------------ 别名冲突

test('别名冲突：两角色抢同一别名 → ALIAS_CONFLICT，该别名不可解析，角色仍按 roleId 可用', () => {
  const registry = createRegistry({
    globalRoles: [
      makeRole({ roleId: 'role-a', name: '甲', aliases: ['SS'] }),
      makeRole({ roleId: 'role-b', name: '乙', aliases: ['ss'] }),
    ],
  })

  assert.ok(codes(registry.errors).includes('ALIAS_CONFLICT'))
  const conflict = registry.errors.find((error) => error.code === 'ALIAS_CONFLICT')
  assert.deepEqual(conflict?.roles?.slice().sort(), ['role-a', 'role-b'])

  // 冲突别名从索引移除
  assert.equal(registry.resolve('SS'), null)
  assert.equal(registry.resolve('ss'), null)

  // 角色本体保留并标记
  const listed = registry.list()
  assert.equal(listed.length, 2)
  assert.equal(listed.every((role) => role.ambiguous === true), true)

  // 仍可按 roleId 解析
  assert.equal(registry.resolve('role-a')?.name, '甲')
  assert.equal(registry.resolve('role-b')?.name, '乙')
})

test('别名冲突：name 也参与唯一性判定', () => {
  const registry = createRegistry({
    globalRoles: [
      makeRole({ roleId: 'role-a', name: '沙僧', aliases: [] }),
      makeRole({ roleId: 'role-b', name: '沙僧的替身', aliases: ['沙僧'] }),
    ],
  })

  assert.ok(codes(registry.errors).includes('ALIAS_CONFLICT'))
  assert.equal(registry.resolve('沙僧'), null)
})

test('别名冲突不影响未冲突的别名', () => {
  const registry = createRegistry({
    globalRoles: [
      makeRole({ roleId: 'role-a', name: '甲', aliases: ['SS', '甲甲'] }),
      makeRole({ roleId: 'role-b', name: '乙', aliases: ['SS'] }),
    ],
  })

  assert.equal(registry.resolve('SS'), null, '冲突别名不可解析')
  assert.equal(registry.resolve('甲甲')?.roleId, 'role-a', '其余别名照常')
})

// ------------------------------------------------------------ 校验错误

test('非法 roleId：记 INVALID_ROLE_ID 并丢弃该角色', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ roleId: 'Sashi' }), makeRole({ roleId: 'role-ok', name: '好人' })],
  })

  const errorCodes = codes(registry.errors)
  assert.ok(errorCodes.includes('INVALID_ROLE_ID'))
  assert.equal(registry.get('Sashi'), null)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].roleId, 'role-ok')
})

test('缺少 name：记 MISSING_NAME 并丢弃该角色', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ name: '   ' })],
  })

  assert.ok(codes(registry.errors).includes('MISSING_NAME'))
  assert.equal(registry.list().length, 0)
})

test('重复 roleId：记 DUPLICATE_ROLE_ID，保留第一条', () => {
  const registry = createRegistry({
    globalRoles: [
      makeRole({ name: '甲' }),
      makeRole({ name: '乙' }),
    ],
  })

  assert.ok(codes(registry.errors).includes('DUPLICATE_ROLE_ID'))
  assert.equal(registry.list().length, 1)
  assert.equal(registry.resolve('role-sashi')?.name, '甲')
})

test('项目清单里同 id 出现两次：同样记 DUPLICATE_ROLE_ID', () => {
  const registry = createRegistry({
    globalRoles: [makeRole()],
    projectRoles: [
      makeRole({ channel: { kind: 'acp-cli', model: 'first' } }),
      makeRole({ channel: { kind: 'acp-cli', model: 'second' } }),
    ],
  })

  assert.ok(codes(registry.errors).includes('DUPLICATE_ROLE_ID'))
  assert.equal(registry.resolve('role-sashi')?.channel.model, 'first')
})

// ------------------------------------------------------------ 项目覆盖

test('项目覆盖：改模型生效，且未提到的字段保持全局值', () => {
  const registry = createRegistry({
    globalRoles: [makeRole()],
    projectRoles: [
      { roleId: 'role-sashi', channel: { model: 'hy4free' } },
    ],
  })

  const role = registry.resolve('role-sashi')
  assert.equal(role?.channel.model, 'hy4free')
  assert.equal(role?.channel.cli, 'codebuddy', '通道其余字段保留')
  assert.deepEqual(registry.errors, [])
})

test('项目覆盖：projectOverrides 表按 roleId 打补丁', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ aliases: ['SS'] })],
    projectOverrides: {
      'role-sashi': { description: '项目里改成前端', aliases: ['前端'] },
    },
  })

  const role = registry.resolve('role-sashi')
  assert.equal(role?.description, '项目里改成前端')
  assert.equal(registry.resolve('前端')?.roleId, 'role-sashi')
  assert.equal(registry.resolve('SS'), null, '别名被整体替换')
})

test('项目新增角色：与全局角色共存', () => {
  const registry = createRegistry({
    globalRoles: [makeRole()],
    projectRoles: [
      makeRole({ roleId: 'role-scout', name: '斥候', aliases: ['scout'] }),
    ],
  })

  assert.equal(registry.list().length, 2)
  assert.equal(registry.resolve('scout')?.roleId, 'role-scout')
  assert.equal(registry.resolve('沙僧')?.roleId, 'role-sashi')
})

test('项目覆盖指向不存在的角色：记 UNKNOWN_ROLE_ID，不影响其他角色', () => {
  const registry = createRegistry({
    globalRoles: [makeRole()],
    projectOverrides: { 'role-ghost': { description: 'x' } },
  })

  assert.ok(codes(registry.errors).includes('UNKNOWN_ROLE_ID'))
  assert.equal(registry.resolve('沙僧')?.roleId, 'role-sashi')
})

// ------------------------------------------------------------ 已移除的 permissionPreset

test('permissionPreset 已移除：旧配置字段被忽略，不产生错误也不出现在角色上', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ permissionPreset: 'read-only' })],
    projectOverrides: { 'role-sashi': { permissionPreset: 'approval' } },
  })

  assert.deepEqual(registry.errors, [], '旧配置不应再触发 PERMISSION_WIDENED')
  assert.equal(Object.hasOwn(registry.resolve('role-sashi') ?? {}, 'permissionPreset'), false)
})

// ------------------------------------------------------------ enabled

test('enabled:false：resolve 返回 { ...role, disabled: true }，list 仍包含该角色', () => {
  const registry = createRegistry({
    globalRoles: [makeRole({ enabled: false })],
  })

  const role = registry.resolve('沙僧')
  assert.ok(role)
  assert.equal(role?.enabled, false)
  assert.equal(role?.disabled, true)
  assert.equal(role?.roleId, 'role-sashi')

  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].enabled, false, 'list 不注入 disabled 标记')
  assert.equal(registry.list()[0].disabled, undefined)
})

test('enabled:true：不带 disabled 标记', () => {
  const registry = createRegistry({ globalRoles: [makeRole()] })
  assert.equal(registry.resolve('沙僧')?.disabled, undefined)
})

// ------------------------------------------------------------ 其他契约

test('get：按 roleId 取角色，未知返回 null', () => {
  const registry = createRegistry({ globalRoles: [makeRole()] })

  assert.equal(registry.get('role-sashi')?.name, '沙僧')
  assert.equal(registry.get('role-nobody'), null)
  assert.equal(registry.get(/** @type {any} */ (undefined)), null)
})

test('list 返回副本：外部修改不污染注册表', () => {
  const registry = createRegistry({ globalRoles: [makeRole({ aliases: ['SS'] })] })

  const first = registry.list()
  first[0].aliases.push('被污染的别名')
  first[0].channel.model = '被污染的模型'
  first[0].name = '改坏了也没用'

  const second = registry.list()
  assert.deepEqual(second[0].aliases, ['SS'])
  assert.equal(second[0].channel.model, 'deepseek-v4.1-flash')
  assert.equal(registry.resolve('SS')?.roleId, 'role-sashi')
})

test('默认值：缺省 timeoutMs 走内置默认', () => {
  const registry = createRegistry({
    globalRoles: [
      {
        roleId: 'role-min',
        name: '最小角色',
        channel: { kind: 'in-process' },
      },
    ],
  })

  const role = registry.resolve('role-min')
  assert.equal(role?.timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.deepEqual(role?.aliases, [])
  assert.equal(role?.fallbackRoleId, null)
  assert.equal(role?.enabled, true)
})

test('空输入：返回空表而不是抛错', () => {
  const registry = createRegistry()
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(registry.errors, [])
  assert.equal(registry.resolve('role-sashi'), null)
})

// ─── 回归：channelId 必须被注册表保留（否则 DD7「模型由通道实例承载」链路断掉） ──

test('channelId 与 source 被正确保留', () => {
  const registry = createRegistry({
    globalRoles: [
      {
        roleId: 'role-a',
        name: 'A',
        aliases: [],
        channel: { kind: 'acp-cli', channelId: 'ch-1', model: 'm', reasoning: 'high' },
        enabled: true,
      },
    ],
    projectOverrides: { 'role-b': undefined },
    projectRoles: [
      {
        roleId: 'role-b',
        name: 'B',
        aliases: [],
        channel: { kind: 'in-process' },
        enabled: true,
      },
    ],
  })

  const a = registry.get('role-a')
  assert.equal(a?.channel.channelId, 'ch-1', 'channelId 不能丢，否则模型一致性校验永远失败')
  assert.equal(a?.source, 'global')

  const b = registry.get('role-b')
  assert.equal(b?.source, 'project')
})

// ─── B2：角色设定（description+prompt 合并）迁移 ──────────────────────────────

test('B2：description+prompt 迁移为单一 setting（prompt 优先），旧字段不再保留', () => {
  const legacy = createRegistry({
    globalRoles: [
      { roleId: 'role-a', name: 'A', description: '职责说明', prompt: '你是人设。' },
      { roleId: 'role-b', name: 'B', description: '只有描述' },
      { roleId: 'role-c', name: 'C', setting: '新设定', description: '旧', prompt: '旧人设' },
    ],
  })
  const byId = Object.fromEntries(legacy.list().map((role) => [role.roleId, role]))
  assert.equal(byId['role-a'].setting, '你是人设。')
  assert.equal(byId['role-a'].description, '你是人设。', '兼容镜像 = setting')
  assert.equal(byId['role-b'].setting, '只有描述')
  assert.equal(byId['role-b'].prompt, '只有描述', '兼容镜像 = setting')
  assert.equal(byId['role-c'].setting, '新设定', '新字段优先于旧字段')
})

test('B2：合并覆盖时 setting/description/prompt 都写进 setting（不再双写）', () => {
  const registry = createRegistry({
    globalRoles: [{ roleId: 'role-a', name: 'A', setting: '原设定' }],
    projectOverrides: { 'role-a': { prompt: '项目人设' } },
  })
  const role = registry.get('role-a')
  assert.equal(role.setting, '项目人设')
  assert.equal(role.description, '项目人设')
})
