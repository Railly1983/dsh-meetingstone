// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRegistry } from '../src/roles/registry.js'
import { createDispatcher, DISPATCH_ERRORS } from '../src/dispatch/dispatcher.js'

const role = (over = {}) => ({
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli', cli: 'codebuddy' },
  permissionPreset: 'project-write',
  enabled: true,
  timeoutMs: 1000,
  ...over,
})

const roles = [
  role(),
  role({ roleId: 'role-reviewer', name: '审核员', aliases: ['RV'], permissionPreset: 'read-only' }),
  role({ roleId: 'role-off', name: '停用的', aliases: ['OFF'], enabled: false }),
]

/** 假适配器：记录调用，返回可识别的 taskRef。 */
function fakeAdapter(over = {}) {
  const calls = []
  let seq = 0
  const adapter = {
    calls,
    start: async (input) => {
      calls.push(input)
      seq += 1
      return { taskRef: { id: seq } }
    },
    ...over,
  }
  return adapter
}

function makeDispatcher(adapterOver = {}, limits = {}) {
  const adapter = fakeAdapter(adapterOver)
  const registry = createRegistry({ globalRoles: roles })
  const dispatcher = createDispatcher({ registry, adapter, limits })
  return { dispatcher, adapter, registry }
}

test('正常派单：返回 taskRef 与角色', async () => {
  const { dispatcher, adapter } = makeDispatcher()
  const res = await dispatcher.dispatch({ role: 'SS', task: '改个函数' })
  assert.equal(res.ok, true)
  assert.ok(res.taskRef)
  assert.equal(res.role.roleId, 'role-sashi')
  assert.equal(adapter.calls.length, 1)
  assert.equal(adapter.calls[0].readOnly, false)
  assert.equal(adapter.calls[0].timeoutMs, 1000)
})

test('角色不存在 / 停用 / 歧义 分别报错', async () => {
  const { dispatcher } = makeDispatcher()

  const missing = await dispatcher.dispatch({ role: '不存在', task: 'x' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, DISPATCH_ERRORS.ROLE_NOT_FOUND)

  const disabled = await dispatcher.dispatch({ role: 'OFF', task: 'x' })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.code, DISPATCH_ERRORS.ROLE_DISABLED)
})

test('空任务/空角色被拒', async () => {
  const { dispatcher, adapter } = makeDispatcher()
  const a = await dispatcher.dispatch({ role: 'SS', task: '   ' })
  assert.equal(a.code, DISPATCH_ERRORS.INVALID_TASK)
  const b = await dispatcher.dispatch({ role: '', task: 'x' })
  assert.equal(b.code, DISPATCH_ERRORS.ROLE_NOT_FOUND)
  assert.equal(adapter.calls.length, 0, '校验失败不应触达适配器')
})

test('只读角色自动走只读；写角色不能借 readOnly 反向放宽', async () => {
  const { dispatcher, adapter } = makeDispatcher()

  await dispatcher.dispatch({ role: 'RV', task: '审一下' })
  assert.equal(adapter.calls[0].readOnly, true, '只读角色必须只读')

  // 写角色显式 readOnly=true → 往更严方向，允许
  await dispatcher.dispatch({ role: 'SS', task: '看看', readOnly: true })
  assert.equal(adapter.calls[1].readOnly, true)

  // 只读角色无法被 readOnly=false 放宽（这里传 false 应仍然只读）
  await dispatcher.dispatch({ role: 'RV', task: '再审', readOnly: false })
  assert.equal(adapter.calls[2].readOnly, true, '不得放宽只读角色')
})

test('写任务串行：第二个写任务被拒，释放后可继续', async () => {
  const { dispatcher, adapter } = makeDispatcher()
  const first = await dispatcher.dispatch({ role: 'SS', task: '写 A' })
  assert.equal(first.ok, true)

  const second = await dispatcher.dispatch({ role: 'SS', task: '写 B' })
  assert.equal(second.ok, false)
  assert.equal(second.code, DISPATCH_ERRORS.WRITE_CONFLICT)
  assert.equal(adapter.calls.length, 1, '被拒的请求不应触达适配器')

  dispatcher.release(first.taskRef)
  const third = await dispatcher.dispatch({ role: 'SS', task: '写 C' })
  assert.equal(third.ok, true)
})

test('只读任务可并行，直到上限', async () => {
  const { dispatcher, adapter } = makeDispatcher({}, { maxParallelReadonly: 2 })
  const a = await dispatcher.dispatch({ role: 'RV', task: '1' })
  const b = await dispatcher.dispatch({ role: 'RV', task: '2' })
  assert.equal(a.ok && b.ok, true)

  const c = await dispatcher.dispatch({ role: 'RV', task: '3' })
  assert.equal(c.ok, false)
  assert.equal(c.code, DISPATCH_ERRORS.READONLY_LIMIT)

  dispatcher.release(a.taskRef)
  const d = await dispatcher.dispatch({ role: 'RV', task: '4' })
  assert.equal(d.ok, true)
  assert.equal(adapter.calls.length, 3)
})

test('provider 不可用时给出可诊断错误，而不是抛异常', async () => {
  const { dispatcher, adapter } = makeDispatcher({
    canStart: () => ({ ok: false, reason: 'provider acp 未注册' }),
  })
  const res = await dispatcher.dispatch({ role: 'SS', task: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, DISPATCH_ERRORS.PROVIDER_UNAVAILABLE)
  assert.match(res.message, /provider acp 未注册/)
  assert.equal(adapter.calls.length, 0)
})

test('canStart 抛异常也被兜住', async () => {
  const { dispatcher } = makeDispatcher({
    canStart: () => {
      throw new Error('boom')
    },
  })
  const res = await dispatcher.dispatch({ role: 'SS', task: 'x' })
  assert.equal(res.code, DISPATCH_ERRORS.PROVIDER_UNAVAILABLE)
  assert.match(res.message, /boom/)
})

test('适配器失败（throw 或没返回 taskRef）都转成 ADAPTER_FAILED', async () => {
  const throwing = makeDispatcher({
    start: async () => {
      throw new Error('spawn ENOENT')
    },
  })
  const a = await throwing.dispatcher.dispatch({ role: 'SS', task: 'x' })
  assert.equal(a.code, DISPATCH_ERRORS.ADAPTER_FAILED)
  assert.match(a.message, /spawn ENOENT/)

  const empty = makeDispatcher({ start: async () => ({}) })
  const b = await empty.dispatcher.dispatch({ role: 'SS', task: 'x' })
  assert.equal(b.code, DISPATCH_ERRORS.ADAPTER_FAILED)
})

test('stats 反映活跃任务，释放后归零', async () => {
  const { dispatcher } = makeDispatcher({}, { maxParallelReadonly: 3 })
  const r1 = await dispatcher.dispatch({ role: 'SS', task: 'w' })
  const r2 = await dispatcher.dispatch({ role: 'RV', task: 'r1' })
  const r3 = await dispatcher.dispatch({ role: 'RV', task: 'r2' })
  assert.deepEqual(dispatcher.stats(), {
    active: 3,
    writes: 1,
    readonly: 2,
    maxParallelReadonly: 3,
    serializeWrites: true,
  })
  dispatcher.release(r1.taskRef)
  dispatcher.release(r2.taskRef)
  dispatcher.release(r3.taskRef)
  assert.equal(dispatcher.stats().active, 0)
})

test('cancel 调用适配器并释放槽位', async () => {
  const cancelled = []
  const { dispatcher } = makeDispatcher({
    cancel: async (ref) => {
      cancelled.push(ref)
    },
  })
  const res = await dispatcher.dispatch({ role: 'SS', task: 'x' })
  await dispatcher.cancel(res.taskRef)
  assert.equal(cancelled.length, 1)
  assert.equal(dispatcher.stats().active, 0)
})

// ─── P2 Gate 复核后的回归用例（唐僧复现的两个 bug） ───────────────────────────

test('并发写请求：先占槽再启动，第二个必须被拒（旧实现两个都成功）', async () => {
  /** @type {(v: any) => void} */
  let releaseStart
  const calls = []
  const registry = createRegistry({ globalRoles: roles })
  const adapter = {
    start: (input) => {
      calls.push(input)
      return new Promise((resolve) => {
        releaseStart = resolve
      })
    },
  }
  const dispatcher = createDispatcher({ registry, adapter })

  const first = dispatcher.dispatch({ role: 'SS', task: '写 A' })
  // 第一个还没返回（start pending），此时第二个写请求必须被挡
  const second = await dispatcher.dispatch({ role: 'SS', task: '写 B' })
  assert.equal(second.ok, false)
  assert.equal(second.code, DISPATCH_ERRORS.WRITE_CONFLICT)
  assert.equal(calls.length, 1, '第二个请求不得触达适配器')

  releaseStart({ taskRef: { id: 't1' } })
  assert.equal((await first).ok, true)
})

test('onFinish 释放槽位：任务结束后可以继续派单（旧实现永久占槽）', async () => {
  const captured = []
  const registry = createRegistry({ globalRoles: roles })
  const adapter = {
    start: async (input) => {
      captured.push(input)
      return { taskRef: { id: `t${captured.length}` } }
    },
  }
  const dispatcher = createDispatcher({ registry, adapter })

  const a = await dispatcher.dispatch({ role: 'SS', task: '写 A' })
  assert.equal(a.ok, true)
  assert.equal(dispatcher.stats().active, 1)

  // 适配器在任务终态回调 onFinish
  captured[0].onFinish()
  assert.equal(dispatcher.stats().active, 0, 'onFinish 后槽位应释放')

  const b = await dispatcher.dispatch({ role: 'SS', task: '写 B' })
  assert.equal(b.ok, true, '槽位释放后应能继续派单')
})

test('onFinish 幂等：重复回调不会误删别人的槽位', async () => {
  const captured = []
  const registry = createRegistry({ globalRoles: roles })
  const adapter = {
    start: async (input) => {
      captured.push(input)
      return { taskRef: { id: `t${captured.length}` } }
    },
  }
  const dispatcher = createDispatcher({ registry, adapter, limits: { maxParallelReadonly: 2 } })

  const a = await dispatcher.dispatch({ role: 'RV', task: 'r1' })
  const b = await dispatcher.dispatch({ role: 'RV', task: 'r2' })
  assert.equal(a.ok && b.ok, true)

  captured[0].onFinish()
  captured[0].onFinish() // 重复
  assert.equal(dispatcher.stats().active, 1, '只应释放一个槽位')
})

test('跨项目隔离：不同项目各占一个写槽，互不误挡', async () => {
  const registry = createRegistry({ globalRoles: roles })
  const adapter = { start: async () => ({ taskRef: { id: Math.random().toString(36) } }) }
  const dispatcher = createDispatcher({ registry, adapter })

  const a = await dispatcher.dispatch({ role: 'SS', task: '写 A', projectKey: 'D:/proj-a' })
  assert.equal(a.ok, true)

  const b = await dispatcher.dispatch({ role: 'SS', task: '写 B', projectKey: 'D:/proj-b' })
  assert.equal(b.ok, true, '不同项目的写任务不应互相阻塞')

  const c = await dispatcher.dispatch({ role: 'SS', task: '写 C', projectKey: 'D:/proj-a' })
  assert.equal(c.code, DISPATCH_ERRORS.WRITE_CONFLICT, '同项目第二个写任务仍应串行')
})

test('启动失败要回滚槽位，不能把项目永久锁死', async () => {
  const registry = createRegistry({ globalRoles: roles })
  let attempt = 0
  const adapter = {
    start: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('spawn ENOENT')
      return { taskRef: { id: 't2' } }
    },
  }
  const dispatcher = createDispatcher({ registry, adapter })

  const first = await dispatcher.dispatch({ role: 'SS', task: '写 A' })
  assert.equal(first.ok, false)
  assert.equal(first.code, DISPATCH_ERRORS.ADAPTER_FAILED)
  assert.equal(dispatcher.stats().active, 0, '失败必须回滚占位')

  const second = await dispatcher.dispatch({ role: 'SS', task: '写 B' })
  assert.equal(second.ok, true, '回滚后应能重试')
})

test('歧义角色：名字被挡，但 roleId 仍然可用（纠错提示不能是空话）', async () => {
  const conflicting = [
    { roleId: 'role-a', name: '同名', aliases: [], channel: { kind: 'in-process' }, permissionPreset: 'read-only', enabled: true },
    { roleId: 'role-b', name: '同名', aliases: [], channel: { kind: 'in-process' }, permissionPreset: 'read-only', enabled: true },
  ]
  const registry = createRegistry({ globalRoles: conflicting })
  const adapter = { start: async () => ({ taskRef: { id: 't' } }) }
  const dispatcher = createDispatcher({ registry, adapter })

  const byName = await dispatcher.dispatch({ role: '同名', task: 'x' })
  assert.equal(byName.code, DISPATCH_ERRORS.ROLE_AMBIGUOUS)
  assert.match(byName.message, /role-a|role-b/, '提示里要给出可用的 roleId')

  const byId = await dispatcher.dispatch({ role: 'role-a', task: 'x' })
  assert.equal(byId.ok, true, '明确给 roleId 时不应被歧义挡住')
})
