// @ts-check
/**
 * 角色状态模型（P0-S1）单元测试。
 *
 * 覆盖：
 * - `userPreference` 三态：显式 enabled / 显式 disabled / 默认值 -> unset
 * - `readiness` 三态：配置完整 + 有效通道 + provider 证据；缺证据 -> unknown
 * - `quota` 四态：V1 默认 unknown；按量付费 not_applicable；拒绝 429/refusal 推断
 * - 三色派生 3×3×4 全矩阵
 * - `deriveRoleView` 与旧 `availability` 兼容投影
 * - 三级继承的每字段来源、恢复继承、会话不污染全局/项目
 * - 旧配置零迁移（不要求新增字段、不修改入参）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDER_BY_KIND } from '../src/dsh/adapter.js'
import { normalizeConfig } from '../src/config.js'
import { createGuiState } from '../src/gui/host.js'
import { createRegistry } from '../src/roles/registry.js'
import {
  DEFAULT_PROVIDER_BY_KIND,
  QUOTA,
  READINESS,
  READINESS_REASON,
  ROLE_COLOR,
  STATE_MODEL_VALUES,
  USER_PREFERENCE,
  deriveQuota,
  deriveReadiness,
  deriveRoleColor,
  deriveRoleView,
  deriveUserPreference,
  inspectReadiness,
} from '../src/gui/state-model.js'
import { fieldSource, resolveEffectiveConfig } from '../src/session/config.js'

const ROOT = 'D:/proj'

/** 一份最小的有效角色。 */
function roleA(overrides = {}) {
  return {
    roleId: 'role-a',
    name: 'A',
    channel: { kind: 'acp-cli', provider: 'acp' },
    ...overrides,
  }
}

/** 构造 sources：fields 里给了什么就标什么。 */
function sourcesFor(fields = {}) {
  return { roles: { 'role-a': { layer: 'global', fields } } }
}

/** 内存文件系统 + 可注入 deps（与 tests/session-config.test.mjs 同款）。 */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  /** @type {{ path: string, text: string }[]} */
  const writes = []
  return {
    files,
    writes,
    deps: {
      readText: (/** @type {string} */ path) => {
        if (!files.has(path)) {
          const error = /** @type {any} */ (new Error('ENOENT'))
          error.code = 'ENOENT'
          throw error
        }
        return /** @type {string} */ (files.get(path))
      },
      writeText: async (/** @type {string} */ path, /** @type {string} */ text) => {
        files.set(path, text)
        writes.push({ path, text })
      },
      renameFile: async (/** @type {string} */ from, /** @type {string} */ to) => {
        const text = files.get(from)
        files.delete(from)
        files.set(to, text)
      },
      removeFile: async (/** @type {string} */ path) => {
        files.delete(path)
      },
      ensureDir: async () => {},
      now: () => 1_700_000_000_000,
    },
  }
}

test('枚举固定：两色（V1 裁决已删黄色与 exhausted），旧 availability 取值不变', () => {
  assert.deepEqual(STATE_MODEL_VALUES.userPreference, ['unset', 'enabled', 'disabled'])
  assert.deepEqual(STATE_MODEL_VALUES.readiness, ['ready', 'blocked', 'unknown'])
  // 2026-11-12 唐僧裁决：删掉 exhausted —— 宿主没有额度查询 API，
  // 用失败记录推断额度会把「历史某次失败」伪装成「当前无额度」。
  assert.deepEqual(STATE_MODEL_VALUES.quota, ['available', 'unknown', 'not_applicable'])
  assert.deepEqual(Object.values(ROLE_COLOR), ['gray', 'green'], 'V1 只有两色')
  assert.equal(ROLE_COLOR.YELLOW, undefined, 'YELLOW 必须不存在')
  assert.equal(QUOTA.EXHAUSTED, undefined, 'EXHAUSTED 必须不存在')
  assert.deepEqual(DEFAULT_PROVIDER_BY_KIND, PROVIDER_BY_KIND, '状态模型与适配器的 provider 映射不得漂移')
})

test('userPreference：只有显式 enabled 才算偏好，默认值映射 unset', () => {
  // 没有 sources：enabled=true 可能是 schema 默认值，不能当偏好
  assert.equal(deriveUserPreference(roleA({ enabled: true })), USER_PREFERENCE.UNSET)
  // enabled=false 只可能来自显式配置
  assert.equal(deriveUserPreference(roleA({ enabled: false })), USER_PREFERENCE.DISABLED)

  assert.equal(
    deriveUserPreference(roleA({ enabled: true }), { sources: sourcesFor({ enabled: 'default' }) }),
    USER_PREFERENCE.UNSET,
  )
  assert.equal(
    deriveUserPreference(roleA({ enabled: true }), { sources: sourcesFor({ enabled: 'global' }) }),
    USER_PREFERENCE.ENABLED,
  )
  assert.equal(
    deriveUserPreference(roleA({ enabled: true }), { sources: sourcesFor({ enabled: 'project' }) }),
    USER_PREFERENCE.ENABLED,
  )
  assert.equal(
    deriveUserPreference(roleA({ enabled: false }), { sources: sourcesFor({ enabled: 'session' }) }),
    USER_PREFERENCE.DISABLED,
  )
  // sources 里根本没有这个角色 -> 按默认值处理
  assert.equal(
    deriveUserPreference(roleA({ enabled: true }), { sources: { roles: {} } }),
    USER_PREFERENCE.UNSET,
  )
})

test('readiness：配置完整 + 有效通道 + provider 可用才 ready，缺证据不猜', () => {
  assert.equal(deriveReadiness(roleA(), { isProviderAvailable: () => true }), READINESS.READY)
  assert.equal(deriveReadiness(roleA(), { isProviderAvailable: () => false }), READINESS.BLOCKED)
  assert.equal(deriveReadiness(roleA(), {}), READINESS.UNKNOWN)

  const unavailable = inspectReadiness(roleA(), { subagents: { getProvider: () => null } })
  assert.equal(unavailable.readiness, READINESS.BLOCKED)
  assert.equal(unavailable.reason, READINESS_REASON.PROVIDER_UNAVAILABLE)

  const threw = inspectReadiness(roleA(), {
    subagents: {
      getProvider() {
        throw new Error('not injected')
      },
    },
  })
  assert.equal(threw.readiness, READINESS.UNKNOWN)
  assert.equal(threw.reason, READINESS_REASON.EVIDENCE_MISSING)

  // 旧 availability 只作为 provider 证据；disabled 不污染 readiness
  assert.equal(deriveReadiness(roleA({ enabled: false }), { availability: 'available' }), READINESS.READY)
  assert.equal(deriveReadiness(roleA(), { availability: 'unknown' }), READINESS.UNKNOWN)
  assert.equal(deriveReadiness(roleA(), { availability: 'provider-unavailable' }), READINESS.BLOCKED)

  // 配置不完整 -> blocked
  assert.equal(
    inspectReadiness({ roleId: 'role-a', name: 'A' }, {}).reason,
    READINESS_REASON.CHANNEL_MISSING,
  )
  assert.equal(
    inspectReadiness(roleA({ channel: { kind: 'bogus' } }), {}).reason,
    READINESS_REASON.CHANNEL_KIND_INVALID,
  )
  assert.equal(inspectReadiness({ name: 'A', channel: { kind: 'in-process' } }, {}).readiness, READINESS.BLOCKED)
  assert.equal(inspectReadiness({ roleId: 'role-a', channel: { kind: 'in-process' } }, {}).readiness, READINESS.BLOCKED)

  // 解析歧义：即使 provider 可用也不能 ready
  assert.equal(
    deriveReadiness(roleA({ ambiguous: true }), { isProviderAvailable: () => true }),
    READINESS.BLOCKED,
  )

  // in-process 用宿主默认 provider 名 spawn
  assert.equal(
    deriveReadiness(
      { roleId: 'role-b', name: 'B', channel: { kind: 'in-process' } },
      { isProviderAvailable: (name) => name === 'spawn' },
    ),
    READINESS.READY,
  )
})

test('quota：V1 默认 unknown；按量付费 not_applicable；拒绝失败信号推断', () => {
  assert.equal(deriveQuota(roleA()), QUOTA.UNKNOWN)
  assert.equal(deriveQuota(roleA({ billingMode: 'pay-as-you-go' })), QUOTA.NOT_APPLICABLE)
  assert.equal(deriveQuota(roleA(), { billingMode: 'pay-as-you-go' }), QUOTA.NOT_APPLICABLE)

  for (const quota of Object.values(QUOTA)) {
    assert.equal(deriveQuota(roleA(), { quota, quotaSource: 'meter' }), quota)
  }

  // 429 / refusal / failureClass=quota 只是失败分类，不得变成任何额度事实
  assert.equal(deriveQuota(roleA(), { failureClass: 'quota' }), QUOTA.UNKNOWN)
  assert.equal(deriveQuota(roleA(), { lastFailure: { failureClass: 'quota', stopReason: 'refusal' } }), QUOTA.UNKNOWN)
  assert.equal(deriveQuota(roleA(), { lastError: 'HTTP 429 rate limit' }), QUOTA.UNKNOWN)
  // 2026-11-12 裁决：exhausted 已不存在，传进来也必须被拒绝
  assert.equal(deriveQuota(roleA(), { quota: 'exhausted', quotaSource: 'failure' }), QUOTA.UNKNOWN)
  assert.equal(deriveQuota(roleA(), { quota: 'exhausted', quotaSource: 'inferred' }), QUOTA.UNKNOWN)
  assert.equal(deriveQuota(roleA(), { quota: 'exhausted' }), QUOTA.UNKNOWN, 'exhausted 不再被采纳')
})

test('两色矩阵：颜色只跟开关走（2026-11-16 用户裁决：不允许「打开但灰色」）', () => {
  // 用户原话：「只有开关两个状态就行吧，为什么要设 打开-但灰色不可用 这个状态」。
  // 新语义：只有 userPreference=disabled 才是灰，其余一律绿；
  // readiness 只在派单时才知道，不参与颜色（避免「配好了却显示坏了」的假失败）。
  const expected = (pref) =>
    pref === USER_PREFERENCE.DISABLED ? ROLE_COLOR.GRAY : ROLE_COLOR.GREEN

  for (const userPreference of Object.values(USER_PREFERENCE)) {
    for (const readiness of Object.values(READINESS)) {
      for (const quota of Object.values(QUOTA)) {
        assert.equal(
          deriveRoleColor({ userPreference, readiness, quota }),
          expected(userPreference),
          `${userPreference}/${readiness}/${quota}`,
        )
      }
    }
  }

  // 关键边界：readiness 不再是灰的理由
  assert.equal(
    deriveRoleColor({ userPreference: USER_PREFERENCE.ENABLED, readiness: READINESS.BLOCKED }),
    ROLE_COLOR.GREEN,
    '打开就是绿 —— 能不能跑由派单结果反馈',
  )
  assert.equal(
    deriveRoleColor({ userPreference: USER_PREFERENCE.ENABLED, readiness: READINESS.UNKNOWN }),
    ROLE_COLOR.GREEN,
  )
  assert.equal(
    deriveRoleColor({ userPreference: USER_PREFERENCE.UNSET, readiness: READINESS.READY }),
    ROLE_COLOR.GREEN,
  )
  // quota 不参与颜色
  assert.equal(
    deriveRoleColor({ userPreference: USER_PREFERENCE.ENABLED, readiness: READINESS.READY, quota: 'exhausted' }),
    ROLE_COLOR.GREEN,
    'quota 不参与颜色派生',
  )
})

test('deriveRoleView：输出三字段 + 颜色 + 旧 availability，且是无损 JSON', () => {
  const role = roleA({ enabled: true })
  const view = deriveRoleView(role, {
    sources: sourcesFor({ enabled: 'global' }),
    isProviderAvailable: () => true,
  })
  assert.deepEqual(view, {
    roleId: 'role-a',
    name: 'A',
    userPreference: USER_PREFERENCE.ENABLED,
    readiness: READINESS.READY,
    readinessReason: READINESS_REASON.AVAILABLE,
    quota: QUOTA.UNKNOWN,
    color: ROLE_COLOR.GREEN,
    availability: 'available',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view, '不得夹带 undefined/函数')

  // 显式禁用：灰 + 旧 availability=disabled
  const disabled = deriveRoleView(roleA({ enabled: false }), {
    availability: 'disabled',
    isProviderAvailable: () => true,
  })
  assert.equal(disabled.userPreference, USER_PREFERENCE.DISABLED)
  assert.equal(disabled.color, ROLE_COLOR.GRAY)
  assert.equal(disabled.availability, 'disabled')

  // V1 裁决（2026-11-12）：quota 不参与颜色 —— 传 exhausted 也只影响诊断字段
  const withQuota = deriveRoleView(roleA(), {
    isProviderAvailable: () => true,
    quota: 'exhausted',
    quotaSource: 'meter',
  })
  assert.equal(withQuota.color, ROLE_COLOR.GREEN, 'quota 不再让角色变黄')
  assert.equal(withQuota.quota, QUOTA.UNKNOWN, 'exhausted 不是合法额度值，回落 unknown')

  // 配置不完整：readiness 仍是 blocked（诊断信息保留），
  // 但**颜色不再因此变灰**（2026-11-16 用户裁决：只有开关决定颜色）。
  const incomplete = deriveRoleView({ roleId: 'role-a', name: 'A' }, { availability: 'available' })
  assert.equal(incomplete.readiness, READINESS.BLOCKED, '诊断仍如实报 blocked')
  assert.equal(
    incomplete.color,
    ROLE_COLOR.GREEN,
    '颜色只看开关；配置不完整由派单结果反馈，不用灰点暗示',
  )
  assert.equal(incomplete.availability, 'unknown', 'blocked 不能借旧 availability 变成 available')
})

test('sources：规范化后的 enabled 默认值不得被当成显式偏好', () => {
  const raw = { roles: [roleA()] }
  const cfg = normalizeConfig(raw)
  assert.equal(cfg.roles[0].enabled, true, 'schema 默认值确实会被填成 true')

  // 只看规范化结果 -> 会误标成 global（说明为什么生产必须传 globalRaw）
  const withoutRaw = resolveEffectiveConfig({ global: cfg })
  assert.equal(fieldSource(withoutRaw.sources, 'role-a', 'enabled'), 'global')

  // 传原始配置 -> 正确标成 default
  const withRaw = resolveEffectiveConfig({ global: cfg, globalRaw: raw })
  assert.equal(fieldSource(withRaw.sources, 'role-a', 'enabled'), 'default')
  const view = deriveRoleView(withRaw.effective.roles[0], { sources: withRaw.sources })
  assert.equal(view.userPreference, USER_PREFERENCE.UNSET)
})



test('GUI 数据层：list 快照带三字段与颜色，旧 availability 保留', () => {
  const raw = { roles: [roleA()] }
  const cfg = normalizeConfig(raw)
  const resolved = resolveEffectiveConfig({ global: cfg, globalRaw: raw })
  const registry = createRegistry({ globalRoles: resolved.effective.roles })
  const gui = createGuiState({
    ctx: { subagents: { getProvider: () => ({}) } },
    registry,
    channels: [],
    sources: resolved.sources,
  })

  const view = gui.snapshot().roles[0]
  assert.equal(view.userPreference, USER_PREFERENCE.UNSET, '默认 enabled 不得显示成用户偏好')
  assert.equal(view.readiness, READINESS.READY)
  assert.equal(view.quota, QUOTA.UNKNOWN)
  assert.equal(view.color, ROLE_COLOR.GREEN)
  assert.equal(view.availability, 'available', '旧字段保持原值域，派单/路由不受影响')
  assert.equal(typeof view.readinessReason, 'string')
  // 快照必须能无损 JSON 往返（Remote 返回值约定）
  assert.deepEqual(JSON.parse(JSON.stringify(gui.snapshot())), gui.snapshot())
})

test('旧配置零迁移：不要求新增字段、不写回、不改入参', () => {
  const legacy = {
    roles: [
      {
        roleId: 'role-legacy',
        name: '旧角色',
        channel: { kind: 'acp-cli', provider: 'acp' },
      },
    ],
  }
  const before = JSON.stringify(legacy)
  const resolved = resolveEffectiveConfig({ global: legacy })
  const role = resolved.effective.roles[0]

  assert.equal(Object.hasOwn(role, 'userPreference'), false, '生效角色不注入新字段')
  assert.equal(Object.hasOwn(role, 'readiness'), false)
  assert.equal(Object.hasOwn(role, 'quota'), false)

  const view = deriveRoleView(role, { sources: resolved.sources, availability: 'available' })
  assert.equal(view.userPreference, USER_PREFERENCE.UNSET)
  assert.equal(view.readiness, READINESS.READY)
  assert.equal(view.quota, QUOTA.UNKNOWN)
  assert.equal(view.availability, 'available')
  assert.equal(JSON.stringify(legacy), before, '解析/派生不得修改旧配置')
})

// ─── B2：CLI → 模型 → 思考强度 能力矩阵与解析（PDF 第 2 条） ──────────────────

import {
  buildCliCapabilities,
  effortOptionsFor,
  modelOptionsFor,
  resolveRoleChannel,
  RESOLVE_ERRORS,
} from '../src/roles/capabilities.js'

const CHANNELS = [
  { channelId: 'ch-codex', kind: 'codex', provider: 'codex', model: 'sol-1', reasoning: 'high' },
  { channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'flash-1', reasoning: 'low' },
  { channelId: 'ch-acp-2', kind: 'acp-cli', provider: 'acp', model: 'flash-1', reasoning: 'high' },
]

test('B2 能力矩阵：模型/强度只来自已配置组合，未声明强度标不支持', () => {
  const caps = buildCliCapabilities(CHANNELS)
  const codex = caps.find((row) => row.cli === 'codex')
  assert.deepEqual(codex.models.map((item) => item.model), ['sol-1'])
  assert.deepEqual(codex.efforts, ['high'])
  assert.equal(codex.reasoningSupported, true)

  const acp = caps.find((row) => row.cli === 'acp-cli')
  assert.deepEqual(modelOptionsFor('acp-cli', CHANNELS), ['flash-1'])
  assert.deepEqual(effortOptionsFor('acp-cli', 'flash-1', CHANNELS).efforts.sort(), ['high', 'low'])
  assert.deepEqual(modelOptionsFor('unknown-cli', CHANNELS), [])
  assert.deepEqual(effortOptionsFor('acp-cli', 'm-missing', CHANNELS), { efforts: [], supported: false })

  const noEffort = buildCliCapabilities([{ channelId: 'ch-x', kind: 'in-process', provider: 'spawn' }])
  assert.equal(noEffort[0].reasoningSupported, false, '实例没声明强度 → 不支持（不伪造）')
})

test('B2 解析：CLI+模型+强度 → 唯一执行组合；不支持/歧义都明确报错', () => {
  const resolved = resolveRoleChannel(
    { channel: { kind: 'codex', model: 'sol-1', reasoning: 'high' } },
    CHANNELS,
  )
  assert.equal(resolved.error, null)
  assert.equal(resolved.channel.channelId, 'ch-codex')
  assert.equal(resolved.channel.provider, 'codex')

  // 只给 CLI：同 CLI 有多个组合但模型/强度不同 → 按声明逐层收窄
  const onlyCli = resolveRoleChannel({ channel: { kind: 'acp-cli' } }, CHANNELS)
  assert.equal(onlyCli.error.code, RESOLVE_ERRORS.CHANNEL_AMBIGUOUS)

  const unsupportedEffort = resolveRoleChannel(
    { channel: { kind: 'acp-cli', model: 'flash-1', reasoning: 'max' } },
    CHANNELS,
  )
  assert.equal(unsupportedEffort.error.code, RESOLVE_ERRORS.REASONING_UNSUPPORTED)

  const unsupportedModel = resolveRoleChannel(
    { channel: { kind: 'acp-cli', model: 'gpt-x' } },
    CHANNELS,
  )
  assert.equal(unsupportedModel.error.code, RESOLVE_ERRORS.MODEL_UNSUPPORTED)

  const noCli = resolveRoleChannel({ channel: {} }, CHANNELS)
  assert.equal(noCli.error.code, RESOLVE_ERRORS.CHANNEL_NOT_CONFIGURED)
})
