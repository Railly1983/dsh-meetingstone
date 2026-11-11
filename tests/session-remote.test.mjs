// @ts-check
/**
 * 会话 Remote 的 Host 包装：业务错误 → 宿主 RemoteError（稳定 code）。
 * 纯逻辑，不依赖 Gateway/Typert 传输。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionRemoteHandlers } from '../src/gui/session-remote.js'
import { SESSION_GUI_ERRORS } from '../src/gui/session.js'

class FakeRemoteError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
    this.isDSHRemoteError = true
  }
}

function makeApi() {
  const calls = []
  return {
    calls,
    api: {
      getSessionConfig(sessionId) {
        calls.push(['get', sessionId])
        return { effective: { roles: [] }, overrides: {}, sources: {} }
      },
      setSessionOverride(sessionId, roleId, field, value) {
        calls.push(['set', sessionId, roleId, field, value])
        return { ok: true, written: true, patch: { [field]: value } }
      },
      clearSessionOverride(sessionId, roleId, field) {
        calls.push(['clear', sessionId, roleId, field])
        return { ok: true, removed: true }
      },
    },
  }
}

test('透传参数与返回值：get/set/clear', async () => {
  const { api, calls } = makeApi()
  const handlers = createSessionRemoteHandlers(api, { RemoteError: FakeRemoteError })

  assert.deepEqual(await handlers.getSessionConfig('sess-1'), {
    effective: { roles: [] },
    overrides: {},
    sources: {},
  })
  assert.deepEqual(await handlers.setSessionOverride('sess-1', 'role-a', 'model', 'm-1'), {
    ok: true,
    written: true,
    patch: { model: 'm-1' },
  })
  assert.deepEqual(await handlers.clearSessionOverride('sess-1', 'role-a'), {
    ok: true,
    removed: true,
  })
  assert.deepEqual(calls, [
    ['get', 'sess-1'],
    ['set', 'sess-1', 'role-a', 'model', 'm-1'],
    ['clear', 'sess-1', 'role-a', undefined],
  ])
})

test('业务错误：转成 RemoteError 并保留 code（Gateway 可原样回传）', async () => {
  const api = {
    getSessionConfig() {
      throw Object.assign(new Error('找不到项目根'), { code: SESSION_GUI_ERRORS.SESSION_ROOT_UNKNOWN })
    },
    setSessionOverride() {
      throw Object.assign(new Error('坏角色'), { code: SESSION_GUI_ERRORS.INVALID_ROLE_ID })
    },
    clearSessionOverride() {
      throw new Error('普通错误')
    },
  }
  const handlers = createSessionRemoteHandlers(api, { RemoteError: FakeRemoteError })

  await assert.rejects(handlers.getSessionConfig('sess-x'), (error) => {
    assert.ok(error instanceof FakeRemoteError)
    assert.equal(error.code, SESSION_GUI_ERRORS.SESSION_ROOT_UNKNOWN)
    assert.equal(error.details && typeof error.details, 'object')
    return true
  })
  await assert.rejects(handlers.setSessionOverride('sess-x', 'ghost', 'model', 'x'), (error) => {
    assert.equal(error.code, SESSION_GUI_ERRORS.INVALID_ROLE_ID)
    return true
  })
  await assert.rejects(handlers.clearSessionOverride('sess-x', 'role-a'), (error) => {
    assert.equal(error.code, 'MEETINGSTONE_GUI_REMOTE_FAILED')
    return true
  })
})

test('没有 RemoteError 类时退回带 code 的普通 Error（不抛 TypeError）', async () => {
  const api = {
    getSessionConfig() {
      throw Object.assign(new Error('坏会话'), { code: SESSION_GUI_ERRORS.INVALID_SESSION_ID })
    },
    setSessionOverride() {},
    clearSessionOverride() {},
  }
  const handlers = createSessionRemoteHandlers(api)
  await assert.rejects(handlers.getSessionConfig('../evil'), (error) => {
    assert.equal(error.code, SESSION_GUI_ERRORS.INVALID_SESSION_ID)
    assert.ok(error instanceof Error)
    return true
  })
})
