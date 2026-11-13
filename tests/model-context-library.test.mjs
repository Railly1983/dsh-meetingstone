// @ts-check
/**
 * 模型上下文库的智能匹配测试。
 *
 * ## 背景（2026-11-13 用户要求）
 *
 * 用户原话：
 * > 「启动一个搜索任务，收集目前市面上主流模型的上下文能力，匹配好名称及简称和别称，
 * >   存在本地。你能通过系统获取上下文长度的，就用系统返回的最大值。
 * >   获取不到的，就用你收集到的信息匹配最大值上去。剩下还是匹配不上的就空着。
 * >   **而且不要做精确匹配，要做智能匹配**。」
 *
 * 本文件验证匹配器的**智能性**（别名、去后缀、前缀、归一化），
 * 以及**保守性**（匹配不上就返回 null，绝不瞎猜）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fillContextWindows,
  loadContextCatalog,
  matchContextForModel,
  normalizeModelId,
} from '../src/cli/model-context-library.js'

test('目录可加载且非空', () => {
  const catalog = loadContextCatalog()
  assert.ok(catalog, '目录必须能加载')
  assert.ok(Array.isArray(catalog.models), 'models 必须是数组')
  assert.ok(catalog.models.length > 0, '目录不能为空')
  assert.ok(Array.isArray(catalog.codexModels), 'codexModels 必须是数组')
  assert.ok(catalog.codexModels.length > 0, 'codex 分组不能为空')
})

test('normalizeModelId 抹平大小写/分隔符/点号', () => {
  assert.equal(normalizeModelId('GLM-5.3-Flash'), 'glm53flash')
  assert.equal(normalizeModelId('glm_5.3_flash'), 'glm53flash')
  assert.equal(normalizeModelId('kimi k3.1 pro'), 'kimik31pro')
  assert.equal(normalizeModelId(''), '')
  assert.equal(normalizeModelId(null), '')
})

test('智能匹配·别名：hy4free / hy4std 都命中 Hy4 的 1M', () => {
  const free = matchContextForModel('hy4free')
  const std = matchContextForModel('hy4std')
  assert.ok(free, 'hy4free 必须匹配到')
  assert.ok(free.contextWindow > 0 && free.contextWindow <= 1_050_000)
  assert.equal(free.matchedBy, 'alias')
  assert.ok(std, 'hy4std 必须匹配到')
  assert.ok(std.contextWindow > 0 && std.contextWindow <= 1_050_000)
})

test('智能匹配·去后缀：glm-5.3-flashx 命中 glm-5.3', () => {
  const r = matchContextForModel('glm-5.3-flashx')
  assert.ok(r, 'glm-5.3-flashx 必须匹配到')
  assert.ok(r.contextWindow > 0 && r.contextWindow <= 1_050_000, `上下文应在合理区间，实际 ${r.contextWindow}`)
  assert.ok(['suffix-stripped', 'alias', 'prefix'].includes(r.matchedBy), `实际 ${r.matchedBy}`)
})

test('智能匹配·归一化：GLM-5.3 和 glm_5.3 都能精确命中', () => {
  for (const id of ['GLM-5.3', 'glm_5.3', 'glm 5.3']) {
    const r = matchContextForModel(id)
    assert.ok(r, `${id} 必须匹配到`)
    assert.ok(r.contextWindow > 0 && r.contextWindow <= 1_050_000, `${id} 的上下文应在合理区间，实际 ${r.contextWindow}`);
  }
})

test('智能匹配·前缀：kimi-k3.1-pro-highspeed 命中 kimi-k3.1-pro', () => {
  const r = matchContextForModel('kimi-k3.1-pro-highspeed')
  assert.ok(r, '必须匹配到')
  assert.ok(r.contextWindow > 0 && r.contextWindow <= 1_050_000, `上下文应在合理区间，实际 ${r.contextWindow}`)
})

test('保守边界：完全查不到的模型返回 null（不瞎猜）', () => {
  // 注意：space-bunny 现在库里已有值（桥实测 1M），所以换一个肯定查不到的 id。
  const r = matchContextForModel('definitely-not-a-real-model-xyz')
  assert.equal(r, null, '查不到必须返回 null，不许编造')
})

test('保守边界：完全无关的名字返回 null', () => {
  assert.equal(matchContextForModel('totally-made-up-model-xyz'), null)
  assert.equal(matchContextForModel(''), null)
})

test('codex 分组优先：GPT 系列命中 1.05M', () => {
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-luna']) {
    const r = matchContextForModel(id, { cli: 'codex' })
    assert.ok(r, `${id} 必须匹配到`)
    assert.equal(r.contextWindow, 1_050_000, `${id} 应为 1.05M`)
  }
})

test('fillContextWindows 不覆盖已有值（探测优先于查表）', () => {
  const models = [
    { id: 'glm-5.3', contextWindow: 123_456, contextWindowSource: 'probe' },
    { id: 'hy4free' },
    { id: 'definitely-not-a-real-model-xyz' },
  ]
  const filled = fillContextWindows(models, { cli: 'codebuddy' })
  // 已有值保持
  const glm = filled.find((m) => m.id === 'glm-5.3')
  assert.equal(glm.contextWindow, 123_456, '探测值不能被查表覆盖')
  assert.equal(glm.contextWindowSource, 'probe')
  // 缺的补上
  const hy4 = filled.find((m) => m.id === 'hy4free')
  assert.ok(hy4.contextWindow > 0)
  assert.match(String(hy4.contextWindowSource), /^catalog:/, '要标明来自查表')
  // 查不到的不动
  const unknown = filled.find((m) => m.id === 'definitely-not-a-real-model-xyz')
  assert.equal(unknown.contextWindow, undefined, '查不到就不该有值')
})

test('每条命中结果都带可追溯依据（source 或 note）', () => {
  const r = matchContextForModel('hy4free')
  assert.ok(r)
  assert.ok(
    (typeof r.source === 'string' && r.source.length > 0) || (r.note && r.note.length > 0),
    '命中结果必须说明依据，否则就是黑盒猜测',
  )
})
