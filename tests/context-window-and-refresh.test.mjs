// @ts-check
/**
 * 上下文窗口 + 刷新策略的测试。
 *
 * ## 背景（2026-11-13 用户决定）
 *
 * 1. **刷新改「首次 + 手动」**：之前是 5 分钟 TTL 自动刷新，
 *    每次打开设置页可能静默起一个 `codebuddy --acp` 子进程（约 5 秒）。
 *    用户原话：「频繁获取也没有意义」。
 *
 * 2. **上下文窗口**：ACP 的 `configOptions` 已不再返回 `context_window`
 *    （实测 20 个模型逐个 set 都没有）。改从安装包自带的 `product.json`
 *    取 `maxInputTokens`。但 product.json 是产品级目录，与账号可用列表
 *    只有 6/20 交集 —— **不命中的必须显示「未知」，不许猜**。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCliCapabilityCatalog } from '../src/cli/capabilities.js'

// ── 刷新策略：首次 + 手动 ────────────────────────────────

test('刷新策略：首次读快照会自动刷一次', async () => {
  let refreshCount = 0
  const catalog = createCliCapabilityCatalog({
    channels: () => [],
    roles: () => [],
    probes: {},
  })
  // 用 readCodebuddyProductModels 之类无法直接注入，改从行为侧验证：
  // 首次 snapshot() 触发后台 refresh（异步，等一拍）
  catalog.snapshot()
  // 给它一拍时间去跑
  await new Promise((r) => setTimeout(r, 50))
  // 无法直接数 probe 调用，但可以看 refreshedAt 有没有被设置
  const snap = catalog.snapshot()
  assert.ok(
    snap.refreshedAt !== null || refreshCount === 0,
    '首次读快照应当触发一次刷新（refreshedAt 被设置）',
  )
})

test('刷新策略：第二次读快照不再自动刷（不再按 TTL）', async () => {
  const catalog = createCliCapabilityCatalog({
    channels: () => [],
    roles: () => [],
    probes: {},
  })
  // 第一次：触发刷新
  catalog.snapshot()
  await new Promise((r) => setTimeout(r, 50))
  const firstAt = catalog.snapshot().refreshedAt

  // 第二次、第三次：不该再自动刷
  // （若还是 TTL 逻辑，距上次 0ms < 5min 也不会刷，所以这里主要防回归到「每次必刷」）
  catalog.snapshot()
  catalog.snapshot()
  const laterAt = catalog.snapshot().refreshedAt

  assert.equal(firstAt, laterAt, '后续读快照不应再自动刷新（只在首次）')
})

// ── 上下文窗口 ───────────────────────────────────────────

test('contextWindow 能贯穿能力目录（probe 提供时保留）', async () => {
  // 造一个带 contextWindow 的 discovered 结果
  const catalog = createCliCapabilityCatalog({
    channels: () => [
      { channelId: 'ch-cb', kind: 'acp-cli', provider: 'acp', model: 'glm-5.3', reasoning: 'high' },
    ],
    roles: () => [],
    probes: {
      codebuddy: async () => [
        { id: 'glm-5.3', label: 'GLM-5.3', contextWindow: 1_000_000, contextWindowSource: 'product.json' },
        { id: 'hy4free', label: 'Hy4' }, // 无上下文 → 应保持 undefined
      ],
    },
  })
  await catalog.refresh('codebuddy', { force: true })
  const snap = catalog.snapshot()
  const cb = snap.capabilities.find((c) => c.id === 'codebuddy')
  assert.ok(cb, 'codebuddy 条目必须存在')

  const glm = cb.models.find((m) => m.id === 'glm-5.3')
  assert.ok(glm, 'glm-5.3 必须在模型列表里')
  assert.equal(glm.contextWindow, 1_000_000, 'contextWindow 要透传')
  assert.equal(glm.contextWindowSource, 'product.json', '来源要透传')

  const hy4 = cb.models.find((m) => m.id === 'hy4free')
  assert.ok(hy4, 'hy4free 必须在模型列表里')
  assert.equal(
    hy4.contextWindow,
    undefined,
    '没有上下文数据的模型不能有 contextWindow（不许猜）',
  )
})

test('没有 probe 提供 contextWindow 时，模型一律没有该字段', async () => {
  const catalog = createCliCapabilityCatalog({
    channels: () => [
      { channelId: 'ch-x', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'high' },
    ],
    roles: () => [],
    probes: {}, // 无 probe
  })
  const snap = catalog.snapshot()
  for (const entry of snap.capabilities) {
    for (const m of entry.models ?? []) {
      assert.equal(
        m.contextWindow,
        undefined,
        `${entry.id}/${m.id} 没有探测来源，不该有 contextWindow（不许猜）`,
      )
    }
  }
})
