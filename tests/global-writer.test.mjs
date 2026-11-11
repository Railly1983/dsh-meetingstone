// @ts-check
/**
 * P0-S2：全局配置写入（profile patch / configEditor.edit）。
 *
 * 重点证明：
 * - 以 `current` raw config 为底做合并，**未知字段不丢**（patch 是整值替换）
 * - `cliPreferences` 与角色 enabled 写入走同一编辑器
 * - 编辑器缺失 / entry 失效 / 高层覆盖 → 稳定错误码，**不静默**
 * - 同一插件的写入按提交顺序串行
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { GLOBAL_CONFIG_ERRORS, createGlobalConfigWriter } from '../src/config/global-writer.js'

const ENTRY = { options: { id: 'meetingstone', name: 'dsh-meetingstone' } }

/** 假 configEditor：保存 current，记录 edit 调用。 */
function fakeEditor(initial = {}, options = {}) {
  let current = structuredClone(initial)
  const calls = []
  return {
    calls,
    get current() {
      return current
    },
    async edit(entry, change) {
      calls.push(entry)
      if (options.fail) throw options.fail
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const next = change(structuredClone(current), {})
      current = next
      return next
    },
  }
}

function makeWriter(editor, entry = ENTRY) {
  return createGlobalConfigWriter({ getConfigEditor: () => editor, getEntry: () => entry })
}

test('setCliPreference：保留未知顶层字段与未知 cli 键', async () => {
  const editor = fakeEditor({
    roles: [{ roleId: 'role-a', name: 'A', futureRoleField: true }],
    cliPreferences: { codex: false, futureCli: 'keep' },
    futureTopLevel: { nested: 1 },
  })
  const result = await makeWriter(editor).setCliPreference('codex', 'enabled')
  assert.equal(result.ok, true)
  assert.equal(result.written, true)
  assert.equal(editor.current.cliPreferences.codex, true)
  assert.equal(editor.current.cliPreferences.futureCli, 'keep')
  assert.deepEqual(editor.current.futureTopLevel, { nested: 1 })
  assert.equal(editor.current.roles[0].futureRoleField, true)
})

test('setCliPreference：disabled / unset 的持久化语义', async () => {
  const editor = fakeEditor({ cliPreferences: { codex: true } })
  const writer = makeWriter(editor)

  await writer.setCliPreference('codex', 'disabled')
  assert.equal(editor.current.cliPreferences.codex, false)

  await writer.setCliPreference('codex', 'unset')
  assert.equal(Object.hasOwn(editor.current.cliPreferences ?? {}, 'codex'), false)
})

test('setCliPreference：已经等于目标值 → idempotent，不重复写', async () => {
  const editor = fakeEditor({ cliPreferences: { codex: true } })
  const result = await makeWriter(editor).setCliPreference('codex', 'enabled')
  assert.equal(result.ok, true)
  assert.equal(result.written, false)
  assert.equal(result.idempotent, true)
  assert.equal(editor.calls.length, 1, '仍然经过编辑器，但结果标记为未变')
})

test('setCliPreference：非法 CLI / 非法偏好 → 稳定错误码，不调用编辑器', async () => {
  const editor = fakeEditor({})
  const writer = makeWriter(editor)
  const badCli = await writer.setCliPreference('kimi', 'enabled')
  assert.equal(badCli.code, GLOBAL_CONFIG_ERRORS.INVALID_CLI)
  const badPreference = await writer.setCliPreference('codex', 'sometimes')
  assert.equal(badPreference.code, GLOBAL_CONFIG_ERRORS.INVALID_PREFERENCE)
  assert.equal(editor.calls.length, 0)
})

test('updateRole / setRoleEnabled：字段级合并，保留未知字段，不动其他角色', async () => {
  const editor = fakeEditor({
    roles: [
      { roleId: 'role-a', name: 'A', enabled: true, futureRoleField: 'keep', channel: { kind: 'codex', model: 'm1', futureChannel: true } },
      { roleId: 'role-b', name: 'B', enabled: true },
    ],
    unknownTop: 'keep',
  })
  const writer = makeWriter(editor)

  const update = await writer.updateRole('role-a', { channel: { model: 'm2' }, description: '新描述' })
  assert.equal(update.ok, true)
  const roleA = editor.current.roles[0]
  assert.equal(roleA.channel.model, 'm2')
  assert.equal(roleA.channel.kind, 'codex', 'channel 按字段合并')
  assert.equal(roleA.channel.futureChannel, true, 'channel 未知字段保留')
  assert.equal(roleA.futureRoleField, 'keep', '角色未知字段保留')
  assert.equal(roleA.description, '新描述')
  assert.equal(editor.current.roles[1].name, 'B', '其他角色不变')
  assert.equal(editor.current.unknownTop, 'keep')

  await writer.setRoleEnabled('role-a', false)
  assert.equal(editor.current.roles[0].enabled, false)
})

test('updateRole：角色不存在 / 非法 roleId / 非法补丁 → 明确错误码', async () => {
  const editor = fakeEditor({ roles: [{ roleId: 'role-a', name: 'A' }] })
  const writer = makeWriter(editor)
  const missing = await writer.updateRole('role-ghost', { enabled: false })
  assert.equal(missing.code, GLOBAL_CONFIG_ERRORS.ROLE_NOT_FOUND)
  const badId = await writer.updateRole('BAD ID', { enabled: false })
  assert.equal(badId.code, GLOBAL_CONFIG_ERRORS.INVALID_ROLE_ID)
  const badPatch = await writer.updateRole('role-a', { bogus: 1 })
  assert.equal(badPatch.code, GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH)
  const mismatched = await writer.updateRole('role-a', { roleId: 'role-b', enabled: false })
  assert.equal(mismatched.code, GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH)
  const badEnabled = await writer.setRoleEnabled('role-a', /** @type {any} */ ('yes'))
  assert.equal(badEnabled.code, GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH)
})

test('编辑器 / entry 缺失 → 明确错误码，不假装成功', async () => {
  const noEditor = createGlobalConfigWriter({ getConfigEditor: () => undefined, getEntry: () => ENTRY })
  assert.equal((await noEditor.setCliPreference('codex', 'enabled')).code, GLOBAL_CONFIG_ERRORS.EDITOR_UNAVAILABLE)

  const noEntry = createGlobalConfigWriter({ getConfigEditor: () => fakeEditor({}), getEntry: () => undefined })
  assert.equal((await noEntry.setCliPreference('codex', 'enabled')).code, GLOBAL_CONFIG_ERRORS.ENTRY_UNAVAILABLE)
})

test('高层覆盖 / entry 失效 → 原样分类，不静默', async () => {
  const overridden = createGlobalConfigWriter({
    getConfigEditor: () => fakeEditor({}, { fail: new Error('Configuration for "meetingstone" is overridden by a home patch or command-line overlay') }),
    getEntry: () => ENTRY,
  })
  const o = await overridden.setCliPreference('codex', 'enabled')
  assert.equal(o.code, GLOBAL_CONFIG_ERRORS.OVERRIDDEN)

  const stale = createGlobalConfigWriter({
    getConfigEditor: () => fakeEditor({}, { fail: new Error('Configuration entry is no longer available') }),
    getEntry: () => ENTRY,
  })
  const s = await stale.setCliPreference('codex', 'enabled')
  assert.equal(s.code, GLOBAL_CONFIG_ERRORS.ENTRY_STALE)

  const inactive = createGlobalConfigWriter({
    getConfigEditor: () => fakeEditor({}, { fail: new Error('Configuration plugin is no longer active') }),
    getEntry: () => ENTRY,
  })
  const i = await inactive.setCliPreference('codex', 'enabled')
  assert.equal(i.code, GLOBAL_CONFIG_ERRORS.ENTRY_INACTIVE)
})

test('写入串行：连续两次保存不会互相覆盖', async () => {
  const editor = fakeEditor({}, { delayMs: 20 })
  const writer = makeWriter(editor)
  const [first, second] = await Promise.all([
    writer.setCliPreference('codex', 'enabled'),
    writer.setCliPreference('claude', 'disabled'),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(editor.current.cliPreferences.codex, true)
  assert.equal(editor.current.cliPreferences.claude, false)
  assert.equal(editor.calls.length, 2)
})
