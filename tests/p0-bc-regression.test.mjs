// @ts-check
/**
 * P0-B/C 打回（F1–F8）的真实链路回归。
 *
 * 与既有单测的区别：这里**不再手工拼记录**，而是
 *   apply() → 注册的 dispatch 工具 → 真实 dispatcher → adapter.start
 *   → 宿主 activation 完成回调 → run-store 落盘
 * 全程使用真实实现，只在宿主边界替换 startActivation（与独立复核相同边界）。
 *
 * 关键断言（用于杀死变异）：
 * - 删掉 buildRunBase 里的 taskSpec/contextPack 落盘 → 磁盘字段断言失败（F7）
 * - 内存终态不带 runBase → 同进程重放与磁盘重放文本不一致（F1）
 * - summarize/validation 静默裁剪 → 第 11 条 / 第 250/650 字符断言失败（F2/F3）
 * - 只认行首保护段 / 只看前三个对象 / 小窗口超预算 → F4/F5/F6/F8 断言失败
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { createRunStore, truncateUtf8 } from '../src/run-store.js'
import { summarizeContextPack, summarizeTaskSpec, validateTaskSpec, TASKSPEC_ERROR } from '../src/taskspec.js'
import { formatContinuation } from '../src/context-replay.js'
import { parseStructuredResult } from '../src/result-contract.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'
import { waitFor } from './helpers.mjs'

const CONFIG = {
  roles: [
    {
      roleId: 'role-sashi',
      name: '沙僧',
      aliases: ['SS'],
      description: '',
      prompt: '你是技术骨干。',
      channel: { kind: 'acp-cli', cli: 'codebuddy' },
      enabled: true,
      // 0 = 不装超时定时器，避免测试进程挂住
      timeoutMs: 0,
    },
  ],
  limits: { defaultIsolation: 'none' },
}

/**
 * 用真实插件入口装配一个新实例。
 * @param {string} root
 * @param {string} instanceId
 */
function boot(root, instanceId) {
  const tools = new Map()
  /** @type {Map<string, string>} */
  const prompts = new Map()
  /** @type {Map<string, (value: any) => void>} */
  const pending = new Map()
  let serial = 0
  const warns = []
  const disposers = []

  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    logger: {
      info() {},
      warn(line) {
        warns.push(String(line))
      },
    },
    subagents: {
      getProvider(name) {
        return name === 'acp' ? { name } : undefined
      },
      async startActivation(spec) {
        const childId = `p0bc-${instanceId}-${++serial}`
        prompts.set(childId, spec.request.prompt[0].text)
        const result = new Promise((resolve) => pending.set(childId, resolve))
        return { childId, name: childId, result, async dispose() {} }
      },
    },
  }
  apply(ctx, CONFIG)
  const exec = { agent: { session: { header: { cwd: root } } } }
  const store = createRunStore({ root })

  /**
   * 派单并在真实完成回调里结算；等磁盘写出终态后返回。
   * @param {Record<string, unknown>} args
   * @param {string} [text]
   */
  async function dispatch(args, text = 'PONG') {
    const reply = await tools.get(TOOL_NAMES.DISPATCH).execute(
      { role: 'SS', task: 'TASK_SENTINEL', isolation: 'none', ...args },
      exec,
    )
    assert.equal(reply.ok, true, JSON.stringify(reply))
    const childId = reply.taskRef.childId
    const prompt = prompts.get(childId)
    pending.get(childId)?.({ stopReason: 'completed', output: [{ type: 'text', text }] })
    const record = await waitFor(async () => {
      const next = await store.loadRun(childId)
      return next?.status === 'completed' ? next : null
    })
    return { id: childId, prompt, record }
  }

  /** @param {string} name @param {Record<string, unknown>} args */
  async function call(name, args) {
    return tools.get(`meetingstone_${name}`).execute(args, exec)
  }

  return { tools, prompts, dispatch, call, store, warns, exec }
}

/** @param {string} label */
function longRule(label, chars) {
  // 标记放在字符中间：只要发生截断/中间丢失，断言就会失败。
  const head = 'x'.repeat(Math.floor(chars / 2))
  const tail = 'x'.repeat(chars - head.length - label.length)
  return `${head}${label}${tail}`
}

test('F1/F7 真实链路：磁盘落盘字段真实存在，内存终态重放与磁盘重放逐字一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-p0bc-chain-'))
  try {
    const live = boot(root, 'live')
    const structured = {
      title: 'TITLE_SENTINEL',
      objective: 'OBJECTIVE_SENTINEL',
      scope: { include: ['INCLUDE_SENTINEL'], exclude: ['EXCLUDE_SENTINEL'] },
      acceptance: ['ACCEPT_ONE_SENTINEL', 'ACCEPT_TWO_SENTINEL'],
      contextPack: {
        knownFacts: ['FACT_SENTINEL'],
        files: ['FILE_SENTINEL'],
        priorResults: [],
        doNotRepeat: ['DNR_ONE_SENTINEL', 'DNR_TWO_SENTINEL'],
      },
    }
    const first = await live.dispatch(structured, '首轮结果')

    // F7：真实链路（apply→dispatch→adapter→run-store）落盘字段必须真实存在，
    // 不是测试手工塞进 store 的 fixture。删掉 buildRunBase 的 taskSpec/contextPack 会失败。
    assert.equal(first.record.status, 'completed')
    assert.equal(first.record.title, 'TITLE_SENTINEL')
    assert.deepEqual(first.record.taskSpec.acceptance, structured.acceptance)
    assert.deepEqual(first.record.taskSpec.scope.exclude, structured.scope.exclude)
    assert.deepEqual(first.record.taskSpec.scope.include, structured.scope.include)
    assert.deepEqual(first.record.contextPack.doNotRepeat, structured.contextPack.doNotRepeat)
    assert.deepEqual(first.record.contextPack.knownFacts, structured.contextPack.knownFacts)
    // 初次 prompt 同样保留（简报路径）
    for (const marker of [
      'OBJECTIVE_SENTINEL',
      'EXCLUDE_SENTINEL',
      'ACCEPT_TWO_SENTINEL',
      'DNR_TWO_SENTINEL',
    ]) {
      assert.ok(first.prompt.includes(marker), `初次 prompt 必须包含 ${marker}`)
    }

    // 同进程 continuesFrom：走 dispatcher.getTask 的内存终态（这是 F1 的路径）。
    const sameProcess = await live.dispatch({ continuesFrom: first.id }, '继续')
    for (const marker of ['ACCEPT_ONE_SENTINEL', 'EXCLUDE_SENTINEL', 'DNR_ONE_SENTINEL']) {
      assert.ok(sameProcess.prompt.includes(marker), `内存命中重放必须保留 ${marker}`)
    }

    // 新插件实例（模拟 DSH 重启）：只能读磁盘，走 loadPersistedRun。
    const restarted = boot(root, 'restart')
    const fromDisk = await restarted.dispatch({ continuesFrom: first.id }, '继续')

    // F1 核心断言：内存重放与磁盘重放必须逐字一致（真实 record 字段，不是手工 fixture）。
    assert.equal(
      sameProcess.prompt,
      fromDisk.prompt,
      '内存命中与磁盘重放必须产生相同的提示词（含完整保护字段）',
    )
    for (const marker of ['ACCEPT_ONE_SENTINEL', 'EXCLUDE_SENTINEL', 'DNR_ONE_SENTINEL']) {
      assert.ok(fromDisk.prompt.includes(marker), `磁盘重放必须保留 ${marker}`)
    }

    // 直接对两份记录调用 formatContinuation，证明差异不在提示词拼装层。
    const memoryRecord = await live.tools
      .get(TOOL_NAMES.GET_TASK)
      .execute({ childId: first.id }, live.exec)
    assert.ok(JSON.stringify(memoryRecord).includes('DNR_ONE_SENTINEL'))
    const diskRecord = await restarted.store.loadRun(first.id)
    assert.equal(
      formatContinuation(memoryRecord).text.includes('DNR_ONE_SENTINEL'),
      formatContinuation(diskRecord).text.includes('DNR_ONE_SENTINEL'),
      '内存视图与磁盘记录的保护字段可见性必须一致',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('F2 落盘摘要：acceptance/scope/doNotRepeat/permissions/safetyPolicy 不参与条数/长度裁剪', async () => {
  const rule250 = longRule('CRITICAL_MIDDLE_250', 250)
  const rule480 = longRule('CRITICAL_MIDDLE_480', 480)
  const dnr280 = longRule('CRITICAL_DNR_280', 280)
  const acceptance = [rule480, ...Array.from({ length: 9 }, (_, i) => `rule-${i}`), 'CRITICAL_ITEM_11']
  const doNotRepeat = [dnr280, ...Array.from({ length: 9 }, (_, i) => `avoid-${i}`), 'CRITICAL_DNR_11']
  const spec = {
    title: 'long-protected',
    objective: 'objective',
    scope: { include: ['src'], exclude: [rule250] },
    acceptance,
    evidence: ['e'.repeat(300), ...Array.from({ length: 11 }, (_, i) => `evidence-${i}`)],
    contextRefs: ['ref'],
    roleHint: 'role-sashi',
    outputBudget: { summaryTokens: 400, notes: 'notes' },
    permissions: 'read-only：不得写盘',
    safetyPolicy: '不得修改宿主 profile',
  }
  const pack = {
    knownFacts: ['fact'],
    files: ['a.js'],
    priorResults: [{ summary: 'prior', artifactRef: 'a.md' }],
    doNotRepeat,
    permissions: 'pack-read-only',
    safetyPolicy: 'pack-safety',
  }

  const sum = summarizeTaskSpec(spec)
  assert.deepEqual(sum.acceptance, acceptance, 'acceptance 第 11 条与第 250 字符都必须完整')
  assert.deepEqual(sum.scope.exclude, [rule250])
  assert.equal(sum.permissions, spec.permissions)
  assert.equal(sum.safetyPolicy, spec.safetyPolicy)
  assert.equal(sum.evidence.length, 10, '自由文本仍可裁剪条数')
  const packSum = summarizeContextPack(pack)
  assert.deepEqual(packSum.doNotRepeat, doNotRepeat)
  assert.equal(packSum.permissions, 'pack-read-only')
  assert.equal(packSum.safetyPolicy, 'pack-safety')

  const root = await mkdtemp(join(tmpdir(), 'mt-p0bc-summary-'))
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'summary-long',
      status: 'completed',
      result: 'x',
      taskSpec: spec,
      contextPack: pack,
    })
    const record = await store.loadRun('summary-long')
    assert.deepEqual(record.taskSpec.acceptance, acceptance, '落盘后 protection 字段不得丢')
    assert.deepEqual(record.taskSpec.scope.exclude, [rule250])
    assert.equal(record.taskSpec.permissions, spec.permissions)
    assert.equal(record.taskSpec.safetyPolicy, spec.safetyPolicy)
    assert.deepEqual(record.contextPack.doNotRepeat, doNotRepeat)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('F2 真实链路：第 11 条与第 250 字符约束在 prompt、磁盘与重启重放中都存在', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-p0bc-long-'))
  try {
    const live = boot(root, 'long')
    const rule250 = longRule('CRITICAL_MIDDLE_250', 250)
    const acceptance = [...Array.from({ length: 10 }, (_, i) => `rule-${i}`), 'CRITICAL_ITEM_11']
    const doNotRepeat = [...Array.from({ length: 10 }, (_, i) => `avoid-${i}`), 'CRITICAL_DNR_11']
    const first = await live.dispatch(
      {
        title: 'long-chain',
        scope: { include: ['src'], exclude: [rule250] },
        acceptance,
        contextPack: { knownFacts: [], files: [], priorResults: [], doNotRepeat },
      },
      '短结果',
    )
    for (const marker of ['CRITICAL_MIDDLE_250', 'CRITICAL_ITEM_11', 'CRITICAL_DNR_11']) {
      assert.ok(first.prompt.includes(marker), `初次 prompt 必须包含 ${marker}`)
    }
    const diskJson = JSON.stringify(first.record)
    for (const marker of ['CRITICAL_MIDDLE_250', 'CRITICAL_ITEM_11', 'CRITICAL_DNR_11']) {
      assert.ok(diskJson.includes(marker), `磁盘记录必须包含 ${marker}`)
    }

    const restarted = boot(root, 'long-restart')
    const replay = await restarted.dispatch({ continuesFrom: first.id }, '继续')
    for (const marker of ['CRITICAL_MIDDLE_250', 'CRITICAL_ITEM_11', 'CRITICAL_DNR_11']) {
      assert.ok(replay.prompt.includes(marker), `重启重放必须包含 ${marker}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('F3 校验：500 字符内原样保留；650 字符/超条数显式拒绝，绝不静默 slice', () => {
  const marker = 'CRITICAL_AT_500' // 15 字符
  const at500 = `${'x'.repeat(242)}${marker}${'x'.repeat(500 - 242 - marker.length)}` // 恰好 500
  assert.equal(Array.from(at500).length, 500)
  const at300 = `${'x'.repeat(150)}DNR_AT_300${'x'.repeat(300 - 150 - 10)}` // 恰好 300
  assert.equal(Array.from(at300).length, 300)
  const ok = validateTaskSpec({
    title: 'clip-ok',
    scope: { exclude: [at500] },
    acceptance: [at500],
    contextPack: { doNotRepeat: [at300] },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.spec.acceptance[0], at500, '500 字符必须原样保留')
  assert.equal(ok.spec.scope.exclude[0], at500)
  assert.equal(ok.contextPack.doNotRepeat[0], at300)

  const at650 = `${'x'.repeat(600)}CRITICAL_MIDDLE_650${'x'.repeat(40)}` // 650
  const tooLong = validateTaskSpec({
    title: 'clip-bad',
    scope: { exclude: [at650] },
    acceptance: [at650],
    contextPack: { doNotRepeat: [at650] },
  })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.code, TASKSPEC_ERROR)
  assert.ok(tooLong.fields.includes('acceptance'))
  assert.ok(tooLong.fields.includes('scope.exclude'))
  assert.ok(tooLong.fields.includes('contextPack.doNotRepeat'))
  assert.match(tooLong.message, /不会被静默截断/)

  const tooMany = validateTaskSpec({
    title: 'count-bad',
    acceptance: Array.from({ length: 51 }, (_, i) => `rule-${i}`),
  })
  assert.equal(tooMany.ok, false, '超条数也必须显式拒绝，不能 break 静默丢')
  assert.match(tooMany.message, /不会被静默丢弃/)
})

test('F4/F5 真实纯文本结果：正文中间的验收/权限/行内约束在 get_task 默认与重放中都不丢', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-p0bc-inline-'))
  try {
    const runtime = boot(root, 'inline')
    const header = '验收标准：\n- CRITICAL_ACCEPT_MIDDLE\n权限限制：CRITICAL_PERM_MIDDLE'
    const inline =
      '注意：CRITICAL_INLINE_READ_ONLY，不得写盘；必须验收 CRITICAL_INLINE_ACCEPT。'
    const body = `${'头'.repeat(5000)}\n\n${header}\n\n${inline}\n\n${'尾'.repeat(5000)}`
    const run = await runtime.dispatch({}, body)

    // 摘要本身是首尾截断，中间段必然不在；证明后面的断言走的是保护段路径。
    assert.equal(String(run.record.summary).includes('CRITICAL_ACCEPT_MIDDLE'), false)

    const brief = await runtime.call('get_task', { childId: run.id })
    assert.equal(brief.resultOmitted, true)
    const injected = JSON.stringify(brief)
    for (const marker of [
      'CRITICAL_ACCEPT_MIDDLE',
      'CRITICAL_PERM_MIDDLE',
      'CRITICAL_INLINE_READ_ONLY',
      'CRITICAL_INLINE_ACCEPT',
    ]) {
      assert.ok(injected.includes(marker), `get_task 默认视图必须保留 ${marker}`)
    }
    assert.ok(Array.isArray(brief.protectedSections) && brief.protectedSections.length > 0)

    const replay = formatContinuation(run.record)
    for (const marker of ['CRITICAL_INLINE_READ_ONLY', 'CRITICAL_INLINE_ACCEPT']) {
      assert.ok(replay.text.includes(marker), `重放必须保留行内约束 ${marker}`)
    }

    const full = await runtime.call('get_task', { childId: run.id, full: true })
    assert.equal(full.result, body, 'full:true 仍是原文')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('F6 结果契约：正文示例 completed 不得覆盖末尾 blocked；第四个裸对象也要解析', () => {
  const example = JSON.stringify({ status: 'completed', summary: '示例，不代表结论', openIssues: [] })
  const final = JSON.stringify({
    status: 'blocked',
    summary: '真实结论：阻塞',
    evidence: [{ file: 'src/a.js', line: 3, finding: '缺校验' }],
    openIssues: ['真实阻塞'],
    nextAction: '修复后复核',
  })
  const text = `示例：\n\`\`\`json\n${example}\n\`\`\`\n最终结果：\n\`\`\`json\n${final}\n\`\`\``
  const parsed = parseStructuredResult(text)
  assert.equal(parsed.status, 'blocked', '必须取文档末尾的最终结果')
  assert.equal(parsed.summary, '真实结论：阻塞')
  assert.deepEqual(parsed.openIssues, ['真实阻塞'])
  assert.equal(parsed.nextAction, '修复后复核')
  assert.deepEqual(parsed.evidence, [{ file: 'src/a.js', line: 3, finding: '缺校验' }])

  const prefix = Array.from({ length: 3 }, (_, i) => JSON.stringify({ sample: i })).join('\n')
  const fourth = parseStructuredResult(`${prefix}\n${final}`)
  assert.equal(fourth.structured, true, '第四个裸对象必须被扫描到（不再只扫前三个）')
  assert.equal(fourth.status, 'blocked')
  assert.deepEqual(fourth.openIssues, ['真实阻塞'])
})

test('F8 truncateUtf8 小窗口：输出不超预算、头部完整、无乱码；标记放不下时退化', () => {
  const text = '纯文本原文\n第二行\n第三行'
  const cut = truncateUtf8(text, 14, { headBytes: 8, tailBytes: 6 })
  assert.equal(cut.truncated, true)
  assert.ok(cut.bytes <= 14, `实际 ${cut.bytes} 字节，不得超过 14`)
  assert.ok(cut.text.startsWith('纯文'), '头部必须完整保留')
  assert.equal(cut.text.includes('\ufffd'), false, '不得切出乱码')
  assert.ok(cut.text.includes('…'), '小窗口至少保留可识别截断标记')

  const tiny = truncateUtf8('abcdef', 4, { headBytes: 4 })
  assert.ok(tiny.bytes <= 4)
  assert.equal(tiny.text, 'abcd', '标记放不下时保留头部，且绝不超预算')

  // 常规窗口（剩余预算放得下完整标记）仍保留信息量更大的完整标记
  const normal = truncateUtf8('a'.repeat(100), 80, { headBytes: 40, tailBytes: 40 })
  assert.ok(normal.bytes <= 80)
  assert.match(normal.text, /truncated \d+ bytes/)
})

test('F8 artifact 工具小字节窗口（headBytes=8/tailBytes=6）不超预算且不丢头', async () => {
  const registered = new Map()
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: { list: () => [], errors: [] },
      dispatcher: {
        dispatch: async () => ({}),
        getTask: async () => ({ status: 'unknown' }),
        cancel: async () => ({ stopConfirmed: false }),
      },
      probe: { probe: async () => ({}), probeAll: async () => [] },
      loadPersistedRun: async (_exec, childId) => ({
        childId,
        status: 'completed',
        result: '纯文本原文\n第二行\n第三行',
      }),
    },
  )
  const window = await registered.get(TOOL_NAMES.GET_RUN_ARTIFACT).execute({
    childId: 'artifact-small',
    headBytes: 8,
    tailBytes: 6,
  })
  assert.equal(window.ok, true)
  assert.ok(window.bytes <= 14, `artifact 窗口实际 ${window.bytes} 字节，超过 14`)
  assert.equal(window.truncated, true)
  assert.ok(window.content.startsWith('纯'), '头部不能被截断标记挤掉')
  assert.equal(window.content.includes('\ufffd'), false)
})
