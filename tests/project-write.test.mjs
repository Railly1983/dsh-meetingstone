// @ts-check
/**
 * P0-S2：项目级 `.meetingstone.json` 写入。
 *
 * 重点证明：
 * - 只允许白名单字段，未知/不可写字段报错而不是静默丢弃
 * - **整值替换不丢未知字段**：外层未知键、角色/覆盖对象里的未知键都保留
 * - 坏 JSON 拒绝覆盖；无变化时幂等不写
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  PROJECT_WRITE_ERRORS,
  PROJECT_WRITABLE_FIELDS,
  applyProjectPatch,
  createProjectConfigWriter,
} from '../src/project/write.js'

const ROOT = 'D:/proj'
const FILE = join(ROOT, '.meetingstone.json')

/** 内存文件系统。 */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = []
  const writes = []
  return {
    files,
    dirs,
    writes,
    deps: {
      readText: (path) => {
        if (!files.has(path)) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return /** @type {string} */ (files.get(path))
      },
      writeText: async (path, text) => {
        writes.push(path)
        files.set(path, text)
      },
      renameFile: async (from, to) => {
        const text = files.get(from)
        files.delete(from)
        files.set(to, text)
      },
      removeFile: async (path) => {
        files.delete(path)
      },
      ensureDir: async (dir) => {
        dirs.push(dir)
      },
    },
  }
}

test('applyProjectPatch：只保留白名单，保留未知外层与角色未知字段', () => {
  const raw = {
    version: 1,
    limits: { serializeWrites: false },
    futureTop: { a: 1 },
    roleOverrides: { 'role-sashi': { description: '旧', futureField: 'keep' } },
  }
  const result = applyProjectPatch(raw, {
    dispatchNotes: '新备注',
    roleOverrides: { 'role-sashi': { description: '新' } },
  })
  assert.equal(result.ok, true)
  const config = /** @type {any} */ (result).config
  assert.equal(config.dispatchNotes, '新备注')
  assert.deepEqual(config.limits, { serializeWrites: false })
  assert.deepEqual(config.futureTop, { a: 1 })
  assert.equal(config.roleOverrides['role-sashi'].setting, '新', 'B2：description 写入迁移为 setting')
  assert.equal(config.roleOverrides['role-sashi'].futureField, 'keep')
  assert.equal(raw.roleOverrides['role-sashi'].description, '旧', '入参不可变')
})

test('applyProjectPatch：未知/不可写顶层字段 → 拒绝', () => {
  const result = applyProjectPatch({}, { limits: { serializeWrites: true } })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, PROJECT_WRITE_ERRORS.UNKNOWN_FIELD)

  const version = applyProjectPatch({}, { version: 2 })
  assert.equal(version.ok, false)
  assert.equal(version.errors[0].code, PROJECT_WRITE_ERRORS.UNKNOWN_FIELD)
})

test('applyProjectPatch：角色覆盖里的未知字段 → 拒绝（不静默丢）', () => {
  const result = applyProjectPatch({}, { roleOverrides: { 'role-a': { bogus: 1 } } })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, PROJECT_WRITE_ERRORS.UNKNOWN_FIELD)
})

test('applyProjectPatch：roles 按 roleId 合并，新增角色要求 name', () => {
  const raw = { roles: [{ roleId: 'role-a', name: 'A', future: 1 }] }
  const result = applyProjectPatch(raw, {
    roles: [
      { roleId: 'role-a', description: '补充' },
      { roleId: 'role-b', name: 'B' },
    ],
  })
  assert.equal(result.ok, true)
  const roles = /** @type {any} */ (result).config.roles
  assert.equal(roles[0].setting, '补充', 'B2：description 写入迁移为 setting')
  assert.equal(roles[0].future, 1, '未知字段保留')
  assert.equal(roles[1].name, 'B')

  const missingName = applyProjectPatch({}, { roles: [{ roleId: 'role-c' }] })
  assert.equal(missingName.ok, false)
  assert.equal(missingName.errors[0].field, 'roles[0].name')
})

test('applyProjectPatch：defaultRoleId=null 删除键（恢复继承）', () => {
  const result = applyProjectPatch({ defaultRoleId: 'role-a' }, { defaultRoleId: null })
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(/** @type {any} */ (result).config, 'defaultRoleId'), false)
})

test('writer：新文件写入 version 1，未知字段原样保留', async () => {
  const fs = memoryFs()
  const writer = createProjectConfigWriter(fs.deps)
  const result = await writer.update(ROOT, { defaultRoleId: 'role-a', dispatchNotes: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.written, true)
  const saved = JSON.parse(/** @type {string} */ (fs.files.get(FILE)))
  assert.equal(saved.version, 1)
  assert.equal(saved.defaultRoleId, 'role-a')
  assert.equal(saved.dispatchNotes, 'x')
  assert.equal(fs.dirs.length, 1)
  assert.equal(fs.dirs[0], join(ROOT))
})

test('writer：已有未知字段在整值替换后仍存在', async () => {
  const initial = {
    version: 1,
    limits: { serializeWrites: false },
    futureTop: { keep: true },
    roles: [{ roleId: 'role-a', name: 'A', futureRole: 'keep' }],
  }
  const fs = memoryFs({ [FILE]: JSON.stringify(initial) })
  const writer = createProjectConfigWriter(fs.deps)
  const result = await writer.update(ROOT, { dispatchNotes: '新' })
  assert.equal(result.ok, true)
  const saved = JSON.parse(/** @type {string} */ (fs.files.get(FILE)))
  assert.deepEqual(saved.limits, { serializeWrites: false })
  assert.deepEqual(saved.futureTop, { keep: true })
  assert.equal(saved.roles[0].futureRole, 'keep')
  assert.equal(saved.dispatchNotes, '新')
})

test('writer：无变化时幂等，不落盘', async () => {
  const fs = memoryFs({ [FILE]: JSON.stringify({ version: 1, dispatchNotes: 'same' }) })
  const writer = createProjectConfigWriter(fs.deps)
  const result = await writer.update(ROOT, { dispatchNotes: 'same' })
  assert.equal(result.ok, true)
  assert.equal(result.written, false)
  assert.equal(result.idempotent, true)
  assert.equal(fs.writes.length, 0)
})

test('writer：坏 JSON / 非对象 → 拒绝覆盖，文件保持原样', async () => {
  const brokenText = '{ not json'
  const fs = memoryFs({ [FILE]: brokenText })
  const writer = createProjectConfigWriter(fs.deps)
  const broken = await writer.update(ROOT, { dispatchNotes: 'x' })
  assert.equal(broken.ok, false)
  assert.equal(broken.code, PROJECT_WRITE_ERRORS.INVALID_JSON)
  assert.equal(fs.files.get(FILE), brokenText)
  assert.equal(fs.writes.length, 0)

  const arrayText = '[]'
  fs.files.set(FILE, arrayText)
  const array = await writer.update(ROOT, { dispatchNotes: 'x' })
  assert.equal(array.code, PROJECT_WRITE_ERRORS.NOT_OBJECT)
  assert.equal(fs.files.get(FILE), arrayText)
})

test('writer：未知字段 / 非法 roleId → 拒绝且不落盘', async () => {
  const fs = memoryFs()
  const writer = createProjectConfigWriter(fs.deps)
  const unknown = await writer.update(ROOT, { limits: { serializeWrites: true } }, '.meetingstone.json')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, PROJECT_WRITE_ERRORS.UNKNOWN_FIELD)

  const badRole = await writer.update(ROOT, { roleOverrides: { 'BAD ID': { enabled: false } } })
  assert.equal(badRole.ok, false)
  assert.equal(fs.writes.length, 0)
})

test('writer：非法值 → INVALID_VALUE，不落盘', async () => {
  const fs = memoryFs()
  const writer = createProjectConfigWriter(fs.deps)
  const result = await writer.update(ROOT, { projectRules: 'not-an-array' })
  assert.equal(result.ok, false)
  assert.equal(result.code, PROJECT_WRITE_ERRORS.INVALID_VALUE)
  assert.equal(fs.writes.length, 0)
})

test('writer：项目根缺失 → PATH_UNKNOWN，不写', async () => {
  const fs = memoryFs()
  const writer = createProjectConfigWriter(fs.deps)
  const result = await writer.update(null, { dispatchNotes: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, PROJECT_WRITE_ERRORS.PATH_UNKNOWN)
  assert.equal(fs.writes.length, 0)
})

test('writer：setRoleOverride 走同一份白名单并保留未知字段', async () => {
  const fs = memoryFs({
    [FILE]: JSON.stringify({ version: 1, roleOverrides: { 'role-a': { description: '旧', future: 'keep' } } }),
  })
  const writer = createProjectConfigWriter(fs.deps)
  const result = await writer.setRoleOverride(ROOT, 'role-a', { enabled: false })
  assert.equal(result.ok, true)
  const saved = JSON.parse(/** @type {string} */ (fs.files.get(FILE)))
  assert.equal(saved.roleOverrides['role-a'].enabled, false)
  assert.equal(saved.roleOverrides['role-a'].description, '旧')
  assert.equal(saved.roleOverrides['role-a'].future, 'keep')
})

test('白名单常量与文档一致', () => {
  assert.deepEqual([...PROJECT_WRITABLE_FIELDS], [
    'defaultRoleId',
    'dispatchNotes',
    'projectRules',
    'roles',
    'roleOverrides',
  ])
})
