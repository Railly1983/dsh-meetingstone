// @ts-check
/**
 * P0-S2：probe 的失败分类 + preflight 的分类/人工步骤/可重试。
 *
 * 重点证明：
 * - `installed` 不等于 `ready`（preflight 还要宿主集成证据）
 * - 拿不到证据时是 `unknown`，不伪造 ready
 * - 分类只来自真实证据，且**没有自动修复**（autoFix:false，manualSteps 只提示）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { PROBE_FAILURES, PROBE_SOURCES, createProbe } from '../src/cli/probe.js'
import {
  PREFLIGHT_MANUAL_STEPS,
  PREFLIGHT_REASONS,
  PREFLIGHT_STATUS,
  createPreflight,
} from '../src/cli/preflight.js'

const candidate = (path, source = PROBE_SOURCES.PATH) => ({ path, source })

/** 构造一个只返回固定 probe 结果的假探测器，并记录调用。 */
function fixedProbe(result, calls = []) {
  return {
    calls,
    async probe(cli, opts) {
      calls.push({ cli, opts })
      return {
        cli,
        installed: false,
        path: null,
        version: null,
        source: null,
        ready: false,
        blockedReason: null,
        notes: [],
        checkedAt: 1_700_000_000_000,
        ...result,
      }
    },
  }
}

test('probe：成功时 ready=true / blockedReason=null', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/codex.exe')]],
    runner: async () => ({ code: 0, stdout: 'codex-cli 1.2.3' }),
  })
  const res = await probe.probe('codex')
  assert.equal(res.installed, true)
  assert.equal(res.version, '1.2.3')
  assert.equal(res.ready, true)
  assert.equal(res.blockedReason, null)
})

test('probe：--version 权限错误 → permission-denied', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/codex.exe')]],
    runner: async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' }),
  })
  const res = await probe.probe('codex')
  assert.equal(res.installed, false)
  assert.equal(res.ready, false)
  assert.equal(res.blockedReason, PROBE_FAILURES.PERMISSION_DENIED)
})

test('probe：--version 提示未登录 → login-required', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/claude.exe')]],
    runner: async () => ({ code: 1, stdout: '', stderr: 'Not logged in. Run login first.' }),
  })
  const res = await probe.probe('claude')
  assert.equal(res.blockedReason, PROBE_FAILURES.LOGIN_REQUIRED)
})

test('probe：路径不存在 → path-invalid', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/codebuddy.cmd')]],
    runner: async () => ({ code: 1, stdout: '', stderr: 'ENOENT: no such file or directory' }),
  })
  const res = await probe.probe('codebuddy')
  assert.equal(res.blockedReason, PROBE_FAILURES.PATH_INVALID)
})

test('probe：runner 抛 EACCES → permission-denied', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/codex.exe')]],
    runner: async () => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    },
  })
  const res = await probe.probe('codex')
  assert.equal(res.blockedReason, PROBE_FAILURES.PERMISSION_DENIED)
})

test('probe：无候选 → not-installed；未知 CLI → unknown-cli', async () => {
  const probe = createProbe({ resolvers: [() => []], runner: async () => ({ code: 0 }) })
  const missing = await probe.probe('codex')
  assert.equal(missing.blockedReason, PROBE_FAILURES.NOT_INSTALLED)
  const unknown = await probe.probe('kimi')
  assert.equal(unknown.blockedReason, PROBE_FAILURES.UNKNOWN_CLI)
  assert.equal(unknown.ready, false)
})

test('preflight：installed + 宿主集成可用 → ready；登录证据仍是 unknown（不伪造已登录）', async () => {
  const calls = []
  const preflight = createPreflight({
    probe: fixedProbe(
      { installed: true, version: '1.2.3', path: 'C:/x/codex.exe', source: 'path', ready: true },
      calls,
    ),
    hostIntegration: () => true,
  })
  const result = await preflight.check('codex')
  assert.equal(result.ready, PREFLIGHT_STATUS.READY)
  assert.equal(result.blockedReason, null)
  assert.equal(result.login, 'unknown')
  assert.equal(result.hostIntegration, true)
  assert.equal(result.installed, true)
  assert.equal(result.version, '1.2.3')
  assert.equal(result.autoFix, false)
  assert.deepEqual(result.manualSteps, [])
  assert.equal(result.retryable, false)
  assert.equal(calls.length, 1)
})

test('preflight：宿主集成明确不可用 → blocked/host-integration-disabled', async () => {
  const preflight = createPreflight({
    probe: fixedProbe({ installed: true, version: '1.2.3', ready: true }),
    hostIntegration: () => false,
  })
  const result = await preflight.check('codex')
  assert.equal(result.ready, PREFLIGHT_STATUS.BLOCKED)
  assert.equal(result.blockedReason, PREFLIGHT_REASONS.HOST_INTEGRATION_DISABLED)
  assert.equal(result.retryable, true)
  assert.ok(result.manualSteps.length > 0)
  assert.equal(result.autoFix, false)
})

test('preflight：登录证据明确为 false → blocked/login-required（不自动登录）', async () => {
  const preflight = createPreflight({
    probe: fixedProbe({ installed: true, version: '2.0.0', ready: true }),
    hostIntegration: () => true,
    login: () => false,
  })
  const result = await preflight.check('claude')
  assert.equal(result.ready, PREFLIGHT_STATUS.BLOCKED)
  assert.equal(result.blockedReason, PREFLIGHT_REASONS.LOGIN_REQUIRED)
  assert.equal(result.login, false)
  assert.equal(result.retryable, true)
  assert.ok(result.manualSteps.some((step) => step.includes('登录')))
})

test('preflight：宿主集成没有证据 → unknown/evidence-missing，绝不猜 ready', async () => {
  const preflight = createPreflight({
    probe: fixedProbe({ installed: true, version: '1.2.3', ready: true }),
  })
  const result = await preflight.check('codex')
  assert.equal(result.ready, PREFLIGHT_STATUS.UNKNOWN)
  assert.equal(result.blockedReason, PREFLIGHT_REASONS.EVIDENCE_MISSING)
  assert.equal(result.hostIntegration, 'unknown')
  assert.equal(result.retryable, true)
})

test('preflight：证据检查抛错按 unknown 处理，不放行', async () => {
  const preflight = createPreflight({
    probe: fixedProbe({ installed: true, version: '1.2.3', ready: true }),
    hostIntegration: () => {
      throw new Error('boom')
    },
    login: () => {
      throw new Error('boom')
    },
  })
  const result = await preflight.check('codex')
  assert.equal(result.ready, PREFLIGHT_STATUS.UNKNOWN)
  assert.equal(result.hostIntegration, 'unknown')
  assert.equal(result.login, 'unknown')
})

test('preflight：probe 未安装 → blocked/not-installed，透传版本为空', async () => {
  const preflight = createPreflight({
    probe: fixedProbe({ installed: false, ready: false, blockedReason: PROBE_FAILURES.NOT_INSTALLED }),
  })
  const result = await preflight.check('claude')
  assert.equal(result.ready, PREFLIGHT_STATUS.BLOCKED)
  assert.equal(result.blockedReason, PREFLIGHT_REASONS.NOT_INSTALLED)
  assert.equal(result.installed, false)
  assert.equal(result.version, null)
  assert.equal(result.retryable, true)
  assert.ok(result.manualSteps.some((step) => step.includes('安装')))
})

test('preflight：probe 的权限/路径/启动失败分类原样透传', async () => {
  const cases = [
    [PROBE_FAILURES.PERMISSION_DENIED, PREFLIGHT_REASONS.PERMISSION_DENIED],
    [PROBE_FAILURES.PATH_INVALID, PREFLIGHT_REASONS.PATH_INVALID],
    [PROBE_FAILURES.STARTUP_FAILED, PREFLIGHT_REASONS.STARTUP_FAILED],
    [PROBE_FAILURES.LOGIN_REQUIRED, PREFLIGHT_REASONS.LOGIN_REQUIRED],
  ]
  for (const [probeReason, expected] of cases) {
    const preflight = createPreflight({
      probe: fixedProbe({ installed: false, ready: false, blockedReason: probeReason }),
    })
    const result = await preflight.check('codex')
    assert.equal(result.blockedReason, expected)
    assert.equal(result.retryable, true)
  }
})

test('preflight：未知 CLI 直接拒绝，不调用探测器、不可重检', async () => {
  const calls = []
  const preflight = createPreflight({ probe: fixedProbe({}, calls) })
  const result = await preflight.check('kimi')
  assert.equal(result.ready, PREFLIGHT_STATUS.BLOCKED)
  assert.equal(result.blockedReason, PREFLIGHT_REASONS.UNKNOWN_CLI)
  assert.equal(result.retryable, false)
  assert.equal(result.autoFix, false)
  assert.equal(calls.length, 0)
})

test('preflight：checkAll 覆盖三个外部 CLI，顺序稳定', async () => {
  const preflight = createPreflight({
    probe: fixedProbe({ installed: true, version: '1.0.0', ready: true }),
    hostIntegration: () => true,
  })
  const all = await preflight.checkAll()
  assert.deepEqual(all.map((item) => item.cli), ['codex', 'codebuddy', 'claude'])
})

test('preflight：人工步骤固定且每一类都非空（只提示、不自动修复）', () => {
  for (const reason of Object.values(PREFLIGHT_REASONS)) {
    const steps = PREFLIGHT_MANUAL_STEPS[/** @type {any} */ (reason)]
    assert.ok(Array.isArray(steps) && steps.length > 0, `${reason} 必须有可执行的人工步骤`)
    // 只提示、不承诺自动执行：不出现「将自动 / 自动为你 / 自动修复」这类承诺。
    assert.ok(
      steps.every((step) => !/(将|会|可)自动|自动为你/.test(step)),
      `${reason} 不得承诺自动修复`,
    )
  }
})
