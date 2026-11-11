import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { apply } from '../../../src/index.js'
import { createRunStore } from '../../../src/run-store.js'
import { validateTaskSpec, renderTaskBrief } from '../../../src/taskspec.js'
import { formatContinuation } from '../../../src/context-replay.js'
import { parseStructuredResult } from '../../../src/result-contract.js'

const out = resolve('.meetingstone/runs/p0-bc-review')
const project = join(out, 'fixture')
await mkdir(project, { recursive: true })
const store = createRunStore({ root: project })
const exec = { agent: { id: 'review-parent', session: { id: 'review-parent', header: { cwd: project } } } }
const checks = []
const issues = []
function check(name, detail) { checks.push({ name, detail }); console.log('PASS', name, JSON.stringify(detail ?? '')) }
function issue(name, detail) { issues.push({ name, detail }); console.log('REPRODUCED', name, JSON.stringify(detail)) }
let serial = 0
const batch = Date.now().toString(36)
function boot() {
  const registered = new Map(), pending = new Map(), prompts = new Map(), disposers = []
  apply({
    tools: { register(t) { registered.set(t.name, t); return () => {} } },
    logger: { info() {}, warn() {} },
    effect(fn) { disposers.push(fn()) },
    subagents: {
      getProvider(name) { return name === 'acp' ? { name } : undefined },
      async startActivation(spec) {
        const childId = `review-${batch}-${++serial}`
        prompts.set(childId, spec.request.prompt[0].text)
        let settle
        const result = new Promise(r => { settle = r })
        pending.set(childId, settle)
        return { childId, name: childId, result, async dispose() {} }
      },
    },
  }, {
    roles: [{ roleId: 'role-review-proof', name: '复核角色', aliases: ['RV'], enabled: true,
      channel: { kind: 'acp-cli', cli: 'codebuddy' }, prompt: 'PERSONA_SENTINEL：独立复核。' }],
    limits: { defaultIsolation: 'none' },
  })
  async function call(name, args) { return registered.get(`meetingstone_${name}`).execute(args, exec) }
  async function dispatch(args, text = '本次结果。') {
    const reply = await call('dispatch', { role: 'RV', task: 'TASK_SENTINEL：验证字段。', isolation: 'none', ...args })
    assert.equal(reply.ok, true, JSON.stringify(reply))
    const id = reply.taskRef.childId
    const prompt = prompts.get(id)
    pending.get(id)({ stopReason: 'completed', output: [{ type: 'text', text }] })
    let record
    for (let n = 0; n < 200; n++) {
      try { record = JSON.parse(await readFile(store.pathFor(id), 'utf8')) } catch {}
      if (record?.status === 'completed') break
      await new Promise(r => setTimeout(r, 5))
    }
    assert.equal(record?.status, 'completed', 'terminal disk record required')
    await writeFile(join(out, `${id}-prompt.txt`), prompt)
    return { id, prompt, record }
  }
  return { call, dispatch, disposers }
}
const runtime = boot()
const structured = {
  title: 'TITLE_SENTINEL', objective: 'OBJECTIVE_SENTINEL',
  scope: { include: ['INCLUDE_SENTINEL'], exclude: ['EXCLUDE_SENTINEL'] },
  acceptance: ['ACCEPTANCE_SENTINEL'], evidence: ['EVIDENCE_SENTINEL'], contextRefs: ['REF_SENTINEL'],
  roleHint: 'ROLE_HINT_SENTINEL', outputBudget: { summaryTokens: 321, notes: 'BUDGET_SENTINEL' },
  contextPack: { knownFacts: ['FACT_SENTINEL'], files: ['FILE_SENTINEL'],
    priorResults: [{ summary: 'PRIOR_SENTINEL', artifactRef: 'ARTIFACT_SENTINEL' }], doNotRepeat: ['DONT_REPEAT_SENTINEL'] },
}
await store.writeRun({ childId: 'previous', status: 'completed', result: 'REPLAY_SENTINEL' })
const resultObject = { status: 'partial', summary: 'SUMMARY_SENTINEL',
  evidence: [{ file: 'proof.js', line: 17, finding: 'FINDING_SENTINEL' }], artifacts: ['proof.md'],
  changedFiles: [], tests: ['TEST_SENTINEL'], openIssues: ['ISSUE_SENTINEL'], nextAction: 'NEXT_SENTINEL' }
const initial = await runtime.dispatch({ ...structured, continuesFrom: 'previous' }, JSON.stringify(resultObject))
const markers = ['PERSONA_SENTINEL', '[TASK SPEC', '[PREVIOUS TASK OUTPUT', '任务：TASK_SENTINEL', '[OUTPUT CONTRACT']
const positions = markers.map(m => initial.prompt.indexOf(m))
assert.ok(positions.every((v, i) => v >= 0 && (i === 0 || v > positions[i - 1])))
for (const marker of ['TITLE', 'OBJECTIVE', 'INCLUDE', 'EXCLUDE', 'ACCEPTANCE', 'EVIDENCE', 'REF', 'ROLE_HINT', 'BUDGET', 'FACT', 'FILE', 'PRIOR', 'ARTIFACT', 'DONT_REPEAT', 'REPLAY']) {
  assert.ok(initial.prompt.includes(`${marker}_SENTINEL`), marker)
}
assert.deepEqual(initial.record.evidence, resultObject.evidence)
assert.deepEqual(initial.record.openIssues, resultObject.openIssues)
assert.equal(initial.record.summary, resultObject.summary)
assert.equal(initial.record.resultStatus, 'partial')
assert.equal(initial.record.status, 'completed')
check('apply→registered dispatch→real dispatcher→adapter prompt and disk', { positions, fields: 'all 15 sentinels retained', disk: store.pathFor(initial.id), status: 'completed', resultStatus: 'partial' })

for (const [name, text, structuredExpected] of [
  ['json', JSON.stringify(resultObject), true], ['text', '纯文本原文\n第二行\n第三行', false],
  ['bad-json', '{"status":"completed","summary":"坏 JSON"', false],
]) {
  const r = await runtime.dispatch({}, text)
  assert.equal(r.record.structuredResult, structuredExpected)
  assert.equal(r.record.result, text)
  assert.equal(r.record.summary, structuredExpected ? resultObject.summary : text)
  const brief = await runtime.call('get_task', { childId: r.id })
  assert.equal(brief.resultOmitted, true)
  assert.equal(Object.hasOwn(brief, 'result'), false)
  assert.equal((await runtime.call('get_task', { childId: r.id, full: true })).result, text)
  assert.equal((await runtime.call('get_run_artifact', { childId: r.id })).content, text)
  check(`result roundtrip ${name}`, { disk: store.pathFor(r.id), structured: structuredExpected, summary: r.record.summary, defaultOmitted: brief.resultOmitted, fullExact: true, artifactExact: true })
  if (name === 'text') {
    assert.equal((await runtime.call('get_run_artifact', { childId: r.id, lineFrom: 2, lineTo: 2 })).content, '第二行')
    const window = await runtime.call('get_run_artifact', { childId: r.id, headBytes: 8, tailBytes: 6 })
    assert.ok(!window.content.includes('\ufffd'))
    if (window.bytes > 14) issue('F8 artifact small byte window exceeds budget', { requestedBytes: 14, actual: window })
    assert.equal((await runtime.call('get_run_artifact', { childId: r.id, lineFrom: 1, headBytes: 5 })).code, 'INVALID_RANGE')
    check('artifact disk line/UTF8 byte windows/conflict', window)
  }
}
for (const [name, args, expected] of [
  ['role+task', {}, true], ['title-only query', { title: 'query' }, true],
  ['empty scope query', { title: 'query', scope: {} }, true],
  ['missing title', { objective: 'query' }, false],
  ['scope without acceptance', { title: 'query', scope: { include: ['src'] } }, false],
  ['wrong acceptance type', { title: 'query', acceptance: 'bad' }, false],
]) {
  if (expected) { await runtime.dispatch(args) } else {
    const reply = await runtime.call('dispatch', { role: 'RV', task: 'query', ...args })
    assert.equal(reply.code, 'TASKSPEC_INVALID')
  }
  check(`validation ${name}`, expected ? 'accepted' : 'TASKSPEC_INVALID')
}

// Same-process continuation must preserve short, valid constraints too.
const liveReplay = await runtime.dispatch({ continuesFrom: initial.id })
const restarted = boot()
const diskReplay = await restarted.dispatch({ continuesFrom: initial.id })
const shortMarkers = ['ACCEPTANCE_SENTINEL', 'EXCLUDE_SENTINEL', 'DONT_REPEAT_SENTINEL']
assert.ok(shortMarkers.every(m => !liveReplay.prompt.includes(m)))
assert.ok(shortMarkers.every(m => diskReplay.prompt.includes(m)))
issue('F1 live continuation drops every structured constraint', { source: initial.id, live: liveReplay.id, restarted: diskReplay.id,
  lost: shortMarkers, diskStillHasFields: true })

// Long values inside documented structured fields: validation and disk summarization.
const at250 = 'x'.repeat(250) + 'CRITICAL_MIDDLE_250' + 'x'.repeat(180)
const longArgs = { title: 'long-protected', scope: { include: ['src'], exclude: [at250] },
  acceptance: [at250, ...Array.from({ length: 9 }, (_, i) => `rule-${i}`), 'CRITICAL_ITEM_11'],
  contextPack: { doNotRepeat: [at250, ...Array.from({ length: 9 }, (_, i) => `avoid-${i}`), 'CRITICAL_DNR_11'] } }
const longRun = await runtime.dispatch(longArgs, JSON.stringify({ status: 'completed', summary: 'short output' }))
assert.ok(longRun.prompt.includes('CRITICAL_MIDDLE_250') && longRun.prompt.includes('CRITICAL_ITEM_11'))
const longDiskJson = JSON.stringify(longRun.record)
assert.ok(!longDiskJson.includes('CRITICAL_MIDDLE_250') && !longDiskJson.includes('CRITICAL_ITEM_11') && !longDiskJson.includes('CRITICAL_DNR_11'))
const replayLong = await restarted.dispatch({ continuesFrom: longRun.id })
assert.ok(!replayLong.prompt.includes('CRITICAL_MIDDLE_250') && !replayLong.prompt.includes('CRITICAL_ITEM_11'))
issue('F2 persisted summary clips protected fields irreversibly', { source: longRun.id, replay: replayLong.id, promptRetained: true,
  diskLost: ['acceptance[0] character 250', 'scope.exclude[0] character 250', 'doNotRepeat[0] character 250', 'acceptance[10]', 'doNotRepeat[10]'],
  acceptanceCount: longRun.record.taskSpec.acceptance.length, doNotRepeatCount: longRun.record.contextPack.doNotRepeat.length })
const at650 = 'x'.repeat(650) + 'CRITICAL_MIDDLE_650' + 'x'.repeat(200)
const normalized = validateTaskSpec({ title: 'clip', scope: { exclude: [at650] }, acceptance: [at650], contextPack: { doNotRepeat: [at650] } })
assert.equal(normalized.ok, true)
assert.ok(!renderTaskBrief(normalized.spec, normalized.contextPack).includes('CRITICAL_MIDDLE_650'))
issue('F3 validation silently clips initial constraints', { ok: normalized.ok, acceptanceChars: normalized.spec.acceptance[0].length,
  excludeChars: normalized.spec.scope.exclude[0].length, doNotRepeatChars: normalized.contextPack.doNotRepeat[0].length, markerLost: true })

// Real plain-text completion always gets summary, bypassing existing no-summary preservation tests.
const headers = '验收标准：\n- CRITICAL_ACCEPT_MIDDLE\n权限限制：CRITICAL_PERM_MIDDLE\n安全策略：CRITICAL_SAFETY_MIDDLE'
const body = '头'.repeat(6000) + '\n\n' + headers + '\n\n' + '尾'.repeat(6000)
const middleRun = await runtime.dispatch({}, body)
const middleBrief = await runtime.call('get_task', { childId: middleRun.id })
assert.ok(!JSON.stringify(middleBrief).includes('CRITICAL_ACCEPT_MIDDLE'))
assert.equal((await runtime.call('get_task', { childId: middleRun.id, full: true })).result, body)
assert.ok(formatContinuation(middleRun.record).text.includes('CRITICAL_ACCEPT_MIDDLE'))
issue('F4 get_task summary path loses recognizable middle protection', { source: middleRun.id, summaryTruncated: middleRun.record.summaryTruncated,
  defaultContainsCritical: false, fullContainsCritical: true, replayRecognizesHeaders: true })
const inlineBody = '头'.repeat(6000) + '\n\n注意：CRITICAL_INLINE_READ_ONLY，不得写盘；必须验收 CRITICAL_INLINE_ACCEPT。\n\n' + '尾'.repeat(6000)
const inlineReplay = formatContinuation({ childId: 'inline', status: 'completed', result: inlineBody })
assert.ok(!inlineReplay.text.includes('CRITICAL_INLINE'))
issue('F5 replay header-only detection misses inline constraints', { bodyBytes: Buffer.byteLength(inlineBody), replayBytes: inlineReplay.bytes, markersLost: true })

// Output contract is at the end, but a normal earlier JSON example wins.
const example = JSON.stringify({ status: 'completed', summary: '示例，不代表结论', openIssues: [] })
const final = JSON.stringify({ status: 'blocked', summary: '真实结论：阻塞', openIssues: ['真实阻塞'] })
const exampleRun = await runtime.dispatch({}, `示例：\n\`\`\`json\n${example}\n\`\`\`\n最终结果：\n\`\`\`json\n${final}\n\`\`\``)
assert.equal(exampleRun.record.resultStatus, 'completed')
assert.deepEqual(exampleRun.record.openIssues, [])
issue('F6 parser selects example before final contract', { source: exampleRun.id, expected: 'blocked', actual: exampleRun.record.resultStatus,
  expectedOpenIssues: ['真实阻塞'], actualOpenIssues: exampleRun.record.openIssues })
const prefix = Array.from({ length: 3 }, (_, i) => JSON.stringify({ sample: i })).join('\n')
const fourth = parseStructuredResult(prefix + '\n' + final)
assert.equal(fourth.structured, false)
issue('F6b parser ignores fourth unfenced object', { structured: fourth.structured, actualSummary: fourth.summary })

// Store whitelist also removes protective keys from records that the replay reader accepts.
await store.writeRun({ childId: 'protected-whitelist', status: 'completed', result: 'short',
  acceptance: ['TOP_ACCEPT'], permissions: 'TOP_PERMISSION', safetyPolicy: 'TOP_SAFETY',
  taskSpec: { title: 'manual', permissions: 'SPEC_PERMISSION', safetyPolicy: 'SPEC_SAFETY' },
  contextPack: { permissions: 'PACK_PERMISSION', safetyPolicy: 'PACK_SAFETY' } })
const whitelistRecord = await store.loadRun('protected-whitelist')
assert.ok(!JSON.stringify(whitelistRecord).includes('TOP_PERMISSION') && !JSON.stringify(whitelistRecord).includes('SPEC_SAFETY'))
issue('F7 protection tests use record keys dropped by real storage', { disk: store.pathFor('protected-whitelist'), lostTopLevel: ['acceptance','permissions','safetyPolicy'], lostNested: ['permissions','safetyPolicy'] })

// Copy-only source mutation: drop TaskSpec/ContextPack at persistence boundary.
const mutant = join(out, 'mutant')
await mkdir(join(mutant, 'tests'), { recursive: true })
await cp(resolve('src'), join(mutant, 'src'), { recursive: true })
await cp(resolve('package.json'), join(mutant, 'package.json'))
for (const name of ['taskspec', 'result-contract', 'token-output']) {
  await cp(resolve(`tests/${name}.test.mjs`), join(mutant, `tests/${name}.test.mjs`))
}
const adapterPath = join(mutant, 'src/dsh/adapter.js')
const originalAdapter = await readFile(adapterPath, 'utf8')
const mutatedAdapter = originalAdapter
  .replace('const taskSpec = summarizeTaskSpec(input?.taskSpec)', 'const taskSpec = null // REVIEW MUTANT: lose persisted TaskSpec')
  .replace('const contextPack = summarizeContextPack(input?.contextPack)', 'const contextPack = null // REVIEW MUTANT: lose persisted ContextPack')
assert.notEqual(mutatedAdapter, originalAdapter)
await writeFile(adapterPath, mutatedAdapter)
await writeFile(join(out, 'probe-results.json'), JSON.stringify({ checks, issues }, null, 2))
console.log('PROBE_COMPLETE', JSON.stringify({ checks: checks.length, reproducedIssues: issues.length, mutant }))
