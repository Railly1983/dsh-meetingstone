// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLI_SPECS,
  PROBE_SOURCES,
  createProbe,
  parseVersion,
} from '../src/cli/probe.js'

/** 简易 runner 工厂：按路径映射返回值并记录调用。 */
function fakeRunner(map, calls = []) {
  return async (path, args) => {
    calls.push({ path, args })
    const hit = map[path]
    if (!hit) return { code: 1, stdout: '', stderr: 'not found' }
    return hit
  }
}

const candidate = (path, source) => ({ path, source })

test('parseVersion：codex 与 codebuddy 的输出格式', () => {
  assert.equal(parseVersion('codex', 'codex-cli 0.167.0-alpha.3.2'), '0.167.0-alpha.3.2')
  assert.equal(parseVersion('codebuddy', '2.181.0'), '2.181.0')
  assert.equal(parseVersion('claude', '1.2.3 (Claude Code)'), '1.2.3')
  assert.equal(parseVersion('codex', 'garbage'), null)
  assert.equal(parseVersion('unknown', '1.0.0'), null)
})

test('探测规格覆盖三个目标 CLI', () => {
  assert.deepEqual(Object.keys(CLI_SPECS).sort(), ['claude', 'codebuddy', 'codex'])
  const pattern = CLI_SPECS.codex.appxPattern
  assert.ok(pattern instanceof RegExp, 'codex 必须有 appx 包名前缀规则')
  assert.ok(pattern.test('OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0'))
  assert.ok(!pattern.test('OpenAI.CodexPrimaryRuntime.v26-1105-1297-0_x64__3k8sg7r9htsxt'))
})

test('按 resolver 优先级取第一个能跑通的候选', async () => {
  const calls = []
  const probe = createProbe({
    resolvers: [
      () => [candidate('C:/w/path/codex.exe', PROBE_SOURCES.PATH)],
      () => [candidate('C:/Program Files/WindowsApps/OpenAI.Codex_1/app/resources/codex.exe', PROBE_SOURCES.APPX)],
    ],
    runner: fakeRunner(
      {
        'C:/Program Files/WindowsApps/OpenAI.Codex_1/app/resources/codex.exe': {
          code: 0,
          stdout: 'codex-cli 0.167.0-alpha.3.2',
        },
      },
      calls,
    ),
  })

  const res = await probe.probe('codex')
  assert.equal(res.installed, true)
  assert.equal(res.source, PROBE_SOURCES.APPX, 'PATH 候选跑不通时应回退到 appx')
  assert.equal(res.version, '0.167.0-alpha.3.2')
  assert.equal(calls.length, 2, '两个候选都应被试跑')
})

test('PATH 命中时不再试跑后续候选', async () => {
  const calls = []
  const probe = createProbe({
    resolvers: [
      () => [candidate('C:/npm/codebuddy.cmd', PROBE_SOURCES.PATH)],
      () => [candidate('C:/other/codebuddy.exe', PROBE_SOURCES.KNOWN_DIR)],
    ],
    runner: fakeRunner({ 'C:/npm/codebuddy.cmd': { code: 0, stdout: '2.181.0' } }, calls),
  })
  const res = await probe.probe('codebuddy')
  assert.equal(res.installed, true)
  assert.equal(res.source, PROBE_SOURCES.PATH)
  assert.equal(calls.length, 1)
})

test('找不到任何候选 → installed:false 且带备注，不抛异常', async () => {
  const probe = createProbe({
    resolvers: [() => []],
    runner: fakeRunner({}),
  })
  const res = await probe.probe('claude')
  assert.equal(res.installed, false)
  assert.equal(res.path, null)
  assert.equal(res.version, null)
  assert.ok(res.notes.some((n) => n.includes('所有解析源')))
})

test('候选存在但都跑不通 → installed:false，备注记录原因', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/claude.exe', PROBE_SOURCES.PATH)]],
    runner: fakeRunner({ 'C:/x/claude.exe': { code: 1, stdout: '', stderr: 'boom' } }),
  })
  const res = await probe.probe('claude')
  assert.equal(res.installed, false)
  assert.ok(res.notes.some((n) => n.includes('退出码非 0')))
})

test('版本输出无法解析时不认账（宁可报未安装）', async () => {
  const probe = createProbe({
    resolvers: [() => [candidate('C:/x/claude.exe', PROBE_SOURCES.PATH)]],
    runner: fakeRunner({ 'C:/x/claude.exe': { code: 0, stdout: 'unknown format' } }),
  })
  const res = await probe.probe('claude')
  assert.equal(res.installed, false)
  assert.ok(res.notes.some((n) => n.includes('无法解析')))
})

test('多个候选去重，并在备注里说明选择顺序', async () => {
  const probe = createProbe({
    resolvers: [
      () => [candidate('C:/a/codex.exe', PROBE_SOURCES.PATH), candidate('C:/a/codex.exe', PROBE_SOURCES.APPX)],
      () => [candidate('C:/b/codex.exe', PROBE_SOURCES.APPX)],
    ],
    runner: fakeRunner({ 'C:/a/codex.exe': { code: 0, stdout: 'codex-cli 1.0.0' } }),
  })
  const res = await probe.probe('codex')
  assert.equal(res.version, '1.0.0')
  assert.ok(res.notes.some((n) => n.includes('2 个候选')))
})

test('缓存：TTL 内不重复解析，force / invalidate 生效', async () => {
  let resolveCount = 0
  let clock = 1000
  const probe = createProbe({
    resolvers: [
      () => {
        resolveCount += 1
        return [candidate('C:/a/codex.exe', PROBE_SOURCES.PATH)]
      },
    ],
    runner: fakeRunner({ 'C:/a/codex.exe': { code: 0, stdout: 'codex-cli 1.0.0' } }),
    now: () => clock,
    ttlMs: 100,
  })

  await probe.probe('codex')
  assert.equal(resolveCount, 1)

  await probe.probe('codex')
  assert.equal(resolveCount, 1, 'TTL 内应命中缓存')

  clock += 200
  await probe.probe('codex')
  assert.equal(resolveCount, 2, 'TTL 过期应重新解析')

  await probe.probe('codex', { force: true })
  assert.equal(resolveCount, 3, 'force 应绕过缓存')

  probe.invalidate('codex')
  await probe.probe('codex')
  assert.equal(resolveCount, 4, 'invalidate 后应重解析')
})

test('resolver 抛异常被兜住，不影响其它解析源', async () => {
  const probe = createProbe({
    resolvers: [
      () => {
        throw new Error('appx 查询失败')
      },
      () => [candidate('C:/npm/codebuddy.cmd', PROBE_SOURCES.PATH)],
    ],
    runner: fakeRunner({ 'C:/npm/codebuddy.cmd': { code: 0, stdout: '2.181.0' } }),
  })
  const res = await probe.probe('codebuddy')
  assert.equal(res.installed, true)
  assert.ok(res.notes.some((n) => n.includes('appx 查询失败')))
})

test('probeAll 覆盖全部 CLI 且各自独立', async () => {
  const probe = createProbe({
    resolvers: [
      (spec) =>
        spec.bin === 'codebuddy' ? [candidate('C:/npm/codebuddy.cmd', PROBE_SOURCES.PATH)] : [],
    ],
    runner: fakeRunner({ 'C:/npm/codebuddy.cmd': { code: 0, stdout: '2.181.0' } }),
  })
  const all = await probe.probeAll()
  assert.equal(all.length, 3)
  const byCli = Object.fromEntries(all.map((r) => [r.cli, r]))
  assert.equal(byCli.codebuddy.installed, true)
  assert.equal(byCli.codex.installed, false)
  assert.equal(byCli.claude.installed, false)
})

test('未知 CLI 直接返回未安装，不崩', async () => {
  const probe = createProbe({ resolvers: [], runner: fakeRunner({}) })
  const res = await probe.probe('kimi')
  assert.equal(res.installed, false)
  assert.ok(res.notes.some((n) => n.includes('未知')))
})
