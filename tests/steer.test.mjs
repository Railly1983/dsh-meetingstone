// @ts-check
/**
 * `src/dsh/steer.js` 的测试。
 *
 * 重点：诚实性。插话有好几种「做不到」的情况（已终态、外部 CLI、已提交结果），
 * 每一种都必须**给出可读原因**，而不是静默失败或伪装成功。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSteerContent,
  canRestartWithOutput,
  extractPartialOutput,
  steerCapability,
  steerInProcess,
  translateSteerError,
} from '../src/dsh/steer.js'

test('steerCapability：进程内运行中 → 可插话', () => {
  const result = steerCapability({ status: 'running', provider: 'spawn' })
  assert.equal(result.capable, true)
  assert.equal(result.reason, '')
})

test('steerCapability：三个终态都不可插话，且原因含状态名', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const result = steerCapability({ status, provider: 'spawn' })
    assert.equal(result.capable, false)
    assert.match(result.reason, /终态/)
    assert.match(result.reason, new RegExp(status))
  }
})

test('steerCapability：外部 CLI 通道不可插话，原因说明 prepareContinuable', () => {
  for (const provider of ['acp', 'codex', 'claude-code', 'acp-kimi']) {
    const result = steerCapability({ status: 'running', provider })
    assert.equal(result.capable, false, `${provider} 不应被判定为可插话`)
    assert.match(result.reason, /prepareContinuable/)
    assert.match(result.reason, /restart-with-output/, '应给出替代方案')
  }
})

test('steerCapability：没有 provider 时按不支持处理（不乐观假设）', () => {
  const result = steerCapability({ status: 'running' })
  assert.equal(result.capable, false)
  assert.match(result.reason, /无法确认/)
})

test('steerCapability：没有记录时不可插话', () => {
  for (const record of [undefined, null, 'x', 42]) {
    const result = steerCapability(record)
    assert.equal(result.capable, false)
    assert.ok(result.reason)
  }
})

test('translateSteerError：INPUT_CLOSED 翻译成可读说明', () => {
  const error = Object.assign(new Error('subagent is submitting or has submitted its structured result'), {
    code: 'INPUT_CLOSED',
  })
  const result = translateSteerError(error)
  assert.equal(result.code, 'INPUT_CLOSED')
  assert.match(result.message, /已提交结构化结果/)
  assert.match(result.hint, /重新派单/)
})

test('translateSteerError：NOT_RESUMABLE 指出外部 CLI 不支持续聊', () => {
  const error = Object.assign(new Error('subagent "x" is unavailable'), { code: 'NOT_RESUMABLE' })
  const result = translateSteerError(error)
  assert.equal(result.code, 'NOT_RESUMABLE')
  assert.match(result.message, /无法恢复/)
  assert.match(result.hint, /restart-with-output/)
})

test('translateSteerError：UNAUTHORIZED 说明只能操作自己派出的任务', () => {
  const error = Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' })
  const result = translateSteerError(error)
  assert.match(result.message, /只能给自己派出的任务插话/)
})

test('translateSteerError：未知错误保留原始信息，不掩盖', () => {
  const result = translateSteerError(new Error('some weird failure'))
  assert.equal(result.code, 'STEER_FAILED')
  assert.match(result.message, /some weird failure/, '原始错误信息必须保留')
  assert.ok(result.hint, '即使未知也要给兜底建议')
})

test('translateSteerError：非 Error 值也能处理', () => {
  for (const value of [undefined, null, 'string err', 42]) {
    const result = translateSteerError(value)
    assert.ok(result.code)
    assert.ok(result.message)
    assert.ok(result.hint)
  }
})

test('buildSteerContent：返回宿主 content 形状', () => {
  const content = buildSteerContent('  停，不要动 A 文件  ')
  assert.deepEqual(content, [{ type: 'text', text: '停，不要动 A 文件' }], '首尾空白应被裁掉')
})

test('steerInProcess：正常投递，回执 mode=steer', async () => {
  /** @type {any[]} */
  const calls = []
  const subagents = {
    sendMessage: async (sender, targetId, content, options) => {
      calls.push({ sender, targetId, content, options })
      return 'msg-1'
    },
  }
  const parent = { id: 'lead' }
  const result = await steerInProcess({ subagents, parent, childId: 'run-1', instruction: '改方向' })
  assert.deepEqual(result, { ok: true, mode: 'steer', messageId: 'msg-1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].targetId, 'run-1')
  assert.deepEqual(calls[0].content, [{ type: 'text', text: '改方向' }])
})

test('steerInProcess：宿主没有 sendMessage 时如实失败', async () => {
  const result = await steerInProcess({
    subagents: {},
    parent: { id: 'lead' },
    childId: 'run-1',
    instruction: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STEER_UNAVAILABLE')
})

test('steerInProcess：缺少必需参数时明确拒绝', async () => {
  const subagents = { sendMessage: async () => 'msg' }
  const parent = { id: 'lead' }

  const noAgent = await steerInProcess({ subagents, parent: null, childId: 'r', instruction: 'x' })
  assert.equal(noAgent.code, 'NO_AGENT')

  const noChild = await steerInProcess({ subagents, parent, childId: '', instruction: 'x' })
  assert.equal(noChild.code, 'CHILD_REQUIRED')

  const noInstruction = await steerInProcess({ subagents, parent, childId: 'r', instruction: '   ' })
  assert.equal(noInstruction.code, 'INSTRUCTION_REQUIRED')
})

test('steerInProcess：宿主错误被翻译而非透传原始异常', async () => {
  const subagents = {
    sendMessage: async () => {
      throw Object.assign(new Error('subagent is submitting or has submitted its structured result'), {
        code: 'INPUT_CLOSED',
      })
    },
  }
  const result = await steerInProcess({
    subagents,
    parent: { id: 'lead' },
    childId: 'run-1',
    instruction: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INPUT_CLOSED')
  assert.match(result.message, /已提交结构化结果/)
})

test('canRestartWithOutput：有角色信息时可以重开', () => {
  assert.deepEqual(canRestartWithOutput({ roleId: 'role-sashi' }), { ok: true })
  assert.deepEqual(canRestartWithOutput({ role: 'role-sashi' }), { ok: true })
})

test('canRestartWithOutput：缺记录或缺角色时明确拒绝', () => {
  const noRecord = canRestartWithOutput(null)
  assert.equal(noRecord.code, 'RECORD_NOT_FOUND')

  const noRole = canRestartWithOutput({ status: 'cancelled' })
  assert.equal(noRole.code, 'ROLE_UNKNOWN')
  assert.match(noRole.hint, /role/)
})

test('extractPartialOutput：按优先级取已有的产出', () => {
  assert.equal(extractPartialOutput({ result: '最终结果' }).text, '最终结果')
  assert.equal(extractPartialOutput({ summary: '摘要' }).text, '摘要')
  assert.equal(extractPartialOutput({ output: '输出' }).text, '输出')
  assert.equal(extractPartialOutput({ detail: '详情' }).text, '详情')
  // 优先级：result > summary > output > detail
  assert.equal(
    extractPartialOutput({ result: 'R', summary: 'S', output: 'O', detail: 'D' }).text,
    'R',
  )
})

test('extractPartialOutput：空值/无记录返回空串，不抛', () => {
  for (const record of [undefined, null, {}, { result: '' }, { result: '   ' }]) {
    const result = extractPartialOutput(record)
    assert.equal(result.text, '')
    assert.equal(result.truncated, false)
  }
})
