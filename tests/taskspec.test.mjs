// @ts-check
/**
 * P0-B：TaskSpec / ContextPack 校验与提示词组装。
 *
 * 覆盖验收要求：
 * - 旧调用（只传 role+task）不受影响
 * - 简单查询不因缺 scope/evidence 被拒
 * - 缺关键字段（title / scope 无 acceptance）才拒绝，错误码与消息明确
 * - ContextPack 按固定顺序进入提示词（人设 → 简报 → 重放 → 任务 → 输出契约）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { TASKSPEC_ERROR, renderTaskBrief, validateTaskSpec } from '../src/taskspec.js'
import { composePromptWithContinuation } from '../src/context-replay.js'
import { renderOutputContract } from '../src/result-contract.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'
import { createDshAdapter } from '../src/dsh/adapter.js'

const role = {
  roleId: 'role-sashi',
  name: '沙僧',
  description: '',
  channel: { kind: 'acp-cli' },
  enabled: true,
  timeoutMs: 1000,
}

/** @param {Record<string, unknown>} depsOver */
function makeDispatchTool(depsOver = {}) {
  const registered = new Map()
  const calls = []
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: { list: () => [], resolve: () => role, errors: [] },
      dispatcher: {
        async dispatch(input) {
          calls.push(input)
          return { ok: true, taskRef: { childId: 'new-1' }, role: input.role }
        },
        getTask: async () => ({ status: 'unknown' }),
        cancel: async () => ({ stopConfirmed: false }),
      },
      probe: { probe: async () => ({}), probeAll: async () => [] },
      ...depsOver,
    },
  )
  return { tool: registered.get(TOOL_NAMES.DISPATCH), calls }
}

const exec = { agent: { session: { header: { cwd: 'D:/proj' } } } }

test('TaskSpec：纯 role+task 走旧路径，不产生任何结构化字段', () => {
  const result = validateTaskSpec({ role: 'SS', task: '查一下测试入口' })
  assert.equal(result.ok, true)
  assert.equal(result.structured, false)
  assert.equal(result.spec, null)
  assert.equal(result.contextPack, null)
})

test('TaskSpec：简单查询只带 title 也放行（不强制 scope/evidence/acceptance）', () => {
  const result = validateTaskSpec({ task: '看下这个报错', title: '排查报错' })
  assert.equal(result.ok, true)
  assert.equal(result.structured, true)
  assert.equal(result.spec.title, '排查报错')
  assert.deepEqual(result.spec.scope, { include: [], exclude: [] })
  assert.deepEqual(result.spec.acceptance, [])
})

test('TaskSpec：结构化模式缺 title 被拒，消息说明缺什么', () => {
  const result = validateTaskSpec({ task: 'x', objective: '做点什么' })
  assert.equal(result.ok, false)
  assert.equal(result.code, TASKSPEC_ERROR)
  assert.ok(result.fields.includes('title'))
  assert.match(result.message, /title/)
  assert.match(result.message, /短任务名/)
})

test('TaskSpec：声明 scope 却没有 acceptance 被拒（无法验收）', () => {
  const result = validateTaskSpec({
    task: '审查登录模块',
    title: '审核登录权限',
    scope: { include: ['src/auth/'] },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TASKSPEC_ERROR)
  assert.ok(result.fields.includes('acceptance'))
  assert.match(result.message, /验收标准/)
})

test('TaskSpec：scope 非空但 acceptance 是空数组同样被拒', () => {
  const result = validateTaskSpec({
    task: 'x',
    title: 't',
    scope: { exclude: ['不修改代码'] },
    acceptance: [],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TASKSPEC_ERROR)
})

test('TaskSpec：关键字段类型错误被拒（数组/对象不能混用）', () => {
  const result = validateTaskSpec({
    task: 'x',
    title: 't',
    acceptance: '不是数组',
    contextPack: ['也不是对象'],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TASKSPEC_ERROR)
  assert.match(result.message, /acceptance/)
  assert.match(result.message, /contextPack/)
})

test('TaskSpec：完整结构化字段被规范化', () => {
  const result = validateTaskSpec({
    task: '审查登录模块',
    title: '  审核登录权限  ',
    objective: '检查越权访问',
    scope: { include: ['src/auth/'], exclude: ['不修改代码'] },
    acceptance: ['列出问题及证据位置'],
    evidence: ['文件路径和行号'],
    contextRefs: ['.meetingstone/context/auth.md'],
    roleHint: 'role-wukong',
    outputBudget: { summaryTokens: 400, notes: '只回摘要' },
    contextPack: {
      knownFacts: ['登录入口在 src/auth/index.ts'],
      files: ['src/auth/callback.ts'],
      priorResults: [{ summary: '正常路径已通过', artifactRef: '.meetingstone/runs/p1.json' }],
      doNotRepeat: ['不要重扫整个仓库'],
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.spec.title, '审核登录权限')
  assert.deepEqual(result.spec.scope.include, ['src/auth/'])
  assert.equal(result.spec.outputBudget.summaryTokens, 400)
  assert.deepEqual(result.contextPack.knownFacts, ['登录入口在 src/auth/index.ts'])
  assert.equal(result.contextPack.priorResults[0].artifactRef, '.meetingstone/runs/p1.json')
})

test('提示词组装顺序：人设 → TaskSpec → ContextPack → 重放 → 任务 → 输出契约', () => {
  const validated = validateTaskSpec({
    task: '审查登录模块',
    title: '审核登录权限',
    objective: '检查越权访问',
    scope: { include: ['src/auth/'] },
    acceptance: ['列出问题及证据位置'],
    contextPack: {
      knownFacts: ['登录入口在 src/auth/index.ts'],
      files: ['src/auth/callback.ts'],
      priorResults: [{ summary: '正常路径已通过', artifactRef: '.meetingstone/runs/p1.json' }],
      doNotRepeat: ['不要重扫整个仓库'],
    },
  })
  assert.equal(validated.ok, true)
  const text = composePromptWithContinuation({
    personaHead: '你是「沙僧」。',
    persona: '负责主力开发。',
    taskBrief: renderTaskBrief(validated.spec, validated.contextPack),
    continuation: { text: '[PREVIOUS TASK OUTPUT — UNTRUSTED CONTEXT]\n旧结果\n[END PREVIOUS TASK OUTPUT]' },
    task: '审查登录模块',
    outputContract: renderOutputContract(),
  })
  const order = [
    '你是「沙僧」。',
    '[TASK SPEC — 结构化任务简报]',
    'title: 审核登录权限',
    'scope.include:',
    'acceptance:',
    '[CONTEXT PACK — 已确认的最小上下文]',
    'knownFacts:',
    'priorResults:',
    'doNotRepeat:',
    '[END TASK SPEC]',
    '[PREVIOUS TASK OUTPUT — UNTRUSTED CONTEXT]',
    '任务：审查登录模块',
    '[OUTPUT CONTRACT — 必须遵守]',
  ]
  let cursor = -1
  for (const marker of order) {
    const at = text.indexOf(marker)
    assert.ok(at > cursor, `${marker} 的位置不对（必须是固定顺序）`)
    cursor = at
  }
  assert.match(text, /不要重复探索/)
  assert.match(text, /不要复述长文/)
})

test('dispatch 工具：旧调用不传结构化字段（taskSpec/contextPack 均为 undefined）', async () => {
  const { tool, calls } = makeDispatchTool()
  const out = await tool.execute({ role: 'SS', task: '查一下' }, exec)
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].taskSpec, undefined)
  assert.equal(calls[0].contextPack, undefined)
})

test('dispatch 工具：结构化字段透传给 dispatcher', async () => {
  const { tool, calls } = makeDispatchTool()
  const out = await tool.execute(
    {
      role: 'SS',
      task: '审查登录模块',
      title: '审核登录权限',
      objective: '检查越权访问',
      scope: { include: ['src/auth/'] },
      acceptance: ['列出问题及证据位置'],
      contextPack: {
        knownFacts: ['登录入口在 src/auth/index.ts'],
        files: ['src/auth/callback.ts'],
        doNotRepeat: ['不要重扫整个仓库'],
      },
    },
    exec,
  )
  assert.equal(out.ok, true)
  assert.equal(calls[0].taskSpec.title, '审核登录权限')
  assert.deepEqual(calls[0].taskSpec.scope.include, ['src/auth/'])
  assert.deepEqual(calls[0].contextPack.files, ['src/auth/callback.ts'])
})

test('dispatch 工具：结构化校验失败时不触达 dispatcher', async () => {
  const { tool, calls } = makeDispatchTool()
  const out = await tool.execute(
    { role: 'SS', task: 'x', title: 't', scope: { include: ['src/'] } },
    exec,
  )
  assert.equal(out.ok, false)
  assert.equal(out.code, TASKSPEC_ERROR)
  assert.equal(calls.length, 0, '校验失败不得派单')
})

// ─── 适配器：简报进入真实提示词 ──────────────────────────────────────────────

test('适配器：TaskSpec + ContextPack 进入提示词，且在人设之后、任务之前', async () => {
  const calls = []
  const ctx = {
    subagents: {
      getProvider: (name) => (name === 'acp' ? { name } : undefined),
      async startActivation(spec) {
        calls.push(spec)
        return {
          childId: 'child-ts',
          name: 'child-ts',
          result: new Promise(() => {}),
          async dispose() {},
        }
      },
    },
    logger: { warn() {} },
    effect: null,
  }
  const adapter = createDshAdapter(ctx, { channels: [] })
  await adapter.start({
    role: { ...role, prompt: '你是技术骨干。' },
    task: '审查登录模块',
    taskSpec: {
      title: '审核登录权限',
      objective: '检查越权访问',
      scope: { include: ['src/auth/'], exclude: [] },
      acceptance: ['列出问题及证据位置'],
      evidence: [],
      contextRefs: [],
      roleHint: null,
      outputBudget: null,
    },
    contextPack: { knownFacts: ['入口已确认'], files: ['src/auth/callback.ts'], priorResults: [], doNotRepeat: [] },
    timeoutMs: 0,
    context: {
      projectRoot: 'D:/MeetingStone',
      agent: { session: { header: { cwd: 'D:/MeetingStone' } } },
    },
  })
  const text = calls[0].request.prompt[0].text
  const iPersona = text.indexOf('你是技术骨干')
  const iSpec = text.indexOf('[TASK SPEC — 结构化任务简报]')
  const iPack = text.indexOf('[CONTEXT PACK — 已确认的最小上下文]')
  const iTask = text.indexOf('任务：审查登录模块')
  const iContract = text.indexOf('[OUTPUT CONTRACT — 必须遵守]')
  assert.ok(iPersona >= 0 && iSpec > iPersona && iPack > iSpec && iTask > iPack && iContract > iTask)
})
