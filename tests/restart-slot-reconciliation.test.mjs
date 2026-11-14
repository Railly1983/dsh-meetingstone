// @ts-check
/**
 * 独立复核（2026-11-14）：验证「DSH 重启必然泄漏并发槽位」这一长期转述的结论。
 *
 * 背景：docs/plan/2026-11-12-slot-leak-critical.md 记录了一次真实阻塞，但文档自己
 * 在第 43 行写着「等等，重启应该清空内存。那为什么还是 4？」并列入「需要进一步确认」，
 * 之后 CHANGELOG 却把「每次重启必然泄漏槽位」当成已知缺陷固化。审核包 R-01 / CODE-02
 * 又继续引用了这个结论。本文件用**生产代码**（createDispatcher / createRegistry）
 * 做运行级判定，并带负对照证明探针确实能抓到真实占用。
 *
 * 范围声明：这是进程内「新建 dispatcher 实例」的等价模拟，覆盖插件/宿主重启后
 * 的装配路径（src/index.js:393 每次 apply 都 createDispatcher），**不是** Windows
 * 上真实 Electron 进程重启的端到端测试。后者仍需人眼验收。
 *
 * 能失败的测试才是测试：
 * - 负对照（不新建实例、不回调 onFinish）必须看到槽位被占满并拒绝派单；
 * - 若把 createDispatcher 换成「复用旧实例」，下面第 2 组断言会失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createRegistry } from '../src/roles/registry.js'
import { createDispatcher, DISPATCH_ERRORS } from '../src/dispatch/dispatcher.js'

const role = {
  roleId: 'role-executor',
  name: '执行者',
  aliases: ['EX'],
  channel: { kind: 'acp-cli', cli: 'codebuddy' },
  enabled: true,
  timeoutMs: 1000,
}

const limits = {
  maxParallelWritesTotal: 2,
  maxParallelWritesPerSession: 2,
  serializeWrites: true,
  defaultIsolation: 'none',
}

/** 假适配器：启动成功但永不调用 onFinish（模拟被强杀、终态回调丢失）。 */
function neverFinishingAdapter() {
  /** @type {Array<any>} */
  const starts = []
  return {
    starts,
    async start(input) {
      starts.push(input)
      return { taskRef: { childId: `child-${starts.length}` } }
    },
  }
}

function freshDispatcher() {
  const adapter = neverFinishingAdapter()
  const dispatcher = createDispatcher({
    registry: createRegistry({ globalRoles: [role] }),
    adapter,
    limits,
  })
  return { dispatcher, adapter }
}

/** @param {any} dispatcher @param {string} projectKey */
const fire = (dispatcher, projectKey) =>
  dispatcher.dispatch({ role: 'EX', task: '独立任务', projectKey, isolation: 'none' })

test('负对照：终态回调不触发时，槽位确实被占满并拒绝派单', async () => {
  const { dispatcher, adapter } = freshDispatcher()
  const a = await fire(dispatcher, 'proj-a')
  const b = await fire(dispatcher, 'proj-b')
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(adapter.starts.length, 2, '两个任务都应真正启动')
  assert.equal(dispatcher.stats().active, 2, '两个槽位应仍被占用')

  const c = await fire(dispatcher, 'proj-c')
  assert.equal(c.ok, false)
  assert.equal(c.code, DISPATCH_ERRORS.WRITE_LIMIT_TOTAL, '占满后必须拒绝，探针才能证明有效')
  assert.equal(adapter.starts.length, 2, '被拒的派单不得触达适配器')
})

test('重启等价模拟：新建 dispatcher 实例后没有继承任何旧槽位', async () => {
  const before = freshDispatcher()
  await fire(before.dispatcher, 'proj-a')
  await fire(before.dispatcher, 'proj-b')
  assert.equal(before.dispatcher.stats().active, 2, '前提：旧实例确实占满')

  // src/index.js:393 —— 插件每次 apply 都会重新 createDispatcher，active 是实例内 Map。
  // 真实宿主/插件进程重启必然走这条装配路径，产生一个全新的空 Map。
  const after = freshDispatcher()
  assert.equal(after.dispatcher.stats().active, 0, '新实例不得继承旧进程的槽位')

  const a = await fire(after.dispatcher, 'proj-x')
  const b = await fire(after.dispatcher, 'proj-y')
  assert.equal(a.ok, true, '重启后第一个派单必须能成功')
  assert.equal(b.ok, true, '重启后第二个派单必须能成功')
  assert.equal(after.dispatcher.stats().active, 2)
})

test('槽位不落盘：dispatcher 源码里没有把 active 从磁盘恢复的路径', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/dispatch/dispatcher.js', import.meta.url)),
    'utf8',
  )
  const setCalls = source.match(/active\.set\(/g) ?? []
  assert.equal(setCalls.length, 1, 'active 只在 dispatch 的同步占位处写入一次')
  assert.ok(
    !/createRunStore|readRecords|listRuns\(/.test(source),
    'dispatcher 不得读取运行记录来回填 active（那是 get_task 的职责）',
  )
})

test('onFinish 到达时槽位正常释放：负对照里的阻塞是可恢复的', async () => {
  const { dispatcher, adapter } = freshDispatcher()
  await fire(dispatcher, 'proj-a')
  await fire(dispatcher, 'proj-b')
  for (const started of adapter.starts) started.onFinish()
  assert.equal(dispatcher.stats().active, 0)
  const again = await fire(dispatcher, 'proj-c')
  assert.equal(again.ok, true, '终态回调到达后应可继续派单')
})
