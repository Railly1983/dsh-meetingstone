// @ts-check
/**
 * Token 输出优化测试（2026-11-11 审计）。
 *
 * - get_task 默认摘要（首 1KiB + 末 512B）/ full:true 全文 / output 与 result 只回一份
 * - dispatch 成功回执瘦身（不回 role 全量、prompt、worktree）
 * - list_roles 默认紧凑、verbose:true 才给详细字段
 * - 上下文中继字节数（continuationBytes）落盘
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerTools, TOOL_NAMES, TASK_RESULT_HEAD_BYTES, TASK_RESULT_TAIL_BYTES } from '../src/dsh/register.js'
import { createDshAdapter } from '../src/dsh/adapter.js'
import { createRunStore, truncateUtf8 } from '../src/run-store.js'

/** @param {Record<string, object>} tools */
function makeTools(depsOver = {}) {
  const registered = new Map()
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: {
        list: () => [
          {
            roleId: 'role-sashi',
            name: '沙僧',
            aliases: ['SS'],
            channel: { kind: 'acp-cli', channelId: 'ch-acp', model: 'hy4' },
            enabled: true,
            description: '技术骨干',
            prompt: '你是技术骨干。',
            source: 'global',
          },
        ],
        errors: [],
      },
      dispatcher: {
        dispatch: async () => ({ ok: false, code: 'UNUSED', message: 'unused' }),
        getTask: async () => ({ status: 'unknown' }),
        cancel: async () => ({ stopConfirmed: false }),
      },
      probe: { probe: async () => ({}), probeAll: async () => [] },
      ...depsOver,
    },
  )
  return registered
}

test('get_task 默认摘要：首 1KiB + 末 512B、resultBytes、jobId、recordPath，且只回一份正文', async () => {
  const head = 'HEAD-开头\n'
  const middle = '中'.repeat(4000)
  const tail = '\nTAIL-结尾'
  const fullText = `${head}${middle}${tail}`
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => ({
        childId: 'c1',
        status: 'completed',
        stopReason: 'completed',
        output: fullText,
        result: fullText,
        jobId: 'meetingstone-dispatch-0001',
      }),
    },
    recordPathFor: () => 'D:/proj/.meetingstone/runs/c1.json',
  })
  const out = await tools.get(TOOL_NAMES.GET_TASK).execute(
    { childId: 'c1' },
    { agent: { session: { header: { cwd: 'D:/proj' } } } },
  )
  assert.equal(out.status, 'completed')
  assert.equal(out.jobId, 'meetingstone-dispatch-0001')
  assert.equal(out.recordPath, 'D:/proj/.meetingstone/runs/c1.json')
  assert.equal(out.resultBytes, Buffer.byteLength(fullText, 'utf8'))
  assert.equal(out.resultTruncated, true)
  assert.ok(out.result.startsWith(head.trimEnd()), '必须保留开头')
  assert.ok(out.result.endsWith(tail.trimStart()), '必须保留结尾')
  assert.ok(out.result.includes('truncated'), '截断必须有标记')
  assert.ok(
    Buffer.byteLength(out.result, 'utf8') <= TASK_RESULT_HEAD_BYTES + TASK_RESULT_TAIL_BYTES,
    '摘要不得超过 1KiB + 512B',
  )
  assert.equal(Object.hasOwn(out, 'output'), false, 'output/result 相同必须只回一份')
})

test('get_task full:true：返回全文，仍然只回一份正文', async () => {
  const fullText = `${'头'.repeat(2000)}${'尾'.repeat(2000)}`
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => ({ childId: 'c2', status: 'completed', output: fullText }),
    },
  })
  const out = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c2', full: true })
  assert.equal(out.result, fullText)
  assert.equal(out.resultBytes, Buffer.byteLength(fullText, 'utf8'))
  assert.equal(out.resultTruncated, false)
  assert.equal(Object.hasOwn(out, 'output'), false)
})

test('get_task 小结果：默认摘要就是全文，不额外截断', async () => {
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => ({ childId: 'c3', status: 'completed', result: 'PONG' }),
    },
  })
  const out = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c3' })
  assert.equal(out.result, 'PONG')
  assert.equal(out.resultTruncated, false)
  assert.equal(out.resultBytes, 4)
})

test('get_task 摘要：结构化 acceptance/permissions/safetyPolicy 原样保留，不参与截断', async () => {
  const acceptance = ['取消后父子进程都必须退出', 'run 记录状态必须仍是 cancelled']
  const permissions = 'read-only：不得写入工作区'
  const safetyPolicy = '不得修改宿主 DSH profile'
  const scope = { include: ['src/dsh'], exclude: ['docs/'] }
  const fullText = `${'开头'.repeat(2000)}${'中间填充'.repeat(2000)}${'结尾'.repeat(2000)}`
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => ({
        childId: 'c-protected',
        status: 'cancelled',
        output: fullText,
        acceptance,
        scope,
        permissions,
        safetyPolicy,
      }),
    },
  })
  const out = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c-protected' })
  assert.equal(out.resultTruncated, true)
  assert.deepEqual(out.protected.acceptance, acceptance, 'acceptance 必须原样、完整')
  assert.equal(out.protected.permissions, permissions)
  assert.equal(out.protected.safetyPolicy, safetyPolicy)
  assert.deepEqual(out.protected.scope, scope)
  // 文本视图里也必须能看到（来自不截断的保护块，而不是首尾窗口的偶然残片）
  assert.ok(out.result.includes('- 取消后父子进程都必须退出'))
  assert.ok(out.result.includes(permissions))
  assert.ok(out.result.includes(safetyPolicy))
})

test('get_task 有 summary 时：正文可省略，但 acceptance 仍完整返回', async () => {
  const acceptance = ['必须说明进程是否真正退出', '必须给出可复现的测试命令']
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => ({
        childId: 'c-summary-protected',
        status: 'completed',
        summary: '结论摘要：已完成',
        output: 'x'.repeat(20000),
        acceptance,
      }),
    },
  })
  const out = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c-summary-protected' })
  assert.equal(out.resultOmitted, true)
  assert.equal(Object.hasOwn(out, 'result'), false, '默认仍不回原始正文')
  assert.deepEqual(out.protected.acceptance, acceptance, '有 summary 也不得丢验收标准')
  assert.ok(JSON.stringify(out).includes('必须给出可复现的测试命令'))
})

test('get_task 摘要：自由文本中间的验收/权限段被截断时必须原样找回', async () => {
  const middle = ['验收标准：', '- 取消后父子进程都必须退出', '权限限制：只读，不得写盘'].join('\n')
  const text = `${'头'.repeat(3000)}\n\n${middle}\n\n${'尾'.repeat(3000)}`
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => ({ childId: 'c-middle', status: 'completed', output: text }),
    },
  })
  const out = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c-middle' })
  assert.equal(out.resultTruncated, true)

  // 变异证据：修复前的纯首尾截断必然丢掉中间段；若保护逻辑被删，下面的断言会失败。
  const headTail = truncateUtf8(text, TASK_RESULT_HEAD_BYTES + TASK_RESULT_TAIL_BYTES, {
    headBytes: TASK_RESULT_HEAD_BYTES,
    tailBytes: TASK_RESULT_TAIL_BYTES,
  })
  assert.equal(headTail.text.includes('验收标准'), false, '纯首尾截断本来会丢中间验收段')
  assert.ok(out.result.includes('验收标准'))
  assert.ok(out.result.includes('- 取消后父子进程都必须退出'))
  assert.ok(out.result.includes('权限限制：只读，不得写盘'))
})

test('dispatch 成功回执瘦身：只回 ok/taskRef/roleId/roleName/isolation/routing', async () => {
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({
        ok: true,
        taskRef: {
          kind: 'subagent-activation',
          childId: 'child-1',
          name: 'agent-1',
          provider: 'codex',
          jobId: 'meetingstone-dispatch-0001',
          operationId: 'op-1',
          startedAt: 1,
        },
        role: {
          roleId: 'role-wukong',
          name: '悟空',
          prompt: 'SECRET-PERSONA',
          channel: { kind: 'codex', model: 'secret-model' },
          description: 'SECRET-DESCRIPTION',
        },
        startedAt: 1,
        isolation: 'worktree',
        operationId: 'op-1',
        worktree: { path: 'D:/SECRET-WORKTREE', branch: 'meetingstone/op-1' },
      }),
      getTask: async () => ({ status: 'unknown' }),
    },
  })
  const out = await tools.get(TOOL_NAMES.DISPATCH).execute({ role: 'WK', task: 'x' })
  assert.deepEqual(Object.keys(out).sort(), [
    'isolation',
    'ok',
    'roleId',
    'roleName',
    'routing',
    'taskRef',
  ])
  // P1-B：手动指定角色 → auto:false 且不写 reason（不能伪装成规则选的）
  assert.deepEqual(out.routing, { roleId: 'role-wukong', auto: false })
  assert.equal(Object.hasOwn(out.routing, 'reason'), false)
  assert.deepEqual(Object.keys(out.taskRef).sort(), ['childId', 'jobId', 'name', 'provider'])
  assert.equal(out.roleId, 'role-wukong')
  assert.equal(out.roleName, '悟空')
  assert.equal(out.isolation, 'worktree')
  const serialized = JSON.stringify(out)
  for (const forbidden of ['SECRET-PERSONA', 'SECRET-DESCRIPTION', 'SECRET-WORKTREE', 'secret-model']) {
    assert.equal(serialized.includes(forbidden), false, `回执不得包含 ${forbidden}`)
  }
})

test('dispatch 失败结果保持原样（错误上下文不能被瘦身丢掉）', async () => {
  const failure = {
    ok: false,
    code: 'WORKTREE_GIT_FAILED',
    message: '建树失败',
    path: 'D:/proj/.meetingstone/worktrees/op-1',
    branch: 'meetingstone/op-1',
    phase: 'list-worktrees',
    residualPath: 'D:/proj/.meetingstone/worktrees/op-1',
  }
  const tools = makeTools({
    dispatcher: { dispatch: async () => failure, getTask: async () => ({ status: 'unknown' }) },
  })
  const out = await tools.get(TOOL_NAMES.DISPATCH).execute({ role: 'WK', task: 'x' })
  assert.deepEqual(out, failure)
})

test('list_roles 默认紧凑（5 个字段）；verbose:true 才回设定/CLI/模型/强度', async () => {
  const tools = makeTools()
  const compact = await tools.get(TOOL_NAMES.LIST_ROLES).execute({})
  assert.deepEqual(Object.keys(compact.roles[0]).sort(), [
    'aliases',
    'availability',
    'enabled',
    'name',
    'roleId',
  ])

  const verbose = await tools.get(TOOL_NAMES.LIST_ROLES).execute({ verbose: true })
  const role = verbose.roles[0]
  // B2：description+prompt 合并为单一设定；用户可见 CLI/模型/强度，不再有「通道」
  assert.equal(role.setting, '你是技术骨干。')
  assert.equal(role.hasPrompt, true)
  assert.equal(role.channelId, 'ch-acp')
  assert.equal(role.model, 'hy4')
  assert.equal(role.cli, 'acp-cli')
  assert.equal(Object.hasOwn(role, 'channel'), false, '不得再返回 channel 结构')
  assert.equal(role.source, 'global')
})

test('continuationBytes：适配器 running 记录带实际重放字节数', async () => {
  const started = []
  let resolveResult
  const ctx = {
    subagents: {
      getProvider: (name) => (name === 'codex' ? { name } : undefined),
      async startActivation() {
        return {
          childId: 'child-cont',
          name: 'agent-cont',
          result: new Promise((resolve) => {
            resolveResult = resolve
          }),
          async dispose() {},
        }
      },
    },
    logger: { info() {}, warn() {} },
    effect: null,
  }
  const adapter = createDshAdapter(ctx, { channels: [], onRunStart: (record) => started.push(record) })
  await adapter.start({
    role: {
      roleId: 'role-wukong',
      name: '悟空',
      channel: { kind: 'codex' },
      enabled: true,
      timeoutMs: 0,
    },
    task: '接着改',
    timeoutMs: 0,
    continuation: { text: '旧结果', bytes: 321, from: 'prev', status: 'completed', truncated: false },
    context: {
      projectRoot: 'D:/MeetingStone',
      agent: { id: 'sess-parent', session: { id: 'sess-parent', header: { cwd: 'D:/MeetingStone' } } },
    },
  })
  assert.equal(started.length, 1)
  assert.equal(started[0].continuationBytes, 321)
  resolveResult?.({ stopReason: 'completed', output: [] })
})

test('continuationBytes 落盘：有就写，没有就省略该字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-token-runs-'))
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'with-cont',
      status: 'completed',
      result: 'x',
      continuationBytes: 1234,
    })
    const withCont = await store.loadRun('with-cont')
    assert.equal(withCont.continuationBytes, 1234)

    await store.writeRun({ childId: 'without-cont', status: 'completed', result: 'y' })
    const withoutCont = await store.loadRun('without-cont')
    assert.equal(Object.hasOwn(withoutCont, 'continuationBytes'), false, '无重放时不得写 0/undefined')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
