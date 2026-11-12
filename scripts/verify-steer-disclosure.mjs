// @ts-check
/**
 * 「插话」误导性文案修复 —— 实际渲染验证。
 *
 * 方式对齐 scripts/verify-d1-interaction.mjs：**真的把 registerTools 跑起来**，
 * 取注册产物里模型实际看到的 description，并真的调用 list_runs / get_task /
 * steer 的 execute()，打印返回体。不靠人眼读源码，也不改任何生产状态。
 *
 * 这个脚本放在 scripts/ 而不是 tests/，所以不进入 run-tests.mjs 的
 * `tests/**\/*.test.mjs` 枚举，689 条测试的基线不变。
 *
 * 用法：node scripts/verify-steer-disclosure.mjs
 */
import assert from 'node:assert/strict'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'
import { steerPreview } from '../src/dsh/steer.js'

// 改前（git HEAD e3c90c4 的原文，逐字抄录），用于和改后并排对比。
const BEFORE_DESCRIPTION =
  '给**还在跑**的任务追加一条指示（中途插话），或给已结束的任务续聊。' +
  '进程内通道（DSH 原生子 Agent）是真插话/真续聊：消息投进它的收件箱，' +
  '它在下一个 step 边界处理，完整上下文保留。' +
  '外部 CLI（CodeBuddy / Codex / Claude）不支持续接会话，只能「杀掉重来并带上已有产出」，' +
  '回执里的 mode 会明确区分，不要混为一谈。' +
  '只能给自己派出的任务插话。任务已终态时无法插话。'

const checks = []
const record = (name, pass, detail) => checks.push({ name, pass, detail })

/** 造一份注册产物 + 可注入的 stub 依赖。 */
function makeTools(over = {}) {
  /** @type {Map<string, any>} */
  const registered = new Map()
  const ctx = { tools: { register: (def) => registered.set(def.name, def) } }
  const defaults = {
    registry: { list: () => [], resolve: () => ({ roleId: 'role-sashi', name: '沙僧', enabled: true }) },
    probe: { probe: async () => ({ installed: false }), probeAll: async () => [] },
    loadPersistedRun: async () => null,
    listPersistedRuns: async () => ({ runs: [] }),
    dispatcher: {
      dispatch: async () => ({ ok: true, taskRef: { childId: 'new-child' } }),
      cancel: async () => ({ stopConfirmed: true }),
      getTask: async () => ({ status: 'unknown' }),
    },
  }
  const deps = { ...defaults, ...over }
  registerTools(ctx, deps)
  return registered
}

// ── 1) 工具文案（模型实际看到的 description）────────────────────────────
const tools = makeTools()
const steer = tools.get(TOOL_NAMES.STEER_TASK)
const listRuns = tools.get(TOOL_NAMES.LIST_RUNS)
const getTask = tools.get(TOOL_NAMES.GET_TASK)
assert.ok(steer && listRuns && getTask)

console.log('\n=== 1) meetingstone_steer_task 文案：改前 → 改后（实际注册产物）===\n')
console.log('【改前】\n' + BEFORE_DESCRIPTION)
console.log('\n【改后】\n' + steer.description)

record('改后文案开头就是后果披露（不是「中途插话」承诺）', /^⚠️/.test(steer.description))
record('改后文案明确「不是插话」', /不是插话/.test(steer.description))
record('改后文案点名「立即 cancel 仍在跑的原任务」', /立即 cancel 仍在跑的原任务/.test(steer.description))
record('改后文案说明「内部状态会丢失 / 重新读上下文」', /内部状态会丢失/.test(steer.description) && /重新读一遍上下文/.test(steer.description))
record('改后文案保留 spawn 才支持真插话的事实', /spawn/.test(steer.description) && /真插话/.test(steer.description))
record('改后文案引导调用前查 steerMode', /list_runs \/ get_task/.test(steer.description) && /steerMode/.test(steer.description))
record('改前文案确实以「中途插话」开头（证明问题存在）', BEFORE_DESCRIPTION.startsWith('给**还在跑**的任务追加一条指示（中途插话）'))
record('改前文案把区分推迟到「回执里的 mode」（事后披露）', /回执里的 mode 会明确区分/.test(BEFORE_DESCRIPTION))

// registerTools 不注入 defineTool 时用 compileToolSpec 编译成 JSON Schema：
// 参数在 parameters.properties.<name>.description。
const instructionDesc = steer.parameters.properties.instruction.description
const roleDesc = steer.parameters.properties.role.description
console.log('\n【instruction 参数文案：改后】\n' + instructionDesc)
console.log('\n【role 参数文案：改后】\n' + roleDesc)
record('instruction 参数不再说「不是新任务，是给当前任务的补充」', !/不是新任务/.test(instructionDesc))
record('instruction 参数说明外部 CLI 下它是「重开后新任务的指令」', /重开后新任务的指令/.test(instructionDesc))
record('role 参数明说「非插话」', /非插话/.test(roleDesc))

// ── 2) list_runs 事前标注 ──────────────────────────────────────────────
const sampleRuns = [
  {
    childId: 'acp-running',
    role: 'role-sashi',
    provider: 'acp',
    status: 'running',
    summaryPreview: '正在写代码…',
    result: '已完成第 1 步',
    worktree: { path: 'D:/w', branch: 'b' },
    overlapWarnings: [],
    changedFiles: [],
    interrupted: false,
    stopConfirmed: false,
  },
  {
    childId: 'spawn-running',
    role: 'role-bajie',
    provider: 'spawn',
    status: 'running',
    summaryPreview: '调度中…',
    worktree: { path: 'D:/w2', branch: 'b2' },
    overlapWarnings: [],
    changedFiles: [],
    interrupted: false,
    stopConfirmed: false,
  },
]
const listTools = makeTools({ listPersistedRuns: async () => ({ runs: sampleRuns, dir: '/runs' }) })
const compact = await listTools.get(TOOL_NAMES.LIST_RUNS).execute({}, {})
console.log('\n=== 2) list_runs（默认紧凑）实际返回 ===\n')
console.log(JSON.stringify(compact.runs, null, 2))

record('list_runs：acp 任务标 restart-with-output', compact.runs[0].steerMode === 'restart-with-output')
record('list_runs：acp 任务带「不支持真插话」说明', /不支持真插话/.test(compact.runs[0].steerNote ?? ''))
record('list_runs：acp 说明点出「停掉…另开新会话」', /停掉原任务/.test(compact.runs[0].steerNote ?? '') && /另开新会话/.test(compact.runs[0].steerNote ?? ''))
record('list_runs：spawn 任务标 steer', compact.runs[1].steerMode === 'steer')
record('list_runs：spawn 任务不挂冗余 steerNote', compact.runs[1].steerNote === undefined)
record('list_runs：紧凑字段仍被剥掉（worktree 只留 path）', compact.runs[0].worktree.branch === undefined && compact.runs[0].worktree.path === 'D:/w')

const verbose = await listTools.get(TOOL_NAMES.LIST_RUNS).execute({ verbose: true }, {})
record('list_runs：verbose 也带同样的标注', verbose.runs[0].steerMode === 'restart-with-output' && verbose.runs[0].worktree.branch === 'b')

// ── 3) get_task 事前标注 ───────────────────────────────────────────────
// a) 落到磁盘分支（内存 unknown）：记录带 provider → 权威标注
const getAcp = makeTools({
  loadPersistedRun: async () => ({ childId: 'acp-running', provider: 'acp', status: 'cancelled', result: '部分产出' }),
})
const acpView = await getAcp.get(TOOL_NAMES.GET_TASK).execute({ childId: 'acp-running' }, {})
console.log('\n=== 3) get_task（磁盘记录，acp）实际返回的关键字段 ===\n')
console.log(JSON.stringify({ status: acpView.status, steerMode: acpView.steerMode, steerNote: acpView.steerNote }, null, 2))
record('get_task：磁盘 acp 记录标 restart-with-output', acpView.steerMode === 'restart-with-output')

// b) running 分支：内存视图不含 provider，且不能读盘（回归不变量）
let diskReads = 0
const getRunning = makeTools({
  dispatcher: { dispatch: async () => ({}), cancel: async () => ({}), getTask: async () => ({ status: 'running', childId: 'running-1', output: '' }) },
  loadPersistedRun: async () => { diskReads += 1; return { status: 'running', schemaVersion: 1 } },
})
const runningView = await getRunning.get(TOOL_NAMES.GET_TASK).execute({ childId: 'running-1' }, {})
console.log('\n=== get_task（running，内存视图）实际返回的关键字段 ===\n')
console.log(JSON.stringify({ status: runningView.status, steerMode: runningView.steerMode, steerNote: runningView.steerNote, diskReads }, null, 2))
record('get_task：running 不读盘（不变量保持）', diskReads === 0)
record('get_task：running 缺通道信息时标 unknown（诚实、失败关闭）', runningView.steerMode === 'unknown')
record('get_task：unknown 说明「按不支持处理」', /按不支持处理/.test(runningView.steerNote ?? ''))

// ── 4) steerPreview 四类通道 ───────────────────────────────────────────
console.log('\n=== 4) steerPreview 通道矩阵 ===\n')
for (const provider of ['spawn', 'acp', 'codex', 'claude-code', 'acp-kimi', '']) {
  const p = steerPreview(provider ? { provider, status: 'running' } : { status: 'running' })
  console.log(`  ${(provider || '(未标注)').padEnd(14)} → ${p.steerMode.padEnd(20)} ${p.steerNote}`)
}
record('steerPreview：spawn=steer', steerPreview({ provider: 'spawn' }).steerMode === 'steer')
for (const provider of ['acp', 'codex', 'claude-code', 'acp-kimi']) {
  record(`steerPreview：${provider}=restart-with-output`, steerPreview({ provider }).steerMode === 'restart-with-output')
}
record('steerPreview：无 provider=unknown', steerPreview({}).steerMode === 'unknown')
record('steerPreview：不受终态影响（终态仍标通道语义）', steerPreview({ provider: 'acp', status: 'completed' }).steerMode === 'restart-with-output')

// ── 5) 事后回执的兜底披露未被删除（本次只补「事前」，不拆「事后」）──────
const steerTools = makeTools({
  loadPersistedRun: async () => ({
    childId: 'old-child', role: 'role-sashi', provider: 'acp', status: 'running',
    projectRoot: 'D:/proj', projectKey: 'd:/proj', isolation: 'worktree', result: '已完成第 1 步',
  }),
})
const receipt = await steerTools.get(TOOL_NAMES.STEER_TASK).execute(
  { childId: 'old-child', instruction: '只改 B' },
  { agent: { id: 'session-1' } },
)
console.log('\n=== 5) steer 事后回执（兜底披露仍在）===\n')
console.log(JSON.stringify({ mode: receipt.mode, note: receipt.note }, null, 2))
record('事后回执仍是 mode=restart-with-output', receipt.mode === 'restart-with-output')
record('事后回执 note 仍明说「这不是真插话」', /这不是真插话/.test(receipt.note ?? ''))

// ── 汇总 ───────────────────────────────────────────────────────────────
const pass = checks.filter((c) => c.pass).length
const fail = checks.length - pass
console.log('\n=== 汇总 ===\n')
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
console.log(`\n结果：${pass} PASS / ${fail} FAIL / ${checks.length} 项`)
process.exit(fail === 0 ? 0 : 1)
