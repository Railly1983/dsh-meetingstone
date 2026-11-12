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
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CAPABILITY_SOURCES,
  CLI_IDS,
  CLI_LABELS,
  createCliCapabilityCatalog,
  defaultProviderConfigPaths,
  extractHostModels,
  parseCodexModelList,
  parseProviderPatchRows,
  providerForCatalogModel,
  providerForModel,
  providerRowToCapability,
  providerRowsToCatalog,
  readProviderRowsFromProfileSync,
} from '../src/cli/capabilities.js'
import { createGuiState } from '../src/gui/host.js'

test('B2b 静态目录：固定 4 CLI、标签正确、来源标注不伪造', () => {
  const catalog = createCliCapabilityCatalog({ autoRefresh: false, configReader: null, configReaderSync: null })
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
    configReader: null,
    configReaderSync: null,
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
    configReader: null,
    configReaderSync: null,
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
    configReader: null,
    configReaderSync: null,
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
  const catalog = createCliCapabilityCatalog({ autoRefresh: false, configReader: null, configReaderSync: null })
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

// ─── B3a：config 源（profile provider 行真实声明） ───────────────────────────

const SAMPLE_PATCH = [
  '- id: subagent-acp',
  '  name: "@deepseek-ai/dsh-subagent-acp"',
  '  config:',
  '    providerName: acp',
  '    args:',
  '      - C:/path/codebuddy',
  '      - --acp',
  '      - --permission-mode',
  '      - acceptEdits',
  '      - --model',
  '      - glm-5.3-flash',
  '      - --effort',
  '      - high',
  '- insert:',
  '    - id: subagent-acp-kimi',
  '      name: "@deepseek-ai/dsh-subagent-acp"',
  '      config:',
  '        providerName: acp-kimi',
  '        args:',
  '          - --model',
  '          - kimi-k3.1-pro',
  '          - --effort',
  '          - high',
  '    - id: subagent-acp-hy4free',
  '      name: "@deepseek-ai/dsh-subagent-acp"',
  '      config:',
  '        providerName: acp-hy4free',
  '        args:',
  '          - --model',
  '          - hy4free',
  '          - --effort',
  '          - high',
  '- id: subagent-codex',
  '  name: "@deepseek-ai/dsh-subagent-codex"',
  '  config:',
  '    providerName: codex',
  '    model: gpt-6-astra',
  '    permissionMode: never',
  '- id: subagent-codex-sol',
  '  name: "@deepseek-ai/dsh-subagent-codex"',
  '  config:',
  '    providerName: codex-sol',
  '    model: gpt-6.1-sol',
  '- id: broken-acp-no-model',
  '  name: "@deepseek-ai/dsh-subagent-acp"',
  '  config:',
  '    providerName: acp-broken',
  '    args:',
  '      - --acp',
  '- id: disabled-acp',
  '  name: "@deepseek-ai/dsh-subagent-acp"',
  '  disabled: true',
  '  config:',
  '    providerName: acp-disabled',
  '    args:',
  '      - --model',
  '      - should-not-appear',
].join('\n')

test('B3a 解析：provider 行 args(--model/--effort) 与 config.model，异常行跳过', () => {
  const rows = parseProviderPatchRows(SAMPLE_PATCH)
  assert.equal(rows.length, 7, '逐行扫描出 7 行（含 broken/disabled）')

  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  const acp = providerRowToCapability(byId['subagent-acp'])
  assert.deepEqual(
    { cli: acp.cli, model: acp.model, effort: acp.effort, provider: acp.provider },
    { cli: 'codebuddy', model: 'glm-5.3-flash', effort: 'high', provider: 'acp' },
  )
  const kimi = providerRowToCapability(byId['subagent-acp-kimi'])
  assert.equal(kimi.model, 'kimi-k3.1-pro')
  assert.equal(kimi.provider, 'acp-kimi')
  const codex = providerRowToCapability(byId['subagent-codex-sol'])
  assert.deepEqual(
    { cli: codex.cli, model: codex.model, provider: codex.provider },
    { cli: 'codex', model: 'gpt-6.1-sol', provider: 'codex-sol' },
  )
  // 缺 --model / disabled 的行不产出能力（不猜）
  assert.equal(providerRowToCapability(byId['broken-acp-no-model']).model, null)
  assert.equal(providerRowToCapability(byId['disabled-acp']).cli, null)
})

test('B3a 合并：多 provider 行并入同一 CLI，provider 可反查', () => {
  const catalog = providerRowsToCatalog(parseProviderPatchRows(SAMPLE_PATCH))
  assert.deepEqual(catalog.codebuddy.models.map((m) => m.id).sort(), ['glm-5.3-flash', 'hy4free', 'kimi-k3.1-pro'])
  assert.deepEqual(catalog.codebuddy.strengths, ['high'])
  const providers = Object.fromEntries(catalog.codebuddy.models.map((m) => [m.id, m.provider]))
  assert.deepEqual(providers, {
    'glm-5.3-flash': 'acp',
    'kimi-k3.1-pro': 'acp-kimi',
    hy4free: 'acp-hy4free',
  })
  assert.deepEqual(catalog.codex.models.map((m) => `${m.id}@${m.provider}`).sort(), [
    'gpt-6-astra@codex',
    'gpt-6.1-sol@codex-sol',
  ])
  // 反查 helper（编辑器保存映射用）
  assert.equal(providerForCatalogModel(catalog.codebuddy.models, 'kimi-k3.1-pro'), 'acp-kimi')
  assert.equal(providerForCatalogModel(catalog.codebuddy.models, 'nope'), null)
})

test('B3a 目录：config 源优先于静态表，且不重复静态条目', () => {
  const rows = parseProviderPatchRows(SAMPLE_PATCH)
  const catalog = createCliCapabilityCatalog({
    autoRefresh: false,
    configReader: null,
    configReaderSync: () => ({ path: 'fixture', rows, catalog: providerRowsToCatalog(rows), errors: [] }),
  })
  const byId = Object.fromEntries(catalog.snapshot().capabilities.map((entry) => [entry.id, entry]))
  // config 覆盖静态：codebuddy 只出现 profile 里的模型（不再出现静态的 deepseek-v4.1-flash）
  assert.deepEqual(byId.codebuddy.models.map((m) => m.id).sort(), ['glm-5.3-flash', 'hy4free', 'kimi-k3.1-pro'])
  assert.equal(byId.codebuddy.sources.models, CAPABILITY_SOURCES.CONFIG)
  assert.equal(byId.codebuddy.models[0].source, CAPABILITY_SOURCES.CONFIG)
  assert.deepEqual(byId.codebuddy.strengths.map((s) => s.id), ['high'])
  assert.equal(byId.codebuddy.sources.strengths, CAPABILITY_SOURCES.CONFIG)
  assert.equal(byId.codex.sources.models, CAPABILITY_SOURCES.CONFIG)
  assert.equal(providerForCatalogModel(byId.codex.models, 'gpt-6.1-sol'), 'codex-sol')
  // claude 无 provider 行 → 保持静态
  assert.equal(byId.claude.sources.models, CAPABILITY_SOURCES.STATIC)
})

test('B3a 合并优先级：discovered 与 config 并集，同一模型以 discovered 为准', async () => {
  const rows = parseProviderPatchRows(SAMPLE_PATCH)
  const catalog = createCliCapabilityCatalog({
    autoRefresh: false,
    configReader: null,
    configReaderSync: () => ({ path: 'fixture', rows, catalog: providerRowsToCatalog(rows), errors: [] }),
    probes: {
      codex: async () => [
        { id: 'gpt-6-astra', label: 'Discovered Astra', strengths: ['max'] },
        { id: 'gpt-7-new', label: 'GPT-7', strengths: ['high'] },
      ],
    },
  })
  await catalog.refresh('codex', { force: true })
  const codex = catalog.snapshot().capabilities.find((entry) => entry.id === 'codex')
  const byModel = Object.fromEntries(codex.models.map((m) => [m.id, m]))
  assert.equal(byModel['gpt-6-astra'].source, CAPABILITY_SOURCES.DISCOVERED, '同 id 以 discovered 为准')
  assert.equal(byModel['gpt-7-new'].source, CAPABILITY_SOURCES.DISCOVERED)
  assert.equal(byModel['gpt-6.1-sol'].source, CAPABILITY_SOURCES.CONFIG, 'config 独有模型并入')
  assert.equal(byModel['gpt-6.1-sol'].provider, 'codex-sol')
  assert.equal(codex.sources.models, CAPABILITY_SOURCES.DISCOVERED)
  assert.deepEqual(codex.strengths.map((s) => s.id).sort(), ['high', 'max'])
})

test('B3a 刷新：重新读取 profile 变更（config 源）', async () => {
  const firstRows = parseProviderPatchRows('- id: acp-a\n  name: "@deepseek-ai/dsh-subagent-acp"\n  config:\n    providerName: acp\n    args:\n      - --model\n      - model-a')
  const secondRows = parseProviderPatchRows('- id: acp-a\n  name: "@deepseek-ai/dsh-subagent-acp"\n  config:\n    providerName: acp\n    args:\n      - --model\n      - model-b')
  const catalog = createCliCapabilityCatalog({
    autoRefresh: false,
    configReader: async () => ({ path: 'fixture-2', rows: secondRows, catalog: providerRowsToCatalog(secondRows), errors: [] }),
    configReaderSync: () => ({ path: 'fixture-1', rows: firstRows, catalog: providerRowsToCatalog(firstRows), errors: [] }),
  })
  assert.deepEqual(catalog.snapshot().capabilities.find((e) => e.id === 'codebuddy').models.map((m) => m.id), ['model-a'])
  await catalog.refresh(null, { force: true })
  const after = catalog.snapshot()
  assert.deepEqual(after.capabilities.find((e) => e.id === 'codebuddy').models.map((m) => m.id), ['model-b'])
  assert.equal(after.capabilitiesConfig.path, 'fixture-2')
})

test('B3a 读取：临时 profile patch 文件 → rows/catalog；缺失文件给错误不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mt-cap-config-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    await writeFile(file, SAMPLE_PATCH, 'utf8')
    const read = readProviderRowsFromProfileSync({ paths: [file] })
    assert.equal(read.path, file)
    assert.ok(read.rows.length >= 7)
    assert.ok(Array.isArray(read.catalog.codebuddy.models))
    assert.deepEqual(read.errors, [])

    const missing = readProviderRowsFromProfileSync({ paths: [join(dir, 'nope.yml')] })
    assert.equal(missing.path, null)
    assert.deepEqual(missing.catalog, {})
    assert.ok(missing.errors.some((line) => line.includes('未找到')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('B3a 路径：默认候选包含 $DSH_PROFILE_DIR 与 home profiles', () => {
  const paths = defaultProviderConfigPaths({
    env: { DSH_PROFILE_DIR: 'C:/profiles/desktop', DSH_PROFILE: 'desktop', DSH_HOME: 'C:/dsh', HOME: 'C:/home' },
    home: 'C:/home',
  })
  assert.ok(paths.includes(join('C:/profiles/desktop', 'cordis.patch.yml')))
  assert.ok(paths.includes(join('C:/dsh', 'profiles', 'desktop', 'cordis.patch.yml')))
})
