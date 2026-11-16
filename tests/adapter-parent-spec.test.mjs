// @ts-check
/**
 * 回归测试：`startActivation` 的 spec 必须**同时**在顶层与 request 里带 parent。
 *
 * ## 背景（2026-11-15 真机故障）
 *
 * 宿主 `dsh-subagent` 对 parent 有**两处、不同层级**的读取：
 *   - `lib/index.js:3024`：`spec.parent.id` —— 顶层，live-parent 权限校验用
 *   - `lib/index.js:1598`：`request.parent` —— 嵌套，实际执行用
 *
 * 之前集合石只放了 `request.parent`，于是宿主读 `spec.parent.id` 时抛
 * `TypeError: Cannot read properties of undefined (reading 'id')`。
 * 该错误在 startActivation 内部抛出，被 dispatcher 包装成 ADAPTER_FAILED，
 * 表现成「派单失败：Cannot read properties of undefined (reading 'id')」，
 * 极易误判为集合石自己的 bug。
 *
 * 本测试把「两处都要有」固定成契约，防止回归。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshAdapter } from '../src/dsh/adapter.js'
import { createRegistry } from '../src/roles/registry.js'

const role = {
  roleId: 'role-test',
  name: '测试角色',
  setting: '测试用',
  channel: { kind: 'in-process', provider: 'spawn' },
  enabled: true,
  timeoutMs: 60000,
}
const registry = createRegistry({ globalRoles: [role] })

/** 通道实例表（空 = resolveRoute 走 kind/provider 兜底路径）。 */
const channels = []

/** 假 parent：形状模仿宿主 Agent（带 session.header.id）。 */
function makeParent() {
  return {
    id: 'sess-1',
    session: { id: 'sess-1', header: { id: 'sess-1', cwd: 'D:/proj' } },
  }
}

/**
 * 造一个会**记录 spec** 并模仿宿主校验的 subagents。
 * 刻意复刻宿主 3024 行的行为：顶层没有 parent 就抛 reading 'id'。
 */
function makeSubagents(captured, parent) {
  return {
    getProvider: (name) => ({ name, capabilities: {} }),
    startActivation: async (spec) => {
      captured.push(spec)
      // 复刻宿主 live-parent 校验（spec.parent.id）
      if (!spec.parent) {
        const err = new TypeError("Cannot read properties of undefined (reading 'id')")
        throw err
      }
      if (spec.parent !== parent) {
        const err = new Error('subagent creation requires the exact live parent agent')
        err.code = 'UNAUTHORIZED'
        throw err
      }
      // 复刻执行侧读 request.parent
      if (!spec.request || !spec.request.parent) {
        throw new Error('request.parent missing')
      }
      // 复刻宿主 submitMaterialized(activation, spec.prompt, ...)：
      // 顶层 prompt 必须是数组，否则 contentHasImage 抛 reading 'some'
      if (!Array.isArray(spec.prompt)) {
        const err = new TypeError("Cannot read properties of undefined (reading 'some')")
        throw err
      }
      return {
        childId: 'child-ok',
        name: 'x',
        result: new Promise(() => {}),
        dispose: async () => {},
      }
    },
  }
}

function makeAdapter(subagents, parent) {
  const ctx = {
    subagents,
    effect: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
    agents: { get: () => parent },
  }
  return createDshAdapter(ctx, { getParent: () => parent })
}

test('spec 顶层必须带 parent（宿主 3024 行校验 spec.parent.id）', async () => {
  const parent = makeParent()
  const captured = []
  const adapter = makeAdapter(makeSubagents(captured, parent), parent)

  const started = await adapter.start({
    // 传**解析后的 role 对象**（dispatcher 就是这么传的）；
    // 传字符串会让 resolveRoute 拿不到 channel → PROVIDER_UNAVAILABLE。
    role: registry.resolve('role-test'),
    task: 'hello',
    registry,
    context: { agent: parent },
  })

  assert.ok(started?.taskRef?.childId, '派单应成功')
  assert.equal(captured.length, 1, '应调用一次 startActivation')
  const spec = captured[0]

  // 核心断言：顶层 parent 存在且是同一个对象（宿主用 !== 严格比较）
  assert.ok(spec.parent, 'spec.parent 必须存在（否则宿主抛 reading id）')
  assert.equal(spec.parent, parent, 'spec.parent 必须是同一个 live agent 对象')

  // 嵌套的也应保留（执行侧用）
  assert.ok(spec.request?.parent, 'spec.request.parent 仍须保留')
  assert.equal(spec.request.parent, parent)

  // 顶层 prompt 也必须是数组（宿主 submitMaterialized 读 spec.prompt）
  assert.ok(Array.isArray(spec.prompt), 'spec.prompt 必须是数组（否则宿主抛 reading some）')
  assert.ok(spec.prompt.length > 0, 'spec.prompt 不能为空')
  assert.equal(spec.prompt[0].type, 'text', '首个块应是 text')
  // 嵌套的 prompt 也要在
  assert.ok(Array.isArray(spec.request?.prompt), 'spec.request.prompt 仍须保留')
})

test('负对照：故意删掉顶层 parent，宿主式校验会抛 reading id', async () => {
  const parent = makeParent()
  const captured = []
  const subagents = makeSubagents(captured, parent)

  // 模拟修复前的行为：只给 request.parent
  const broken = {
    getProvider: subagents.getProvider,
    startActivation: async (spec) => {
      const withoutTop = { ...spec }
      delete withoutTop.parent
      return subagents.startActivation(withoutTop)
    },
  }
  const adapter = makeAdapter(broken, parent)

  await assert.rejects(
    () =>
      adapter.start({
        role: registry.resolve('role-test'),
        task: 'x',
        registry,
        context: { agent: parent },
      }),
    (err) => {
      assert.match(String(err.message), /reading 'id'/, '应复现真实的 reading id 错误')
      return true
    },
    '没有顶层 parent 时必须失败，证明该断言真的能抓到问题',
  )
})

test('parent 不是 live agent 时抛 UNAUTHORIZED（错误码不被吞）', async () => {
  const parent = makeParent()
  const captured = []
  const adapter = makeAdapter(makeSubagents(captured, parent), parent)

  const impostor = { id: 'sess-1', session: { id: 'sess-1', header: { id: 'sess-1' } } }
  await assert.rejects(
    () =>
      adapter.start({
        role: registry.resolve('role-test'),
        task: 'x',
        registry,
        context: { agent: impostor },
      }),
    (err) => err.code === 'UNAUTHORIZED' || /exact live parent/.test(String(err.message)),
  )
})
