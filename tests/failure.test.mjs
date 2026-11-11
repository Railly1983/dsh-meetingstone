// @ts-check
/**
 * P1-A 失败快分类：每类故障映射、成功不误判、落盘与 get_task/list_runs 展示。
 *
 * 明确覆盖的真实故障：
 * - Codex `Product subagent failure (... category: limit)` → quota
 * - CodeBuddy hy4 `stopReason: refusal` + 空输出 → quota
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FAILURE_CLASSES,
  FAILURE_CLASS_VALUES,
  classifyFailure,
  hintForFailure,
  isFailureClass,
} from '../src/dispatch/failure.js'
import { createRunStore, RUNS_RELATIVE_DIR } from '../src/run-store.js'
import { createDshAdapter } from '../src/dsh/adapter.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'mt-failure-'))
}

// ─── 纯分类函数 ────────────────────────────────────────────────────────────────

test('分类白名单：8 类，且 isFailureClass 只认白名单', () => {
  assert.deepEqual(
    [...FAILURE_CLASS_VALUES].sort(),
    ['auth', 'crash', 'network', 'permission', 'quota', 'refusal', 'timeout', 'unknown'],
  )
  for (const value of FAILURE_CLASS_VALUES) {
    assert.equal(isFailureClass(value), true, `${value} 应属于白名单`)
  }
  for (const bad of [null, undefined, '', 'QUOTA', 'retry', 1, {}]) {
    assert.equal(isFailureClass(bad), false, `${String(bad)} 不应属于白名单`)
  }
  assert.equal(FAILURE_CLASSES.UNKNOWN, 'unknown')
})

test('每类故障映射到对应 failureClass，hint 非空', () => {
  /** @type {Array<[string, object]>} */
  const cases = [
    [
      'quota',
      {
        status: 'failed',
        stopReason: 'error',
        diagnostic:
          'Product subagent failure (product: Codex; stage: turn; category: limit)',
      },
    ],
    [
      'quota',
      {
        status: 'completed',
        stopReason: 'refusal',
        diagnostic: 'ACP 429 Too Many Requests',
        output: '',
      },
    ],
    // 真实故障：CodeBuddy 429 只回 refusal + 空输出，没带任何原因
    ['quota', { status: 'completed', stopReason: 'refusal', output: '' }],
    [
      'auth',
      { status: 'failed', stopReason: 'error', diagnostic: '401 Unauthorized: invalid api key' },
    ],
    [
      'permission',
      { status: 'failed', stopReason: 'error', diagnostic: '403 Forbidden: access denied' },
    ],
    [
      'timeout',
      { status: 'failed', stopReason: 'error', diagnostic: 'request timed out after 120s' },
    ],
    ['network', { status: 'failed', stopReason: 'error', diagnostic: 'ECONNRESET' }],
    [
      'refusal',
      {
        status: 'completed',
        stopReason: 'refusal',
        output: 'I cannot help with this request.',
      },
    ],
    [
      'refusal',
      {
        status: 'failed',
        stopReason: 'error',
        diagnostic: 'blocked by safety policy',
      },
    ],
    [
      'crash',
      {
        status: 'failed',
        stopReason: 'error',
        error: { code: 'ADAPTER_ERROR', message: 'process exited with exit code 1' },
      },
    ],
    [
      'unknown',
      {
        status: 'failed',
        stopReason: 'error',
        diagnostic: 'Product subagent failure (stage: turn; category: turn)',
      },
    ],
  ]
  for (const [expected, input] of cases) {
    const result = classifyFailure(input)
    assert.equal(result.failureClass, expected, `${JSON.stringify(input)} 应归为 ${expected}`)
    assert.equal(typeof result.hint, 'string')
    assert.ok(result.hint.length > 0, `${expected} 必须有非空建议`)
  }
})

test('不误判成功/取消任务：completed 与 cancelled 不带分类', () => {
  for (const input of [
    { status: 'completed', stopReason: 'completed', output: 'PONG' },
    // 成功输出里出现 429 字样也不该被当成故障：没有失败信号就不分类
    { status: 'completed', stopReason: 'completed', output: 'quota 429 只是文档内容' },
    {
      status: 'completed',
      stopReason: 'completed',
      output: 'PONG',
      diagnostic: 'late settlement: result settled after dispose timeout',
    },
    { status: 'cancelled', stopReason: 'cancelled', diagnostic: 'activation.dispose 失败（DISPOSE_TIMEOUT）' },
    { status: 'interrupted', stopReason: 'plugin-disposed', diagnostic: '插件卸载：任务被中断' },
  ]) {
    assert.deepEqual(classifyFailure(input), { failureClass: null, hint: null })
  }
  // 独立断言：任何 null hint 出口都只能是 null class
  assert.equal(classifyFailure().failureClass, null)
})

test('hintForFailure：未分类/未知类别也有兜底建议，provider 会写进建议', () => {
  assert.ok(hintForFailure('nope').length > 0)
  assert.match(hintForFailure(FAILURE_CLASSES.QUOTA, 'codex'), /codex|额度/)
})

// ─── 落盘：run-store 白名单、旧记录兼容 ───────────────────────────────────────

test('run-store：failureClass/hint 落盘；旧记录读取时补分类；成功记录不误判', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'codex-limit',
      status: 'failed',
      stopReason: 'error',
      provider: 'codex',
      diagnostic:
        'Product subagent failure (product: Codex; stage: turn; category: limit)',
    })
    const record = await store.loadRun('codex-limit')
    assert.equal(record.failureClass, 'quota')
    assert.match(record.hint, /额度|限流/)
    assert.match(record.hint, /codex/i, '建议里应带上 provider，方便主控换人')

    const raw = JSON.parse(
      await readFile(join(root, RUNS_RELATIVE_DIR, 'codex-limit.json'), 'utf8'),
    )
    assert.equal(raw.failureClass, 'quota', '原始 JSON 必须含 failureClass')
    assert.equal(typeof raw.hint, 'string', '原始 JSON 必须含 hint')

    // 成功记录：字段存在但为 null，列表/单查都不得误判
    await store.writeRun({
      childId: 'ok-run',
      status: 'completed',
      stopReason: 'completed',
      result: 'PONG',
    })
    const ok = await store.loadRun('ok-run')
    assert.equal(ok.failureClass, null)
    assert.equal(ok.hint, null)

    // 旧记录（没有 failureClass/hint）：读取时按 diagnostic 现算，不需要迁移
    const dir = join(root, RUNS_RELATIVE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'legacy-run.json'),
      JSON.stringify({
        childId: 'legacy-run',
        status: 'failed',
        stopReason: 'error',
        diagnostic: 'ECONNRESET',
        createdAt: 99,
      }),
      'utf8',
    )
    const legacy = await store.loadRun('legacy-run')
    assert.equal(legacy.failureClass, 'network')

    const listed = await store.listRuns()
    assert.equal(listed.find((run) => run.childId === 'codex-limit').failureClass, 'quota')
    assert.equal(listed.find((run) => run.childId === 'legacy-run').failureClass, 'network')
    assert.equal(listed.find((run) => run.childId === 'ok-run').failureClass, null)
    assert.ok(
      listed.find((run) => run.childId === 'codex-limit').hint.length > 0,
      'list_runs 默认应带建议',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ─── 工具层：get_task / list_runs 默认展示 ─────────────────────────────────────

test('get_task / list_runs 默认返回 failureClass 与 hint', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'quota-run',
      status: 'failed',
      stopReason: 'error',
      diagnostic: 'Product subagent failure (product: Codex; stage: turn; category: limit)',
    })
    const registered = new Map()
    registerTools(
      { tools: { register: (spec) => registered.set(spec.name, spec) } },
      {
        registry: { list: () => [], resolve: () => null, errors: [] },
        dispatcher: {
          dispatch: async () => ({}),
          getTask: async () => ({ status: 'unknown', childId: 'quota-run' }),
        },
        probe: { probe: async () => ({}) },
        loadPersistedRun: async (_exec, childId) => store.loadRun(childId),
        listPersistedRuns: async () => ({ runs: await store.listRuns(), dir: store.dir }),
      },
    )
    const exec = { agent: { session: { header: { cwd: root } } } }

    const task = await registered
      .get(TOOL_NAMES.GET_TASK)
      .execute({ childId: 'quota-run' }, exec)
    assert.equal(task.failureClass, 'quota')
    assert.match(task.hint, /额度|限流/)

    const runs = await registered.get(TOOL_NAMES.LIST_RUNS).execute({}, exec)
    assert.equal(runs.runs[0].failureClass, 'quota')
    assert.ok(runs.runs[0].hint.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ─── 适配器：真实结算路径带上分类，且不自动重试 ───────────────────────────────

function fakeRole(over = {}) {
  return {
    roleId: 'role-sashi',
    name: '沙僧',
    channel: { kind: 'acp-cli' },
    enabled: true,
    timeoutMs: 1000,
    ...over,
  }
}

function fakeSubagents(result) {
  const calls = { activation: 0 }
  return {
    calls,
    getProvider: () => ({}),
    async startActivation() {
      calls.activation += 1
      return {
        childId: 'child-failure',
        name: 'child-failure',
        result: typeof result === 'function' ? result() : result,
        dispose: async () => {},
      }
    },
  }
}

async function runAdapter(result) {
  const subagents = fakeSubagents(result)
  const finished = []
  const adapter = createDshAdapter(
    { subagents, effect: null, logger: { info() {}, warn() {} } },
    {
      getParent: () => ({ id: 'root' }),
      onRunFinish: (record) => finished.push(record),
    },
  )
  await adapter.start({
    role: fakeRole(),
    task: 'x',
    timeoutMs: 1000,
    context: {
      projectRoot: 'D:/proj',
      agent: { session: { header: { cwd: 'D:/proj' } } },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  return { subagents, finished }
}

test('适配器：refusal+空输出 → failureClass=quota（不伪造成功、不自动重试）', async () => {
  const { subagents, finished } = await runAdapter(
    Promise.resolve({ stopReason: 'refusal', output: [] }),
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].failureClass, 'quota')
  assert.match(finished[0].hint, /额度|限流/)
  assert.equal(subagents.calls.activation, 1, '分类只给建议，不得自动重试')
})

test('适配器：Codex category: limit 拒绝路径 → failureClass=quota', async () => {
  const { subagents, finished } = await runAdapter(() =>
    Promise.reject(
      new Error(
        'Product subagent failure (product: Codex; stage: turn; category: limit)',
      ),
    ),
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
  assert.equal(finished[0].failureClass, 'quota')
  assert.match(finished[0].hint, /额度|限流/)
  assert.equal(subagents.calls.activation, 1, '失败后不得自动重试')
})

test('适配器：成功任务不带分类（避免把正常完成误报为失败）', async () => {
  const { finished } = await runAdapter(
    Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PONG' }] }),
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].failureClass, undefined)
  assert.equal(finished[0].hint, undefined)
})
