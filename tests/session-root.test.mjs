// @ts-check
/**
 * sessionId → 项目根 官方解析测试（P0-S0 新会话定位）。
 *
 * 覆盖：
 *  - live `ctx.sessions.get(id).header.cwd` 优先（新会话未派单也能读）；
 *  - `ctx.agents.get(id).session.header.cwd` 次选；
 *  - 派单映射只作兜底；
 *  - 无证据/非法 id 返回 null，不猜路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionRootResolver } from '../src/gui/session-root.js'

function contextWith({ sessions, agents } = {}) {
  return {
    reflect: {
      get(name) {
        if (name === 'sessions') return sessions ?? null
        if (name === 'agents') return agents ?? null
        return null
      },
    },
  }
}

test('新会话未派单：ctx.sessions.get 的 header.cwd 直接解析（不依赖 sessionRoots）', () => {
  let fallbackCalls = 0
  const resolve = createSessionRootResolver({
    ctx: contextWith({
      sessions: { get: (id) => (id === 'sess-new' ? { header: { id, cwd: 'D:/proj-new' } } : undefined) },
    }),
    fallback: () => {
      fallbackCalls += 1
      return null
    },
  })
  assert.equal(resolve('sess-new'), 'D:/proj-new')
  assert.equal(fallbackCalls, 0, '官方 live 查询命中时不应走派单映射')
})

test('ctx.sessions 缺失/未命中：回退 ctx.agents.get 的 session.header.cwd', () => {
  const resolve = createSessionRootResolver({
    ctx: contextWith({
      sessions: { get: () => undefined },
      agents: {
        get: (id) => (id === 'sess-live' ? { session: { header: { id, cwd: 'D:/proj-live' } } } : undefined),
      },
    }),
  })
  assert.equal(resolve('sess-live'), 'D:/proj-live')
})

test('两个官方服务都没有：使用派单映射兜底（旧行为仍可用）', () => {
  const roots = new Map([['sess-dispatched', 'D:/proj-dispatch']])
  const resolve = createSessionRootResolver({
    ctx: contextWith({}),
    fallback: (id) => roots.get(id) ?? null,
  })
  assert.equal(resolve('sess-dispatched'), 'D:/proj-dispatch')
})

test('无证据：返回 null，不猜路径；非法 id/空 id 直接 null', () => {
  const resolve = createSessionRootResolver({
    ctx: contextWith({
      sessions: { get: () => ({ header: {} }) },
      agents: { get: () => ({ session: { header: { cwd: '' } } }) },
    }),
  })
  assert.equal(resolve('sess-unknown'), null)
  assert.equal(resolve(''), null)
  assert.equal(resolve(null), null)
  assert.equal(resolve(123), null)
})

test('服务读取抛错：吞掉异常并继续兜底（不拖垮 GUI）', () => {
  const ctx = {
    reflect: {
      get(name) {
        if (name === 'sessions') throw new Error('service boom')
        if (name === 'agents') return { get: () => ({ session: { header: { cwd: 'D:/proj-agent' } } }) }
        return null
      },
    },
  }
  const resolve = createSessionRootResolver({ ctx })
  assert.equal(resolve('sess-boom'), 'D:/proj-agent')
})

test('get()/fallback 抛错：都按未找到处理，异常不外泄', () => {
  const resolve = createSessionRootResolver({
    ctx: {
      reflect: {
        get(name) {
          if (name === 'sessions') return { get: () => { throw new Error('session boom') } }
          if (name === 'agents') return { get: () => { throw new Error('agent boom') } }
          return null
        },
      },
    },
    fallback: () => {
      throw new Error('fallback boom')
    },
  })
  assert.equal(resolve('sess-boom'), null)
})

test('无 ctx：只走 fallback', () => {
  const resolve = createSessionRootResolver({ fallback: () => 'D:/fallback-only' })
  assert.equal(resolve('sess-1'), 'D:/fallback-only')
})
