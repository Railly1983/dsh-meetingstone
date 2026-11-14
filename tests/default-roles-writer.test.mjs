// @ts-check
/**
 * 默认角色与写入器的交互契约（2026-11-14）。
 *
 * 背景：默认角色只在内存注入，磁盘上 `roles` 是空的。用户在设置页**看得见**
 * 这些角色并可以点编辑/删除。如果写入器按 roleId 在磁盘数组里找不到就报
 * ROLE_NOT_FOUND，用户就会「看得见却改不了」——那开箱即用是假的。
 *
 * 这里逐条验证那条闭环，并给出负对照。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { GLOBAL_CONFIG_ERRORS, createGlobalConfigWriter } from '../src/config/global-writer.js'
import { DEFAULT_ROLES, DEFAULT_ROLE_IDS, resolveEffectiveRoles } from '../src/roles/defaults.js'

const ENTRY = { id: 'meetingstone', name: 'dsh-meetingstone' }

/** 内存版 configEditor，形状与宿主一致。 */
function fakeEditor(initial) {
  let current = structuredClone(initial)
  return {
    get current() {
      return current
    },
    async edit(_entry, change) {
      current = change(structuredClone(current), {})
      return current
    },
  }
}

function makeWriter(editor) {
  return createGlobalConfigWriter({ getConfigEditor: () => editor, getEntry: () => ENTRY })
}

test('用户什么都没配时：编辑默认角色能把改动落盘（不再 ROLE_NOT_FOUND）', async () => {
  const editor = fakeEditor({ roles: [] })
  const writer = makeWriter(editor)
  const result = await writer.updateRole('role-worker', { name: '我的执行者' })

  assert.equal(result.ok, true, `应成功，实际：${JSON.stringify(result)}`)
  const saved = editor.current.roles.find((r) => r.roleId === 'role-worker')
  assert.ok(saved, '默认角色应被物化进配置')
  assert.equal(saved.name, '我的执行者')
  // 物化时应带上其它默认角色的完整定义，不能让磁盘上只剩被改的那一个。
  assert.deepEqual(
    editor.current.roles.map((r) => r.roleId).sort(),
    [...DEFAULT_ROLE_IDS].sort(),
    '其余默认角色也应一并落盘，否则界面会突然少几个角色',
  )
})

test('用户什么都没配时：删除默认角色能真正删掉', async () => {
  const editor = fakeEditor({ roles: [] })
  const writer = makeWriter(editor)
  const result = await writer.deleteRole('role-reviewer')

  assert.equal(result.ok, true, `应成功，实际：${JSON.stringify(result)}`)
  assert.deepEqual(
    editor.current.roles.map((r) => r.roleId),
    DEFAULT_ROLE_IDS.filter((id) => id !== 'role-reviewer'),
    '被删的角色消失，其余保留',
  )
})

test('新增与默认角色同 ID 的角色：报 ROLE_EXISTS，不产生重复', async () => {
  const editor = fakeEditor({ roles: [] })
  const writer = makeWriter(editor)
  const result = await writer.createRole({ roleId: 'role-worker', name: '重复的执行者' })

  assert.equal(result.ok, false)
  assert.equal(result.code, GLOBAL_CONFIG_ERRORS.ROLE_EXISTS)
  assert.equal(
    editor.current.roles.filter((r) => r.roleId === 'role-worker').length,
    0,
    '失败时不应写入任何东西',
  )
})

test('**用户已有角色时，写路径不掺默认角色**（核心约束）', async () => {
  const editor = fakeEditor({
    roles: [{ roleId: 'role-mine', name: '我的角色', channel: { kind: 'in-process' }, enabled: true }],
  })
  const writer = makeWriter(editor)
  const result = await writer.updateRole('role-mine', { name: '改过的名字' })

  assert.equal(result.ok, true, `应成功，实际：${JSON.stringify(result)}`)
  assert.deepEqual(
    editor.current.roles.map((r) => r.roleId),
    ['role-mine'],
    '不得把默认角色混进用户的配置',
  )
  // 负对照：如果实现无脑物化，这里会出现 role-worker 等。
  assert.ok(
    !editor.current.roles.some((r) => DEFAULT_ROLE_IDS.includes(r.roleId) && r.roleId !== 'role-mine'),
    '用户配置里不得出现默认角色',
  )
})

test('编辑不存在的角色仍然报 ROLE_NOT_FOUND（错误码没有被放松）', async () => {
  const editor = fakeEditor({ roles: [] })
  const result = await makeWriter(editor).updateRole('role-not-exist', { name: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, GLOBAL_CONFIG_ERRORS.ROLE_NOT_FOUND)
})

test('物化进磁盘的角色在读取路径上与原默认值一致（不会漂移）', async () => {
  const editor = fakeEditor({ roles: [] })
  await makeWriter(editor).updateRole('role-worker', { enabled: false })

  const saved = editor.current.roles
  // 用同一套解析逻辑当成"用户角色"来读：此时用户已有角色，不再注入默认值。
  const effective = resolveEffectiveRoles(saved)
  assert.equal(effective.length, DEFAULT_ROLES.length, '条数不变')
  const worker = effective.find((r) => r.roleId === 'role-worker')
  assert.equal(worker.enabled, false, '改动生效')
  assert.equal(worker.channel.kind, 'in-process', '默认角色的通道声明被保留')
  // 未被改动的角色保持原样
  const reviewer = effective.find((r) => r.roleId === 'role-reviewer')
  const original = DEFAULT_ROLES.find((r) => r.roleId === 'role-reviewer')
  assert.equal(reviewer.setting, original.setting)
})
