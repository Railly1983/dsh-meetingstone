// @ts-check
/**
 * P0-D「进行中重复任务去重」测试。
 *
 * 依据 docs/reference/efficiency-v1.0.md §3.5 / §5 表 8 / §8：
 * - 只对进行中（running/queued）任务去重，且必须确认「完全相同」
 * - 命中相同进行中任务 → 返回已有 taskRef + 当前状态（deduplicated:true），不新建子任务/额度/工作树
 * - 信息不足以证明相同 → 正常创建新任务（宁可重复也不误合）
 * - 不复用已完成任务结果；索引仅内存；并发相同请求只创建一个（先占位再启动）
 *
 * 版本指纹通过 createDispatcher 的 `versionFingerprint` 注入，避免测试依赖真实 git。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDispatcher,
  computeFingerprint,
  fingerprintParts,
  stableStringify,
  DISPATCH_ERRORS,
  VERSION_UNKNOWN,
} from '../src/dispatch/dispatcher.js'
import { createRegistry } from '../src/roles/registry.js'
import { registerTools } from '../src/dsh/register.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const ROLE = {
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli', cli: 'codebuddy', provider: 'acp' },
  enabled: true,
  timeoutMs: 1000,
}

/** 假适配器：start 立即返回带 childId/jobId 的 taskRef；任务保持进行中直到主动 onFinish。 */
function fakeAdapter(over = {}) {
  const calls = []
  let seq = 0
  return {
    calls,
    start: async (input) => {
      calls.push(input)
      seq += 1
      return {
        taskRef: {
          childId: `child-${seq}`,
          jobId: `job-${seq}`,
          provider: 'acp',
          name: `task-${seq}`,
        },
      }
    },
    ...over,
  }
}

function makeDispatcher(options = {}) {
  const registry = createRegistry({ globalRoles: options.roles ?? [ROLE] })
  const adapter = options.adapter ?? fakeAdapter()
  const dispatcher = createDispatcher({
    registry,
    adapter,
    ...(options.worktrees ? { worktrees: options.worktrees } : {}),
    // 关闭串行、放大额度：让「维度不同」的两个任务能真实并存，
    // 从而用 adapter.calls.length===2 证明「没被去重」（而不是被 WRITE_CONFLICT 挡掉）。
    limits: {
      defaultIsolation: 'none',
      serializeWrites: false,
      maxParallelWritesTotal: 10,
      ...(options.limits ?? {}),
    },
    versionFingerprint: options.versionFingerprint ?? (() => SHA_A),
  })
  return { dispatcher, adapter, registry }
}

const req = (over = {}) => ({ role: 'SS', task: '给登录模块补单测', ...over })

/** 两次派单 → 断言创建了两个独立任务（第二个不是去重回执）。 */
async function expectNoDedup(options, req2, label) {
  const { dispatcher, adapter } = makeDispatcher(options)
  const a = await dispatcher.dispatch(req())
  const b = await dispatcher.dispatch(req(req2))
  assert.equal(a.ok, true, `${label}: 第一次应成功`)
  assert.equal(b.ok, true, `${label}: 第二次应成功（正常创建新任务）`)
  assert.notEqual(b.deduplicated, true, `${label}: 不得被去重`)
  assert.equal(adapter.calls.length, 2, `${label}: 应创建两个独立任务`)
  return { dispatcher, adapter }
}

// ─── 指纹组成（纯函数） ──────────────────────────────────────────────────────

test('指纹组成：项目/角色ID/provider/任务内容/版本/isolation/关键参数 任一不同即不同', () => {
  const base = {
    req: { role: 'SS', task: 'do X' },
    role: ROLE,
    projectKey: 'd:/proj',
    isolation: /** @type {'none' | 'worktree'} */ ('none'),
    version: SHA_A,
  }
  const fp = (over) => computeFingerprint({ ...base, ...over })
  const f0 = fp({})
  assert.equal(fp({}), f0, '相同输入 → 稳定指纹')

  assert.notEqual(fp({ projectKey: 'd:/other' }), f0, '项目/工作区身份不同')
  assert.notEqual(fp({ role: { ...ROLE, roleId: 'role-other' } }), f0, '角色 ID 不同')
  assert.notEqual(
    fp({ role: { ...ROLE, channel: { ...ROLE.channel, provider: 'codex' } } }),
    f0,
    'provider 不同',
  )
  assert.notEqual(
    fp({ role: { ...ROLE, channel: { ...ROLE.channel, model: 'gpt-x' } } }),
    f0,
    '通道模型不同',
  )
  assert.notEqual(fp({ req: { role: 'SS', task: 'do Y' } }), f0, '任务内容不同')
  assert.notEqual(
    fp({ req: { role: 'SS', task: 'do X', taskSpec: { title: 'T', objective: 'O' } } }),
    f0,
    '有 TaskSpec 时结构化字段参与判定（不只 hash Prompt）',
  )
  assert.notEqual(fp({ version: SHA_B }), f0, '版本指纹不同')
  assert.notEqual(fp({ isolation: 'worktree' }), f0, 'isolation 不同')
  assert.notEqual(
    fp({ req: { role: 'SS', task: 'do X', taskSpec: { title: 'T', permissionPreset: 'read-only' } } }),
    f0,
    '权限档位不同',
  )
  assert.notEqual(
    fp({ req: { role: 'SS', task: 'do X', continuation: {} } }),
    f0,
    '上下文重放等关键参数不同',
  )
})

test('指纹含状态桶：status 固定为 in-progress（只对进行中任务去重）', () => {
  const parts = fingerprintParts({
    req: req(),
    role: ROLE,
    projectKey: 'd:/proj',
    isolation: 'none',
    version: SHA_A,
  })
  assert.ok(parts)
  assert.equal(parts.status, 'in-progress')
  assert.equal(parts.version, SHA_A)
  assert.equal(parts.role.roleId, 'role-sashi')
  assert.equal(parts.role.provider, 'acp')
  assert.equal(parts.params.isolation, 'none')
})

test('版本指纹 unknown → 不参与判定（computeFingerprint 返回 null）', () => {
  const args = { req: req(), role: ROLE, projectKey: 'p', isolation: 'none' }
  assert.equal(computeFingerprint({ ...args, version: VERSION_UNKNOWN }), null)
  assert.equal(computeFingerprint({ ...args, version: '' }), null)
  assert.equal(computeFingerprint({ ...args, version: null }), null)
  assert.equal(fingerprintParts({ ...args, version: VERSION_UNKNOWN }), null)
})

test('stableStringify：对象键顺序不影响指纹（规范化）', () => {
  const a = computeFingerprint({
    req: { role: 'SS', task: 'X', taskSpec: { title: 'T', objective: 'O' } },
    role: ROLE,
    projectKey: 'p',
    isolation: 'none',
    version: SHA_A,
  })
  const b = computeFingerprint({
    req: { task: 'X', role: 'SS', taskSpec: { objective: 'O', title: 'T' } },
    role: ROLE,
    projectKey: 'p',
    isolation: 'none',
    version: SHA_A,
  })
  assert.equal(a, b)
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})

// ─── 行为：命中 / 不命中 ──────────────────────────────────────────────────────

test('相同进行中任务：第二次返回既有 childId / deduplicated:true / 不新增 activation / 不占额度', async () => {
  const { dispatcher, adapter } = makeDispatcher()
  const a = await dispatcher.dispatch(req())
  assert.equal(a.ok, true)
  const b = await dispatcher.dispatch(req())

  assert.equal(b.ok, true)
  assert.equal(b.deduplicated, true, '命中去重')
  assert.equal(b.taskRef.childId, a.taskRef.childId, 'taskRef 用原 childId')
  assert.equal(b.taskRef.jobId, a.taskRef.jobId, 'taskRef 用原 jobId')
  assert.ok(['running', 'queued'].includes(b.status), '返回当前状态')
  assert.ok(b.deduplicatedFrom, '可选记录字段 deduplicatedFrom')
  assert.equal(adapter.calls.length, 1, '不创建第二个子任务 / 不新增 activation')
  assert.equal(dispatcher.stats().active, 1, '不占新额度')
  assert.equal(dispatcher.dedupIndexSize(), 1, '索引仍只有一条进行中占位')
})

test('角色 / provider / 项目 / 任务 / 版本不同 → 不去重（各自创建独立任务）', async () => {
  // 版本不同：同一 dispatcher 里 versionFingerprint 第 2 次返回不同 SHA
  await expectNoDedup(
    {
      versionFingerprint: (() => {
        let i = 0
        return () => (++i === 1 ? SHA_A : SHA_B)
      })(),
    },
    {},
    '版本不同',
  )
  await expectNoDedup({}, { task: '另一个任务' }, '任务内容不同')
  await expectNoDedup({}, { projectKey: 'D:/proj-b' }, '项目身份不同')

  const ROLE2 = { ...ROLE, roleId: 'role-reviewer', name: '审核员', aliases: ['RV'] }
  await expectNoDedup({ roles: [ROLE, ROLE2] }, { role: 'RV' }, '角色不同')

  // provider 不同：同一角色名经 req.registry 解析到不同通道
  await expectNoDedup(
    {},
    {
      registry: createRegistry({
        globalRoles: [{ ...ROLE, channel: { ...ROLE.channel, provider: 'codex' } }],
      }),
    },
    'provider 不同',
  )
})

test('isolation 不同 → 不去重（第二个不被合并为去重回执）', async () => {
  const worktrees = {
    async create({ projectRoot, operationId }) {
      return {
        path: `${projectRoot}/.wt/${operationId}`,
        branch: `mt/${operationId}`,
        baseSha: SHA_A,
        repositoryRoot: projectRoot,
        operationId,
      }
    },
  }
  const { dispatcher, adapter } = makeDispatcher({ worktrees })
  const a = await dispatcher.dispatch(req({ isolation: 'none' }))
  assert.equal(a.ok, true)
  const b = await dispatcher.dispatch(req({ isolation: 'worktree' }))
  // 指纹里的 isolation 不同，绝不会命中去重；隔离互斥使其 WRITE_CONFLICT，
  // 但**不是**去重回执（未与第一个任务合并）。
  assert.notEqual(b.deduplicated, true)
  assert.equal(b.code, DISPATCH_ERRORS.WRITE_CONFLICT)
  assert.equal(adapter.calls.length, 1)
})

test('版本 unknown（信息不足以证明相同）→ 正常创建、不进索引、不误合', async () => {
  const { dispatcher, adapter } = makeDispatcher({ versionFingerprint: () => VERSION_UNKNOWN })
  const a = await dispatcher.dispatch(req())
  const b = await dispatcher.dispatch(req())
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(b.deduplicated, true)
  assert.equal(adapter.calls.length, 2, '宁可重复也不误合')
  assert.equal(dispatcher.dedupIndexSize(), 0, 'unknown 不进入去重索引')
})

test('任务完成后再次相同请求 → 不去重（终态清理索引，不复用旧结果）', async () => {
  const { dispatcher, adapter } = makeDispatcher()
  const a = await dispatcher.dispatch(req())
  assert.equal(a.ok, true)
  assert.equal(dispatcher.dedupIndexSize(), 1)

  adapter.calls[0].onFinish() // 适配器终态回调
  assert.equal(dispatcher.stats().active, 0)
  assert.equal(dispatcher.dedupIndexSize(), 0, '终态必须清理索引')

  const b = await dispatcher.dispatch(req())
  assert.equal(b.ok, true)
  assert.notEqual(b.deduplicated, true, '已完成任务结果不复用')
  assert.equal(adapter.calls.length, 2, '应创建第二个子任务')
})

test('release 终止后索引清理且幂等', async () => {
  const { dispatcher } = makeDispatcher()
  const a = await dispatcher.dispatch(req())
  assert.equal(dispatcher.dedupIndexSize(), 1)
  assert.equal(dispatcher.release(a.taskRef), true)
  assert.equal(dispatcher.dedupIndexSize(), 0)
  assert.equal(dispatcher.release(a.taskRef), false, '重复 release 幂等')
  assert.equal(dispatcher.dedupIndexSize(), 0)
  const b = await dispatcher.dispatch(req())
  assert.notEqual(b.deduplicated, true)
})

test('cancel 确认停止后清理去重索引', async () => {
  const adapter = fakeAdapter({ cancel: async () => ({ stopConfirmed: true }) })
  const { dispatcher } = makeDispatcher({ adapter })
  const a = await dispatcher.dispatch(req())
  assert.equal(dispatcher.dedupIndexSize(), 1)
  const outcome = await dispatcher.cancel(a.taskRef)
  assert.equal(outcome.stopConfirmed, true)
  assert.equal(dispatcher.dedupIndexSize(), 0)
  const b = await dispatcher.dispatch(req())
  assert.notEqual(b.deduplicated, true)
  assert.equal(adapter.calls.length, 2)
})

test('首个启动失败回滚去重索引：等待者不挂死，之后相同请求正常创建', async () => {
  let attempt = 0
  const calls = []
  const adapter = {
    start: async (input) => {
      calls.push(input)
      attempt += 1
      if (attempt === 1) throw new Error('spawn ENOENT')
      return { taskRef: { childId: 'child-2', jobId: 'job-2' } }
    },
  }
  const { dispatcher } = makeDispatcher({ adapter })
  const a = await dispatcher.dispatch(req())
  assert.equal(a.ok, false)
  assert.equal(a.code, DISPATCH_ERRORS.ADAPTER_FAILED)
  assert.equal(dispatcher.dedupIndexSize(), 0, '失败必须清理占位')
  const b = await dispatcher.dispatch(req())
  assert.equal(b.ok, true)
  assert.notEqual(b.deduplicated, true)
  assert.equal(attempt, 2)
})

test('并发相同请求：受控 pending promise，只创建一个任务', async () => {
  /** @type {(v: any) => void} */
  let resolveStart = () => {}
  const calls = []
  const adapter = {
    start: (input) => {
      calls.push(input)
      return new Promise((r) => {
        resolveStart = r
      })
    },
  }
  const { dispatcher } = makeDispatcher({ adapter })

  const a = dispatcher.dispatch(req())
  const b = dispatcher.dispatch(req())
  // 让两个请求都推进过 realpath 等异步前置，到达占额度 / 去重判定。
  await new Promise((r) => setTimeout(r, 20))

  assert.ok(resolveStart !== undefined)
  assert.equal(calls.length, 1, '只允许一个 activation 启动（先占位再启动）')

  resolveStart({ taskRef: { childId: 'child-1', jobId: 'job-1' } })
  const ar = await a
  const br = await b
  assert.equal(ar.ok, true)
  assert.equal(br.deduplicated, true, '并发的第二个必须命中去重')
  assert.equal(br.taskRef.childId, 'child-1')
  assert.equal(br.taskRef.jobId, 'job-1')
  assert.equal(dispatcher.stats().active, 1, '只占一个额度')
  assert.equal(calls.length, 1)
})

// ─── 工具层回执 ──────────────────────────────────────────────────────────────

/** 用假 ctx 注册工具，返回 dispatch 工具与已注册列表。 @param {object} dispatcher */
function toolHarness(dispatcher) {
  const tools = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  registerTools(ctx, {
    registry: createRegistry({ globalRoles: [ROLE] }),
    dispatcher,
    probe: { probe: async () => ({}), probeAll: async () => [] },
  })
  return tools
}

test('dispatch 回执：命中时 deduplicated:true、taskRef 用原 childId/jobId、带 status', async () => {
  const dedupResult = {
    ok: true,
    deduplicated: true,
    taskRef: { childId: 'child-1', name: 't', provider: 'acp', jobId: 'job-1' },
    role: ROLE,
    isolation: 'none',
    status: 'running',
    deduplicatedFrom: 'child-1',
  }
  const tools = toolHarness({ dispatch: async () => dedupResult })
  const dispatch = tools.find((t) => t.name === 'meetingstone_dispatch')
  const res = await dispatch.execute({ role: 'SS', task: 'x' })
  assert.equal(res.ok, true)
  assert.equal(res.deduplicated, true)
  assert.equal(res.taskRef.childId, 'child-1', 'taskRef 用原值')
  assert.equal(res.taskRef.jobId, 'job-1')
  assert.equal(res.status, 'running')
  assert.equal(res.deduplicatedFrom, 'child-1')
  assert.equal(res.roleId, 'role-sashi')
})

test('dispatch 回执：非命中成功不携带 deduplicated（旧回执不被破坏）', async () => {
  const okResult = {
    ok: true,
    taskRef: { childId: 'child-9', provider: 'acp' },
    role: ROLE,
    isolation: 'none',
  }
  const tools = toolHarness({ dispatch: async () => okResult })
  const dispatch = tools.find((t) => t.name === 'meetingstone_dispatch')
  const res = await dispatch.execute({ role: 'SS', task: 'x' })
  assert.equal(res.ok, true)
  assert.equal(res.deduplicated, undefined)
  assert.equal(res.status, undefined)
  assert.equal(res.taskRef.childId, 'child-9')
})

test('端到端：工具层两次相同派单 → 第二次 deduplicated:true 且返回既有 childId', async () => {
  const { dispatcher, adapter } = makeDispatcher()
  const tools = toolHarness(dispatcher)
  const dispatch = tools.find((t) => t.name === 'meetingstone_dispatch')
  const exec = { agent: { session: { header: { cwd: 'D:/proj' } } } }

  const a = await dispatch.execute({ role: 'SS', task: 'do X' }, exec)
  const b = await dispatch.execute({ role: 'SS', task: 'do X' }, exec)
  assert.equal(a.ok, true)
  assert.equal(b.deduplicated, true)
  assert.equal(b.taskRef.childId, a.taskRef.childId)
  assert.equal(b.taskRef.jobId, a.taskRef.jobId)
  assert.equal(b.status, 'running')
  assert.equal(adapter.calls.length, 1)
  assert.equal(dispatcher.stats().active, 1)
})
