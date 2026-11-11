// @ts-check
/**
 * P0-C：结构化结果解析、artifact 读取与 Handoff。
 *
 * 覆盖验收要求：
 * - 结果解析：整段 JSON / 代码块 JSON / 纯文本 / 坏 JSON
 * - summary 等字段写入 run 记录，完整 output 仍落盘
 * - get_task 默认优先结构化 summary，full:true 回全文
 * - meetingstone_get_run_artifact 按全文 / 字节窗口 / 行范围读取，错误码明确
 * - Handoff 字段（结论/证据/产物/未决/下一步）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildHandoff,
  parseStructuredResult,
  resultRecordFields,
  SUMMARY_MAX_BYTES,
} from '../src/result-contract.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'
import { createDshAdapter } from '../src/dsh/adapter.js'
import { createRunStore } from '../src/run-store.js'

const STRUCTURED = {
  status: 'completed',
  summary: '发现 2 个权限检查缺口，均位于授权回调路径；未修改代码。',
  evidence: [{ file: 'src/auth/callback.ts', line: 84, finding: '缺少租户归属校验' }],
  artifacts: ['.meetingstone/runs/task-123/review.md'],
  changedFiles: [],
  tests: ['静态检查完成；未运行集成测试'],
  openIssues: ['需要确认旧租户兼容逻辑'],
  nextAction: '交由沙僧修复后再由悟空复核',
}

/** @param {Record<string, unknown>} depsOver */
function makeTools(depsOver = {}) {
  const registered = new Map()
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: { list: () => [], errors: [] },
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

test('解析：整段 JSON 结果 → 结构化字段 + evidence 规范化', () => {
  const parsed = parseStructuredResult(JSON.stringify(STRUCTURED))
  assert.equal(parsed.structured, true)
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.summary, STRUCTURED.summary)
  assert.deepEqual(parsed.evidence, [{ file: 'src/auth/callback.ts', line: 84, finding: '缺少租户归属校验' }])
  assert.deepEqual(parsed.artifacts, STRUCTURED.artifacts)
  assert.deepEqual(parsed.changedFiles, [])
  assert.deepEqual(parsed.tests, STRUCTURED.tests)
  assert.deepEqual(parsed.openIssues, STRUCTURED.openIssues)
  assert.equal(parsed.nextAction, STRUCTURED.nextAction)
})

test('解析：```json 代码块 + 前后说明文字也能提取', () => {
  const text = `结论如下：\n\n\`\`\`json\n${JSON.stringify(STRUCTURED, null, 2)}\n\`\`\`\n\n以上。`
  const parsed = parseStructuredResult(text)
  assert.equal(parsed.structured, true)
  assert.equal(parsed.status, 'completed')
  assert.match(parsed.summary, /权限检查缺口/)
})

test('解析：纯文本 → structured=false，summary=原文（不丢内容）', () => {
  const text = '改完了。测试全绿，没有遗留问题。'
  const parsed = parseStructuredResult(text)
  assert.equal(parsed.structured, false)
  assert.equal(parsed.summary, text)
  assert.equal(parsed.status, null)
  assert.deepEqual(parsed.evidence, [])
})

test('解析：坏 JSON → 按纯文本处理，标记 sawCandidate', () => {
  const text = '{"status": "completed", "summary": "x"'
  const parsed = parseStructuredResult(text)
  assert.equal(parsed.structured, false)
  assert.equal(parsed.summary, text)
  assert.equal(parsed.sawCandidate, true)
})

test('解析：与结果无关的 JSON 对象不会被误当结构化结果', () => {
  const text = '配置示例：{ "port": 8080 }，任务已完成。'
  const parsed = parseStructuredResult(text)
  assert.equal(parsed.structured, false)
  assert.equal(parsed.summary, text)
})

test('解析：evidence 字符串折成 { finding }；未知 status 不冒充合法状态', () => {
  const parsed = parseStructuredResult(
    JSON.stringify({ status: 'done', summary: 'x', evidence: ['见 tests/a.test.mjs:12'] }),
  )
  assert.equal(parsed.structured, true)
  assert.equal(parsed.status, null, '未知 status 必须为 null，不能猜成 completed')
  assert.deepEqual(parsed.evidence, [{ finding: '见 tests/a.test.mjs:12' }])
})

test('resultRecordFields：summary 截断、changedFiles 落到 reportedChangedFiles、生成 handoff', () => {
  const bigSummary = `权限检查缺口。${'头'.repeat(6000)}${'尾'.repeat(6000)}`
  const big = parseStructuredResult(JSON.stringify({ ...STRUCTURED, summary: bigSummary }))
  const fields = resultRecordFields(big)
  assert.equal(fields.structuredResult, true)
  assert.equal(fields.resultStatus, 'completed')
  assert.equal(fields.summaryTruncated, true)
  assert.ok(Buffer.byteLength(String(fields.summary), 'utf8') <= SUMMARY_MAX_BYTES + 128)
  assert.equal(fields.summaryBytes, Buffer.byteLength(bigSummary, 'utf8'))
  assert.equal(
    Object.hasOwn(fields, 'reportedChangedFiles'),
    false,
    '子 Agent 未报告改动文件时不写空数组',
  )
  assert.equal(Object.hasOwn(fields, 'changedFiles'), false, '不得覆盖记录里的 git changedFiles')
  const handoff = /** @type {any} */ (fields.handoff)
  assert.match(handoff.conclusion, /权限检查缺口/)
  assert.deepEqual(handoff.artifacts, STRUCTURED.artifacts)
  assert.deepEqual(handoff.openIssues, STRUCTURED.openIssues)
  assert.equal(handoff.nextAction, STRUCTURED.nextAction)
})

test('resultRecordFields：空结果不产生任何字段', () => {
  assert.deepEqual(resultRecordFields(parseStructuredResult('')), {})
})

test('buildHandoff：没有可用内容时返回 null', () => {
  assert.equal(buildHandoff({ summary: '', evidence: [], artifacts: [], openIssues: [] }), null)
})

test('适配器：子 Agent 返回 JSON → 终态记录带 summary/evidence/handoff', async () => {
  const finished = []
  const ctx = {
    subagents: {
      getProvider: (name) => (name === 'acp' ? { name } : undefined),
      async startActivation() {
        return {
          childId: 'child-json',
          name: 'child-json',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: JSON.stringify(STRUCTURED) }],
          }),
          async dispose() {},
        }
      },
    },
    logger: { warn() {} },
    effect: null,
  }
  const adapter = createDshAdapter(ctx, { channels: [], onRunFinish: (record) => finished.push(record) })
  await adapter.start({
    role: { roleId: 'role-sashi', name: '沙僧', channel: { kind: 'acp-cli' }, enabled: true },
    task: '审查登录模块',
    timeoutMs: 0,
    context: {
      projectRoot: 'D:/MeetingStone',
      agent: { session: { header: { cwd: 'D:/MeetingStone' } } },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(finished.length, 1)
  const record = finished[0]
  assert.equal(record.resultStatus, 'completed')
  assert.match(record.summary, /权限检查缺口/)
  assert.deepEqual(record.evidence, STRUCTURED.evidence)
  assert.deepEqual(record.openIssues, STRUCTURED.openIssues)
  assert.equal(record.handoff.nextAction, STRUCTURED.nextAction)
  assert.match(record.result, /review\.md/, '完整 output 仍然落盘（result 不被摘要替代）')
})

test('落盘：taskSpec/contextPack/summary/handoff 保留；list_runs 展示标题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-result-runs-'))
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'child-1',
      status: 'completed',
      result: JSON.stringify(STRUCTURED),
      title: '审核登录权限',
      taskSpec: { title: '审核登录权限', objective: '检查越权访问' },
      contextPack: { knownFacts: ['入口已确认'], files: [], priorResults: [], doNotRepeat: [] },
      ...resultRecordFields(parseStructuredResult(JSON.stringify(STRUCTURED))),
    })
    const record = await store.loadRun('child-1')
    assert.equal(record.title, '审核登录权限')
    assert.equal(record.taskSpec.title, '审核登录权限')
    assert.deepEqual(record.contextPack.knownFacts, ['入口已确认'])
    assert.equal(record.resultStatus, 'completed')
    assert.match(record.summary, /权限检查缺口/)
    assert.deepEqual(record.handoff.artifacts, STRUCTURED.artifacts)

    const list = await store.listRuns()
    assert.equal(list[0].title, '审核登录权限')
    assert.equal(list[0].resultStatus, 'completed')
    assert.match(list[0].summaryPreview, /权限检查缺口/)
    assert.equal(Object.hasOwn(list[0], 'handoff'), false, '列表不返回 handoff 全文')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('get_task：有结构化 summary 时默认不回原始正文；full:true 回全文', async () => {
  const fullText = JSON.stringify(STRUCTURED)
  const record = {
    childId: 'c1',
    status: 'completed',
    output: fullText,
    result: fullText,
    ...resultRecordFields(parseStructuredResult(fullText)),
  }
  const tools = makeTools({
    dispatcher: {
      dispatch: async () => ({}),
      getTask: async () => record,
      cancel: async () => ({ stopConfirmed: false }),
    },
  })
  const brief = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c1' })
  assert.equal(brief.summary, record.summary)
  assert.equal(brief.resultStatus, 'completed')
  assert.deepEqual(brief.openIssues, STRUCTURED.openIssues)
  assert.equal(Object.hasOwn(brief, 'result'), false, '默认不得回原始正文')
  assert.equal(brief.resultOmitted, true)
  assert.equal(brief.resultTruncated, true)
  assert.equal(brief.resultBytes, Buffer.byteLength(fullText, 'utf8'))

  const full = await tools.get(TOOL_NAMES.GET_TASK).execute({ childId: 'c1', full: true })
  assert.equal(full.result, fullText)
  assert.equal(full.resultTruncated, false)
  assert.equal(full.summary, record.summary)
})

test('artifact：默认全文、字节窗口、行范围', async () => {
  const long = '中'.repeat(200)
  const result = `HEAD-${long}\n第二行\n第三行\n${long}\nTAIL`
  const tools = makeTools({
    loadPersistedRun: async (_exec, childId) =>
      childId === 'c1' ? { childId, status: 'completed', result } : null,
  })
  const tool = tools.get(TOOL_NAMES.GET_RUN_ARTIFACT)

  const full = await tool.execute({ childId: 'c1' })
  assert.equal(full.ok, true)
  assert.equal(full.content, result)
  assert.equal(full.truncated, false)
  assert.deepEqual(full.range, { mode: 'full' })

  const lines = await tool.execute({ childId: 'c1', lineFrom: 2, lineTo: 3 })
  assert.equal(lines.content, '第二行\n第三行')
  assert.equal(lines.truncated, true)
  assert.equal(lines.range.lineTotal, 5)

  const windowed = await tool.execute({ childId: 'c1', headBytes: 40, tailBytes: 20 })
  assert.equal(windowed.ok, true)
  assert.ok(windowed.bytes <= 60, '返回字节不得超过 head+tail 窗口（含截断标记）')
  assert.equal(windowed.truncated, true)
  assert.ok(windowed.content.includes('TAIL'), '必须保留尾部')
})

test('artifact：NOT_FOUND / CORRUPT / INVALID_RANGE 错误码明确', async () => {
  const tools = makeTools({
    loadPersistedRun: async (_exec, childId) => {
      if (childId === 'missing') return { status: 'unknown', code: 'RUN_NOT_FOUND', reason: 'no' }
      if (childId === 'broken') return { status: 'unknown', code: 'RUN_CORRUPT', reason: 'bad' }
      return { childId, status: 'completed', result: 'x' }
    },
  })
  const tool = tools.get(TOOL_NAMES.GET_RUN_ARTIFACT)

  const missing = await tool.execute({ childId: 'missing' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')

  const broken = await tool.execute({ childId: 'broken' })
  assert.equal(broken.ok, false)
  assert.equal(broken.code, 'CORRUPT')

  const conflict = await tool.execute({ childId: 'c1', lineFrom: 1, headBytes: 10 })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'INVALID_RANGE')

  const badRange = await tool.execute({ childId: 'c1', lineFrom: 3, lineTo: 1 })
  assert.equal(badRange.ok, false)
  assert.equal(badRange.code, 'INVALID_RANGE')
})
