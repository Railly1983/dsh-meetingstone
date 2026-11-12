// @ts-check
/**
 * B2b：CLI 能力目录（4 CLI × 模型 × 思考强度）。
 *
 * 覆盖验收要求：
 * - 形状固定：4 CLI（dsh/claude/codex/codebuddy），每项 {id,label,models,strengths,sources}
 * - provider 映射：dsh→spawn、claude→claude-code、codex 模型级、codebuddy 模型级
 * - 来源优先级：动态发现 > 静态已知表 > unknown；不得伪造
 * - 刷新缓存可观测（refreshedAt / errors），失败保留静态表
 * - 宿主快照 global.capabilities 返回 4 CLI
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_SOURCES,
  CLI_IDS,
  CLI_LABELS,
  createCliCapabilityCatalog,
  extractHostModels,
  parseCodexModelList,
  providerForModel,
} from '../src/cli/capabilities.js'
import { createGuiState } from '../src/gui/host.js'

test('B2b 静态目录：固定 4 CLI、标签正确、来源标注不伪造', () => {
  const catalog = createCliCapabilityCatalog({ autoRefresh: false })
  const caps = catalog.snapshot().capabilities
  assert.deepEqual(caps.map((entry) => entry.id), ['dsh', 'claude', 'codex', 'codebuddy'])
  assert.deepEqual(
    caps.map((entry) => entry.label),
    ['DeepSeek Harness', 'Claude Code', 'Codex', 'CodeBuddy'],
  )
  for (const entry of caps) {
    assert.equal(typeof entry.id, 'string')
    assert.ok(Array.isArray(entry.models))
    assert.ok(Array.isArray(entry.strengths))
    assert.ok(entry.sources && typeof entry.sources.models === 'string')
    assert.ok(entry.sources && typeof entry.sources.strengths === 'string')
  }

  const byId = Object.fromEntries(caps.map((entry) => [entry.id, entry]))
  // dsh 无静态表 → unknown（不伪造模型/强度）
  assert.deepEqual(byId.dsh.models, [])
  assert.deepEqual(byId.dsh.strengths, [])
  assert.equal(byId.dsh.sources.models, CAPABILITY_SOURCES.UNKNOWN)
  assert.equal(byId.dsh.sources.strengths, CAPABILITY_SOURCES.UNKNOWN)
  // claude：--help 静态已知（别名 + effort 档位）
  assert.deepEqual(byId.claude.models.map((m) => m.id), ['sonnet', 'opus', 'fable'])
  assert.equal(byId.claude.sources.models, CAPABILITY_SOURCES.STATIC)
  assert.deepEqual(byId.claude.strengths.map((s) => s.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(byId.claude.sources.strengths, CAPABILITY_SOURCES.STATIC)
  // codex / codebuddy：模型静态表 + 强度 unknown（以动态发现为准，不伪造）
  assert.deepEqual(byId.codex.models.map((m) => m.id).sort(), ['gpt-6-astra', 'gpt-6.1-sol'])
  assert.equal(byId.codex.sources.models, CAPABILITY_SOURCES.STATIC)
  assert.deepEqual(byId.codex.strengths, [])
  assert.equal(byId.codex.sources.strengths, CAPABILITY_SOURCES.UNKNOWN)
  assert.deepEqual(byId.codebuddy.models.map((m) => m.id).sort(), ['deepseek-v4.1-flash', 'hy3'])
  assert.equal(byId.codebuddy.sources.models, CAPABILITY_SOURCES.STATIC)
  assert.equal(byId.codebuddy.sources.strengths, CAPABILITY_SOURCES.UNKNOWN)
})

test('B2b provider 映射：模型级优先，未知模型回退 CLI 级', () => {
  assert.equal(providerForModel('dsh', 'deepseek-flash'), 'spawn')
  assert.equal(providerForModel('claude', 'sonnet'), 'claude-code')
  assert.equal(providerForModel('codex', 'gpt-6-astra'), 'codex')
  assert.equal(providerForModel('codex', 'gpt-6.1-sol'), 'codex-sol')
  assert.equal(providerForModel('codex', 'gpt-unknown'), 'codex')
  assert.equal(providerForModel('codebuddy', 'deepseek-v4.1-flash'), 'acp')
  assert.equal(providerForModel('codebuddy', 'hy3'), 'acp-hy4')
  assert.equal(providerForModel('codebuddy', 'unknown-model'), 'acp')
})

test('B2b 刷新：动态发现覆盖静态表，来源/刷新时间可观测', async () => {
  const discovered = {
    codex: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', strengths: ['low', 'high'] },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', strengths: ['max'] },
    ],
    dsh: [{ id: 'deepseek-flash', label: 'DeepSeek Flash', strengths: ['high'] }],
  }
  const catalog = createCliCapabilityCatalog({
    autoRefresh: false,
    now: () => 1_700_000_000_000,
    probes: {
      codex: async () => discovered.codex,
      dsh: async () => discovered.dsh,
    },
  })
  assert.equal(catalog.snapshot().capabilities[0].sources.models, CAPABILITY_SOURCES.UNKNOWN)

  const result = await catalog.refresh(null, { force: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.refreshed, ['dsh', 'claude', 'codex', 'codebuddy'])
  const snapshot = catalog.snapshot()
  assert.equal(snapshot.refreshedAt, 1_700_000_000_000)
  assert.deepEqual(snapshot.errors, [])

  const byId = Object.fromEntries(snapshot.capabilities.map((entry) => [entry.id, entry]))
  // 动态发现生效：模型/来源/provider 全部对齐
  assert.deepEqual(byId.codex.models.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-astra'])
  assert.equal(byId.codex.models[0].provider, 'codex-sol')
  assert.equal(byId.codex.models[0].source, CAPABILITY_SOURCES.DISCOVERED)
  assert.equal(byId.codex.sources.models, CAPABILITY_SOURCES.DISCOVERED)
  assert.deepEqual(byId.codex.strengths.map((s) => s.id).sort(), ['high', 'low', 'max'])
  assert.equal(byId.codex.sources.strengths, CAPABILITY_SOURCES.DISCOVERED)
  assert.deepEqual(byId.dsh.models.map((m) => m.id), ['deepseek-flash'])
  assert.equal(byId.dsh.models[0].provider, 'spawn')
  assert.equal(byId.dsh.sources.models, CAPABILITY_SOURCES.DISCOVERED)
  // 无可动态来源的 CLI 保留静态表，不因刷新丢失
  assert.deepEqual(byId.claude.models.map((m) => m.id), ['sonnet', 'opus', 'fable'])
  assert.equal(byId.claude.sources.models, CAPABILITY_SOURCES.STATIC)
  assert.deepEqual(byId.codebuddy.models.map((m) => m.id).sort(), ['deepseek-v4.1-flash', 'hy3'])
})

test('B2b 刷新失败：保留静态表并记录错误（不伪造 discovered）', async () => {
  const catalog = createCliCapabilityCatalog({
    autoRefresh: false,
    probes: {
      codex: async () => {
        throw new Error('app-server 不可用')
      },
    },
  })
  const result = await catalog.refresh('codex', { force: true })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => line.includes('codex') && line.includes('app-server')))
  const codex = catalog.snapshot().capabilities.find((entry) => entry.id === 'codex')
  assert.deepEqual(codex.models.map((m) => m.id).sort(), ['gpt-6-astra', 'gpt-6.1-sol'])
  assert.equal(codex.sources.models, CAPABILITY_SOURCES.STATIC)
  assert.ok(codex.errors.some((line) => line.includes('codex')))
})

test('B2b 动态返回空列表 = discovered 空（不回退静态表、不伪造）', async () => {
  const catalog = createCliCapabilityCatalog({
    autoRefresh: false,
    probes: { codex: async () => [] },
  })
  await catalog.refresh('codex', { force: true })
  const codex = catalog.snapshot().capabilities.find((entry) => entry.id === 'codex')
  assert.deepEqual(codex.models, [])
  assert.equal(codex.sources.models, CAPABILITY_SOURCES.DISCOVERED, '动态成功但为空 → 以动态为准')
  assert.equal(codex.sources.strengths, CAPABILITY_SOURCES.UNKNOWN)
})

test('B2b 解析：codex model/list 与宿主 llm.listModels 保守提取', () => {
  const codex = parseCodexModelList({
    data: [
      {
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1-Sol',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      },
      { label: '既无 id 也无 model，应被忽略' },
    ],
  })
  assert.deepEqual(codex, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', strengths: ['low', 'high'] }])

  // 宿主模型：结构不符的条目直接丢弃，不猜
  const host = extractHostModels({
    models: [
      { id: 'deepseek-flash', displayName: 'DeepSeek Flash', reasoning: { efforts: ['low', { id: 'high' }] } },
      { label: 'missing-id' },
      null,
    ],
  })
  assert.deepEqual(host.models, [
    { id: 'deepseek-flash', label: 'DeepSeek Flash', strengths: ['low', 'high'] },
  ])
  assert.ok(host.notes.length >= 2)
})

test('B2b 宿主快照：global.capabilities 固定 4 CLI（dsh/claude/codex/codebuddy）', async () => {
  const catalog = createCliCapabilityCatalog({ autoRefresh: false })
  const gui = createGuiState({ capabilities: catalog, cliStates: async () => [] })
  const full = await gui.fullSnapshot()
  const caps = full.global.capabilities
  assert.deepEqual(caps.map((entry) => entry.id), CLI_IDS)
  assert.deepEqual(caps.map((entry) => entry.label), [
    CLI_LABELS.dsh,
    CLI_LABELS.claude,
    CLI_LABELS.codex,
    CLI_LABELS.codebuddy,
  ])
  assert.equal(full.global.capabilitiesRefreshedAt, null)
  assert.deepEqual(full.global.capabilitiesErrors, [])
})
