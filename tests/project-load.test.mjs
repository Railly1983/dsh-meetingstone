// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { win32, join } from 'node:path'

import { createProjectConfigStore } from '../src/project/load.js'

/** 内存文件系统：path -> { text, mtimeMs } */
function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const reads = []
  const deps = {
    readFile: (path) => {
      reads.push(path)
      const f = files.get(path)
      if (!f) throw new Error(`ENOENT: ${path}`)
      return f.text
    },
    statFile: (path) => {
      const f = files.get(path)
      if (!f) throw new Error(`ENOENT: ${path}`)
      return { mtimeMs: f.mtimeMs, size: f.text.length }
    },
    now: () => 1000,
    ttlMs: 10_000,
  }
  return { files, reads, deps }
}

// 用运行平台的 join：产品实现 src/project/load.js:77 也用它。
// 之前这里写 win32.join，在 Linux/macOS 上生成的键与产品算出的不一致，
// Map 查不到文件 → 测试只在 Windows 成立（2026-11-14 CI 全红根因之一）。
const root = join('proj', 'x')

test('没有项目根 → 空配置 + PROJECT_ROOT_UNKNOWN', () => {
  const { deps } = makeFs()
  const store = createProjectConfigStore(deps)
  const res = store.get(undefined)
  assert.equal(res.exists, false)
  assert.deepEqual(res.config.roles, [])
  assert.ok(res.errors.some((e) => e.code === 'PROJECT_ROOT_UNKNOWN'))
})

test('文件不存在 → 空配置且**不算错误**', () => {
  const { deps } = makeFs()
  const store = createProjectConfigStore(deps)
  const res = store.get(root)
  assert.equal(res.exists, false)
  assert.deepEqual(res.errors, [])
  assert.deepEqual(res.config.roles, [])
  assert.ok(res.path?.endsWith('.meetingstone.json'))
})

test('正常读取：解析出项目角色与覆盖', () => {
  const path = join(root, '.meetingstone.json')
  const { deps } = makeFs({
    [path]: {
      text: JSON.stringify({
        version: 1,
        roles: [{ roleId: 'role-scout', name: '斥候' }],
        roleOverrides: { 'role-sashi': { description: '项目内改为复核' } },
      }),
      mtimeMs: 5,
    },
  })
  const store = createProjectConfigStore(deps)
  const res = store.get(root)
  assert.equal(res.exists, true)
  assert.deepEqual(res.errors, [])
  assert.equal(res.config.roles.length, 1)
  assert.deepEqual(res.config.roleOverrides, { 'role-sashi': { description: '项目内改为复核' } })
})

test('坏 JSON → 降级为空配置 + INVALID_JSON，不抛异常', () => {
  const path = join(root, '.meetingstone.json')
  const { deps } = makeFs({ [path]: { text: '{ oops', mtimeMs: 5 } })
  const store = createProjectConfigStore(deps)
  const res = store.get(root)
  assert.equal(res.exists, true)
  assert.deepEqual(res.config.roles, [])
  assert.ok(res.errors.some((e) => e.code === 'PROJECT_CONFIG_INVALID_JSON'))
})

test('读取抛错 → PROJECT_CONFIG_READ_FAILED，不抛异常', () => {
  const path = join(root, '.meetingstone.json')
  const { deps } = makeFs({ [path]: { text: '{}', mtimeMs: 5 } })
  const broken = { ...deps, readFile: () => { throw new Error('EACCES') } }
  const store = createProjectConfigStore(broken)
  const res = store.get(root)
  assert.ok(res.errors.some((e) => e.code === 'PROJECT_CONFIG_READ_FAILED'))
})

test('缓存：签名不变不重读；mtime 变化后重读', () => {
  const path = join(root, '.meetingstone.json')
  const { files, reads, deps } = makeFs({
    [path]: { text: JSON.stringify({ version: 1, roles: [] }), mtimeMs: 5 },
  })
  const store = createProjectConfigStore(deps)

  store.get(root)
  store.get(root)
  assert.equal(reads.length, 1, '同一签名应命中缓存')

  // 改内容 + 改 mtime
  files.set(path, { text: JSON.stringify({ version: 1, roles: [{ roleId: 'role-a', name: 'A' }] }), mtimeMs: 6 })
  const res = store.get(root)
  assert.equal(reads.length, 2, '签名变化应重读')
  assert.equal(res.config.roles.length, 1)
})

test('invalidate 清缓存后重读', () => {
  const path = join(root, '.meetingstone.json')
  const { reads, deps } = makeFs({ [path]: { text: '{}', mtimeMs: 5 } })
  const store = createProjectConfigStore(deps)
  store.get(root)
  store.invalidate()
  store.get(root)
  assert.equal(reads.length, 2)
})

test('未知版本 → 降级并报 UNSUPPORTED_VERSION', () => {
  const path = join(root, '.meetingstone.json')
  const { deps } = makeFs({
    [path]: { text: JSON.stringify({ version: 99, roles: [{ roleId: 'role-x', name: 'X' }] }), mtimeMs: 1 },
  })
  const store = createProjectConfigStore(deps)
  const res = store.get(root)
  assert.deepEqual(res.config.roles, [], '版本不认识时整体降级')
  assert.ok(res.errors.some((e) => e.code === 'PROJECT_CONFIG_UNSUPPORTED_VERSION'))
})
