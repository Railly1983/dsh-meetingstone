// @ts-check
/**
 * 能力目录的**来源真实性**测试。
 *
 * ## 为什么需要这个文件（2026-11-12 用户真机反馈）
 *
 * 用户原话：
 * > 「模型和强度的下拉选项里，只有我之前使用的选项，
 * >   没有从模型接口实时获取的信息。这个角色配置事实上是根本没法用的状态。」
 *
 * 根因：`codebuddy` / `claude` **没有 probe 实现**
 * （`createDefaultProbes` 里只有 `codex` 和 `dsh`），所以它们的模型只能来自
 * 静态配置。但 UI 若不标明来源，用户会以为「这就是接口返回的实时列表」。
 *
 * ## 本文件守住的底线
 *
 * **没有 probe 的 CLI，其来源绝不能是 `discovered`。**
 * 静态配置不许伪装成实时数据。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_SOURCES,
  CLI_IDS,
  createCliCapabilityCatalog,
  createDefaultProbes,
} from '../src/cli/capabilities.js'

/** 造一个最小 catalog（不传 probes = 全部走静态配置）。 */
function makeCatalog(overrides = {}) {
  return createCliCapabilityCatalog({
    channels: () => [
      { channelId: 'ch-a', kind: 'in-process', llmProvider: 'workbuddy', llmModel: 'model-a', reasoning: 'high' },
      { channelId: 'ch-b', kind: 'acp-cli', provider: 'acp-kimi', model: 'model-b', reasoning: 'high' },
    ],
    roles: () => [],
    ...overrides,
  })
}

test('CAPABILITY_SOURCES 四个值齐全', () => {
  assert.deepEqual(Object.keys(CAPABILITY_SOURCES).sort(), [
    'CONFIG',
    'DISCOVERED',
    'STATIC',
    'UNKNOWN',
  ])
})

test('没有 probes 时，所有 CLI 的来源都不能是 discovered', () => {
  // 这是本文件最重要的一条：不传 probes（等价于「没有实时探测能力」），
  // 那么任何 CLI 都不得声称自己拿到了实时数据。
  const catalog = makeCatalog({ probes: {} })
  const snap = catalog.snapshot()
  // 真实结构：CLI 级来源在 `sources: { models, strengths }`（不是 `source`）。
  for (const entry of snap.capabilities) {
    assert.ok(entry.sources, `${entry.id} 必须有 sources 字段`)
    assert.notEqual(
      entry.sources.models,
      CAPABILITY_SOURCES.DISCOVERED,
      `${entry.id} 没有任何 probe 实现，models 来源不能是 discovered（那是伪装成实时数据）`,
    )
  }
})

test('createDefaultProbes 现在有 codex / dsh / codebuddy（如实记录现状）', () => {
  // 这条测试的价值：**probe 实现变化时必须显式改这里**，
  // 提醒同步更新文档与该 CLI 的 source 标注，而不是让「有 probe」这件事悄悄发生。
  //
  // 2026-11-12 变更：新增 codebuddy 的 ACP 探测（session/new 拿 availableModels）。
  // claude 仍无 probe —— 它只有 --model <alias>（fable/opus/sonnet），不可枚举。
  const probes = createDefaultProbes({})
  const implemented = Object.keys(probes).sort()
  assert.deepEqual(
    implemented,
    ['codebuddy', 'codex', 'dsh'],
    `probe 实现变了：现在是 ${implemented.join(', ')}。` +
      '如果新增了 claude 的探测，请同时更新本断言与该 CLI 的 source 标注。',
  )
})

test('CLI_IDS 覆盖 4 个通道（dsh / codex / codebuddy / claude）', () => {
  assert.deepEqual([...CLI_IDS].sort(), ['claude', 'codebuddy', 'codex', 'dsh'])
})

test('配置里有模型时来源是 config，不是 discovered', () => {
  const catalog = makeCatalog({ probes: {} })
  const snap = catalog.snapshot()
  // in-process 通道的模型声明在 llmModel，必须被识别到
  const dsh = snap.capabilities.find((c) => c.id === 'dsh')
  assert.ok(dsh, 'dsh 条目必须存在')
  assert.ok(Array.isArray(dsh.models), 'models 必须是数组')
  if (dsh.models.length > 0) {
    assert.equal(
      dsh.sources.models,
      CAPABILITY_SOURCES.CONFIG,
      '来自配置的模型，sources.models 必须是 config',
    )
    // 模型级的 source 也要对
    for (const m of dsh.models) {
      assert.notEqual(m.source, CAPABILITY_SOURCES.DISCOVERED, `模型 ${m.id} 不该是 discovered`)
    }
  }
})

test('没有任何配置时，绝不能有任何 CLI 声称来源是 discovered', () => {
  // 唯一不可妥协的底线：没有探测能力就不能声称「实时」。
  // 允许的来源：unknown / static（内置表）/ config（可能来自内置表兜底）。
  // **不允许**：discovered。
  const catalog = createCliCapabilityCatalog({
    channels: () => [],
    roles: () => [],
    probes: {},
  })
  const snap = catalog.snapshot()
  for (const entry of snap.capabilities) {
    assert.notEqual(
      entry.sources?.models,
      CAPABILITY_SOURCES.DISCOVERED,
      `${entry.id} 在无配置无探测时声称发现式来源（discovered）—— 这是伪装成实时数据`,
    )
    // 模型级也不能有 discovered
    for (const m of entry.models ?? []) {
      assert.notEqual(m.source, CAPABILITY_SOURCES.DISCOVERED, `模型 ${m.id} 不该是 discovered`)
    }
  }
})

test('codebuddy / claude 的模型来自静态表或配置，不是实时探测', () => {
  // 2026-11-12 用户反馈「只有我之前使用的选项，没有实时获取的」。
  // 这**不是 bug，是事实**：这两个 CLI 没有可程序化枚举模型的接口。
  //   - codebuddy：--help 需后端环境（实测崩溃）；settings.json 只有 trustedDirectories
  //   - claude：只有 --model <alias>（fable/opus/sonnet），无可枚举列表
  // 本测试锁住这个事实：它们的来源绝不能是 discovered。
  const catalog = makeCatalog({ probes: {} })
  const snap = catalog.snapshot()
  for (const id of ['codebuddy', 'claude']) {
    const entry = snap.capabilities.find((c) => c.id === id)
    assert.ok(entry, `${id} 条目必须存在`)
    assert.notEqual(
      entry.sources.models,
      CAPABILITY_SOURCES.DISCOVERED,
      `${id} 没有 probe，来源绝不能是 discovered`,
    )
  }
})

test('refresh 在没有对应 probe 时不抛错，只记 errors', async () => {
  // 用户点「刷新能力」时，即使某些 CLI 没有探测能力，
  // 也不能整体崩溃 —— 要回 ok:false + errors，让 UI 能显示原因。
  const catalog = makeCatalog({ probes: {} })
  const result = await catalog.refresh('codebuddy', { force: true })
  assert.equal(typeof result, 'object')
  assert.ok(Array.isArray(result.errors), 'errors 必须是数组')
  assert.ok(Array.isArray(result.refreshed), 'refreshed 必须是数组')
  // 关键：不抛异常
})


// ── CodeBuddy ACP 探测（2026-11-12 新增）────────────────────────────
// 依据：ACP 规范的 session/new 返回 models.availableModels；
// 社区实测（farm-out observed-behaviour.md）确认「模型列表随 session 一起来」。
// 本机实测：20 个模型，5 秒左右，thought_level = high/enabled。

test('probeCodebuddyModels 缺可执行文件时抛明确错误，不静默', async () => {
  const { probeCodebuddyModels } = await import('../src/cli/capabilities.js')
  await assert.rejects(
    () => probeCodebuddyModels({}),
    (error) => {
      assert.match(String(error?.message ?? error), /CODEBUDDY_EXECUTABLE_MISSING/)
      return true
    },
  )
})

test('probeCodebuddyModels 进程启动失败时优雅退化', async () => {
  const { probeCodebuddyModels } = await import('../src/cli/capabilities.js')
  // 注入一个必然失败的 spawn
  const failingSpawn = () => {
    throw new Error('模拟 spawn 失败')
  }
  await assert.rejects(
    () => probeCodebuddyModels({ executable: 'C:/fake/codebuddy', spawnImpl: failingSpawn }),
    (error) => {
      assert.match(String(error?.message ?? error), /CODEBUDDY_SPAWN_FAILED/)
      return true
    },
  )
})

test('probeCodebuddyModels 子进程提前退出时优雅退化（不挂住）', async () => {
  const { probeCodebuddyModels } = await import('../src/cli/capabilities.js')
  const { EventEmitter } = await import('node:events')
  // 造一个立刻 exit 的假子进程
  const fakeChild = new EventEmitter()
  fakeChild.stdout = new EventEmitter()
  fakeChild.stderr = new EventEmitter()
  fakeChild.stdin = { write() {} }
  fakeChild.kill = () => {}
  setTimeout(() => fakeChild.emit('exit', 1), 10)
  await assert.rejects(
    () =>
      probeCodebuddyModels({
        executable: 'C:/fake/codebuddy',
        spawnImpl: () => fakeChild,
        timeoutMs: 3000,
      }),
    (error) => {
      assert.match(String(error?.message ?? error), /CODEBUDDY_EXITED_EARLY/)
      return true
    },
  )
})
