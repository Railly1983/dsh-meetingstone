// @ts-check
/**
 * P0-S2：CLI 显式偏好（unset / enabled / disabled）与「preflight 门禁」。
 *
 * 重点证明：
 * - 缺省 = unset；显式关闭持久化（重新规范化后仍保持）
 * - unset + ready 才自动启用；unknown / blocked 不启用
 * - preflight 失败**不写任何配置**（不写 enabled，也不把 unset 写成 disabled）
 * - 运行故障/检查失败不会回写 disabled（启用意图保留）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import {
  CLI_NAMES,
  CLI_PREFERENCE,
  applyCliPreference,
  deriveCliState,
  preferenceOf,
  sanitizeCliPreferences,
} from '../src/cli/preferences.js'
import { CLI_CONFIG_ERRORS, createConfigGuiApi } from '../src/gui/config-api.js'

/** 只记录写入的假全局 writer。 */
function fakeGlobalWriter() {
  const writes = []
  return {
    writes,
    async setCliPreference(cli, preference) {
      writes.push({ cli, preference })
      return { ok: true, written: true, config: { cliPreferences: { [cli]: preference === 'enabled' } } }
    },
    async setRoleEnabled() {
      return { ok: true, written: true }
    },
    async updateRole() {
      return { ok: true, written: true }
    },
  }
}

/** 固定 preflight 结果。 */
function fakePreflight(result, calls = []) {
  return {
    calls,
    async check(cli, opts) {
      calls.push({ cli, opts })
      return {
        cli,
        ready: result.ready,
        blockedReason: result.blockedReason ?? null,
        retryable: result.retryable ?? true,
        manualSteps: result.manualSteps ?? [],
        installed: result.installed ?? true,
        version: result.version ?? '1.0.0',
        path: result.path ?? 'C:/x/cli.exe',
        source: result.source ?? 'path',
        login: result.login ?? 'unknown',
        hostIntegration: result.hostIntegration ?? true,
        notes: [],
        checkedAt: 1_700_000_000_000,
      }
    },
    async checkAll(opts) {
      return CLI_NAMES.map((cli) => this.check(cli, opts))
    },
  }
}

test('缺省 cliPreferences = unset，不把默认值当用户偏好', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg.cliPreferences, {})
  for (const cli of CLI_NAMES) assert.equal(preferenceOf(cfg, cli), CLI_PREFERENCE.UNSET)
})

test('显式关闭持久化：重新规范化（模拟重启）后仍是 disabled', () => {
  const raw = { cliPreferences: { codex: false } }
  const first = normalizeConfig(raw)
  assert.equal(preferenceOf(first, 'codex'), CLI_PREFERENCE.DISABLED)
  const second = normalizeConfig(raw)
  assert.equal(preferenceOf(second, 'codex'), CLI_PREFERENCE.DISABLED)
})

test('显式开启持久化：重新规范化后仍是 enabled', () => {
  const raw = { cliPreferences: { claude: true } }
  assert.equal(preferenceOf(normalizeConfig(raw), 'claude'), CLI_PREFERENCE.ENABLED)
  assert.equal(preferenceOf(normalizeConfig(raw), 'claude'), CLI_PREFERENCE.ENABLED)
})

test('容错清洗：非法值/未知键按 unset 丢弃，但不拖垮角色表', () => {
  const raw = {
    roles: [{ roleId: 'role-a', name: 'A' }],
    cliPreferences: { codex: false, codebuddy: 'yes', claude: 1, unknown: true },
  }
  const cfg = normalizeConfig(raw)
  assert.equal(cfg.roles.length, 1, '角色表保留')
  assert.deepEqual(cfg.cliPreferences, { codex: false })
  assert.equal(preferenceOf(cfg, 'codebuddy'), CLI_PREFERENCE.UNSET)
  assert.equal(preferenceOf(cfg, 'claude'), CLI_PREFERENCE.UNSET)
})

test('sanitizeCliPreferences：非对象输入返回 {}，只接受布尔', () => {
  assert.deepEqual(sanitizeCliPreferences(null), {})
  assert.deepEqual(sanitizeCliPreferences({ codex: 'false', claude: true }), { claude: true })
  assert.equal(sanitizeCliPreferences(undefined), undefined)
})

test('deriveCliState：unset + ready → 自动启用（firstDetection），但不写配置', () => {
  const state = deriveCliState({
    cli: 'codex',
    preference: 'unset',
    preflight: { ready: 'ready' },
  })
  assert.equal(state.userPreference, 'unset')
  assert.equal(state.enabled, true)
  assert.equal(state.firstDetection, true)
})

test('deriveCliState：unset + unknown → 不启用（未知状态不伪造）', () => {
  const state = deriveCliState({
    cli: 'codex',
    preference: 'unset',
    preflight: { ready: 'unknown', blockedReason: 'evidence-missing' },
  })
  assert.equal(state.enabled, false)
  assert.equal(state.ready, 'unknown')
  assert.equal(state.blockedReason, 'evidence-missing')
  assert.equal(state.firstDetection, false)
})

test('deriveCliState：显式关闭优先；运行故障保留启用意图但不生效', () => {
  const disabled = deriveCliState({
    cli: 'codex',
    preference: 'disabled',
    preflight: { ready: 'ready' },
  })
  assert.equal(disabled.userPreference, 'disabled')
  assert.equal(disabled.enabled, false)

  const intent = deriveCliState({
    cli: 'claude',
    preference: 'enabled',
    preflight: { ready: 'blocked', blockedReason: 'login-required' },
  })
  assert.equal(intent.userPreference, 'enabled', '启用意图保留')
  assert.equal(intent.enabled, false, '但当前不生效')
  assert.equal(intent.blockedReason, 'login-required')
})

test('applyCliPreference：不可变、保留未知顶层字段与其他 CLI 偏好', () => {
  const current = {
    roles: [{ roleId: 'role-a', name: 'A' }],
    cliPreferences: { codex: false, future: 'keep' },
    futureField: { nested: true },
  }
  const next = applyCliPreference(current, 'claude', 'enabled')
  assert.equal(next.cliPreferences.claude, true)
  assert.equal(next.cliPreferences.codex, false)
  assert.equal(next.cliPreferences.future, 'keep')
  assert.deepEqual(next.futureField, { nested: true })
  assert.deepEqual(next.roles, current.roles)
  assert.deepEqual(current.cliPreferences, { codex: false, future: 'keep' }, '入参不被修改')

  const unset = applyCliPreference(next, 'claude', 'unset')
  assert.equal(Object.hasOwn(unset.cliPreferences, 'claude'), false)
  assert.equal(unset.cliPreferences.codex, false)
})

test('applyCliPreference：最后一个偏好被清空时删除 cliPreferences（不留空壳）', () => {
  const next = applyCliPreference({ cliPreferences: { codex: true } }, 'codex', 'unset')
  assert.equal(Object.hasOwn(next, 'cliPreferences'), false)
})

test('setCliEnabled(true)：preflight 未通过 → 不写任何配置，保持关闭', async () => {
  const writer = fakeGlobalWriter()
  const preflight = fakePreflight({
    ready: 'blocked',
    blockedReason: 'login-required',
    manualSteps: ['完成登录后重检'],
    retryable: true,
  })
  const api = createConfigGuiApi({ cfg: normalizeConfig({}), globalWriter: writer, preflight })
  const result = await api.setCliEnabled('claude', true)
  assert.equal(result.ok, false)
  assert.equal(result.code, CLI_CONFIG_ERRORS.PREFLIGHT_FAILED)
  assert.equal(result.preference, 'unset', '失败不改写偏好（不把 unset 变成 disabled）')
  assert.equal(result.enabled, false)
  assert.deepEqual(result.manualSteps, ['完成登录后重检'])
  assert.equal(result.retryable, true)
  assert.equal(result.autoFix, false)
  assert.equal(writer.writes.length, 0, 'preflight 失败绝不写 enabled')
})

test('setCliEnabled(true)：preflight 通过 → 写 enabled', async () => {
  const writer = fakeGlobalWriter()
  const preflight = fakePreflight({ ready: 'ready' })
  const api = createConfigGuiApi({ cfg: normalizeConfig({}), globalWriter: writer, preflight })
  const result = await api.setCliEnabled('codex', true)
  assert.equal(result.ok, true)
  assert.equal(result.enabled, true)
  assert.equal(result.preference, 'enabled')
  assert.deepEqual(writer.writes, [{ cli: 'codex', preference: 'enabled' }])
})

test('setCliEnabled(false)：直接写 disabled，不跑 preflight', async () => {
  const writer = fakeGlobalWriter()
  const preflight = fakePreflight({ ready: 'ready' })
  const api = createConfigGuiApi({ cfg: normalizeConfig({}), globalWriter: writer, preflight })
  const result = await api.setCliEnabled('codex', false)
  assert.equal(result.ok, true)
  assert.equal(result.preference, 'disabled')
  assert.deepEqual(writer.writes, [{ cli: 'codex', preference: 'disabled' }])
  assert.equal(preflight.calls.length, 0)
})

test('幂等：已关闭再关闭 / 已开启再开启都不重复写', async () => {
  const writer = fakeGlobalWriter()
  const preflight = fakePreflight({ ready: 'ready' })
  const cfg = normalizeConfig({ cliPreferences: { codex: false, claude: true } })
  const api = createConfigGuiApi({ cfg, globalWriter: writer, preflight })

  const disabled = await api.setCliEnabled('codex', false)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.idempotent, true)
  assert.equal(writer.writes.length, 0)

  const enabled = await api.setCliEnabled('claude', true)
  assert.equal(enabled.ok, true)
  assert.equal(enabled.idempotent, true)
  assert.equal(writer.writes.length, 0)
  assert.equal(preflight.calls.length, 0, '幂等开启不需要重复 preflight')
})

test('写入失败 → 不声称 enabled，返回稳定错误码', async () => {
  const writer = {
    writes: [],
    async setCliPreference(cli, preference) {
      this.writes.push({ cli, preference })
      return { ok: false, code: 'GLOBAL_CONFIG_OVERRIDDEN', message: '被 home patch 覆盖' }
    },
  }
  const api = createConfigGuiApi({
    cfg: normalizeConfig({}),
    globalWriter: writer,
    preflight: fakePreflight({ ready: 'ready' }),
  })
  const result = await api.setCliEnabled('codex', true)
  assert.equal(result.ok, false)
  assert.equal(result.code, CLI_CONFIG_ERRORS.WRITE_FAILED)
  assert.equal(result.cause, 'GLOBAL_CONFIG_OVERRIDDEN')
  assert.equal(Object.hasOwn(result, 'enabled'), false, '失败不得声称 enabled')
})

test('setCliEnabled：非法 CLI / 非布尔值 → 明确错误码，不写', async () => {
  const writer = fakeGlobalWriter()
  const api = createConfigGuiApi({
    cfg: normalizeConfig({}),
    globalWriter: writer,
    preflight: fakePreflight({ ready: 'ready' }),
  })
  const badCli = await api.setCliEnabled('kimi', true)
  assert.equal(badCli.code, CLI_CONFIG_ERRORS.INVALID_CLI)
  const badValue = await api.setCliEnabled('codex', 'yes')
  assert.equal(badValue.code, CLI_CONFIG_ERRORS.INVALID_STATE)
  assert.equal(writer.writes.length, 0)
})

test('listCliStates：preflight 失败只派生状态，绝不写配置', async () => {
  const writer = fakeGlobalWriter()
  const preflight = fakePreflight({ ready: 'blocked', blockedReason: 'not-installed', retryable: true })
  const api = createConfigGuiApi({ cfg: normalizeConfig({}), globalWriter: writer, preflight })
  const states = await api.listCliStates()
  assert.equal(states.every((state) => state.enabled === false), true)
  assert.equal(states.every((state) => state.userPreference === 'unset'), true)
  assert.equal(writer.writes.length, 0)
})

test('setCliEnabled(true)：preflight 抛错也保持关闭、不写配置', async () => {
  const writer = fakeGlobalWriter()
  const preflight = {
    calls: [],
    async check() {
      throw new Error('probe crashed')
    },
    async checkAll() {
      throw new Error('probe crashed')
    },
  }
  const api = createConfigGuiApi({ cfg: normalizeConfig({}), globalWriter: writer, preflight })
  const result = await api.setCliEnabled('codex', true)
  assert.equal(result.ok, false)
  assert.equal(result.code, CLI_CONFIG_ERRORS.PREFLIGHT_FAILED)
  assert.equal(result.enabled, false)
  assert.equal(result.retryable, true)
  assert.equal(writer.writes.length, 0)
})

test('listCliStates：合并显式偏好与 preflight；unset+ready 自动启用', async () => {
  const preflight = fakePreflight({ ready: 'ready' })
  const cfg = normalizeConfig({ cliPreferences: { claude: false } })
  const api = createConfigGuiApi({ cfg, globalWriter: fakeGlobalWriter(), preflight })
  const states = await api.listCliStates()
  const byCli = Object.fromEntries(states.map((state) => [state.cli, state]))
  assert.equal(byCli.codex.userPreference, 'unset')
  assert.equal(byCli.codex.enabled, true)
  assert.equal(byCli.claude.userPreference, 'disabled')
  assert.equal(byCli.claude.enabled, false)
})
