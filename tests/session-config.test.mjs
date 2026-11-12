// @ts-check
/**
 * 会话级配置（global → project → session）的单元测试。
 *
 * 覆盖：三层合并、字段来源、差异写盘、恢复继承、未知字段拒绝、
 * session 隔离、坏 JSON 容错、路径穿越防护、真实文件落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SESSION_CONFIG_ERRORS,
  deepEqual,
  diffRoleOverride,
  normalizeSessionConfig,
  resolveEffectiveConfig,
} from '../src/session/config.js'
import {
  SESSIONS_RELATIVE_DIR,
  createSessionOverrideStore,
  isValidSessionId,
  sessionConfigPath,
} from '../src/session/store.js'
import { createRegistry } from '../src/roles/registry.js'

const ROOT = 'D:/proj'

/** 内存文件系统 + 可注入 deps。 */
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

/** 一份典型的三层配置。 */
function layers() {
  const global = {
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: ['SS'],
        description: '骨干',
        prompt: '全局规则',
        channel: {
          kind: 'acp-cli',
          channelId: 'ch-acp',
          provider: 'acp',
          model: 'm-global',
          reasoning: 'medium',
        },
      },
      { roleId: 'role-wukong', name: '悟空', channel: { kind: 'codex', model: 'gpt-sol' } },
    ],
    channels: [{ channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'm-global' }],
    defaultRoleId: 'role-sashi',
    dispatchNotes: '全局调度',
  }
  const project = {
    version: 1,
    roles: [{ roleId: 'role-scout', name: '斥候', channel: { kind: 'in-process' } }],
    roleOverrides: { 'role-sashi': { description: '项目描述', channel: { model: 'm-project' } } },
    dispatchNotes: '项目调度',
    projectRules: ['项目规则'],
  }
  const session = {
    version: 1,
    roleOverrides: {
      'role-sashi': {
        alias: ['SSS'],
        prompt: '会话规则',
        channel: { model: 'm-session', reasoning: 'high' },
      },
      'role-scout': { enabled: false },
    },
    defaultRoleId: 'role-wukong',
    dispatchNotes: '会话调度',
    projectRules: ['会话规则'],
  }
  return { global, project, session }
}

/** @param {any[]} errors */
const codes = (errors) => errors.map((error) => error.code)

test('三层合并：session > project > global，且字段来源逐项标注', () => {
  const { global, project, session } = layers()
  const { effective, sources, errors } = resolveEffectiveConfig({ global, project, session })
  assert.deepEqual(errors, [])

  const sashi = effective.roles.find((role) => role.roleId === 'role-sashi')
  assert.equal(sashi.channel.model, 'm-session', 'session 覆盖项目与全局')
  assert.equal(sashi.channel.reasoning, 'high')
  // B2：description/prompt 合并为单一 setting；session 的 prompt 迁移为 setting 后覆盖项目 description
  assert.equal(sashi.setting, '会话规则')
  assert.deepEqual(sashi.aliases, ['SSS'], 'aliases 整体替换，不是追加')
  assert.equal(sashi.source, 'session')

  assert.deepEqual(sources.roles['role-sashi'].fields, {
    name: 'global',
    aliases: 'session',
    setting: 'session',
    enabled: 'default',
    fallbackRoleId: 'default',
    timeoutMs: 'default',
    'channel.kind': 'global',
    'channel.channelId': 'global',
    'channel.provider': 'global',
    'channel.model': 'session',
    'channel.reasoning': 'session',
  })

  const scout = effective.roles.find((role) => role.roleId === 'role-scout')
  assert.equal(scout.source, 'session', '项目新增角色被会话改过 → 整体标 session')
  assert.equal(scout.enabled, false)
  assert.equal(sources.roles['role-scout'].fields.name, 'project')
  assert.equal(sources.roles['role-scout'].fields.enabled, 'session')

  assert.equal(effective.defaultRoleId, 'role-wukong')
  assert.equal(sources.defaultRoleId, 'session')
  assert.equal(effective.dispatchNotes, '会话调度')
  assert.deepEqual(effective.projectRules, ['项目规则', '会话规则'])
  assert.deepEqual(sources.projectRules, ['project', 'session'])
  assert.equal(effective.channels.length, 1)
})

test('生效角色表交给注册表：source 保留 session，可正常解析', () => {
  const { global, project, session } = layers()
  const { effective } = resolveEffectiveConfig({ global, project, session })
  const registry = createRegistry({ globalRoles: effective.roles })
  const sashi = registry.get('role-sashi')
  assert.equal(sashi?.source, 'session')
  assert.equal(sashi?.channel.model, 'm-session')
  assert.equal(registry.resolve('SSS')?.roleId, 'role-sashi')
  assert.equal(registry.resolve('SS'), null, '旧别名已被会话覆盖掉')
})

test('深合并：session 只改 channel.reasoning，不动 model/kind/provider', () => {
  const global = {
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        channel: { kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' },
      },
    ],
  }
  const project = { version: 1, roleOverrides: { 'role-sashi': { channel: { model: 'm2' } } } }
  const session = { version: 1, roleOverrides: { 'role-sashi': { channel: { reasoning: 'high' } } } }
  const { effective } = resolveEffectiveConfig({ global, project, session })
  const sashi = effective.roles[0]
  assert.deepEqual(sashi.channel, {
    kind: 'acp-cli',
    provider: 'acp',
    model: 'm2',
    reasoning: 'high',
  })
})

test('会话内新增角色只影响该会话', () => {
  const global = { roles: [{ roleId: 'role-sashi', name: '沙僧', channel: { kind: 'in-process' } }] }
  const sessionA = {
    version: 1,
    roles: [{ roleId: 'role-temp', name: '临时', channel: { kind: 'in-process' } }],
  }
  const a = resolveEffectiveConfig({ global, session: sessionA })
  const b = resolveEffectiveConfig({ global, session: undefined })

  assert.ok(a.effective.roles.some((role) => role.roleId === 'role-temp'))
  assert.equal(a.sources.roles['role-temp'].layer, 'session')
  assert.equal(a.sources.roles['role-temp'].fields.name, 'session')
  assert.ok(!b.effective.roles.some((role) => role.roleId === 'role-temp'))
})

test('未知字段拒绝：顶层、角色、channel 三层都报错且不生效', () => {
  const global = {
    roles: [{ roleId: 'role-sashi', name: '沙僧', channel: { kind: 'in-process', model: 'm1' } }],
  }
  const session = {
    version: 1,
    permissionPreset: 'readonly',
    roleOverrides: {
      'role-sashi': { foo: 1, channel: { bar: 'x', model: 'm2' } },
    },
  }
  const normalized = normalizeSessionConfig(session)
  assert.ok(codes(normalized.errors).every((code) => code === SESSION_CONFIG_ERRORS.UNKNOWN_FIELD))
  assert.equal(normalized.errors.length, 3, '顶层 permissionPreset + foo + channel.bar')
  assert.deepEqual(normalized.config.roleOverrides['role-sashi'], { channel: { model: 'm2' } })

  const { effective, errors } = resolveEffectiveConfig({ global, session })
  assert.equal(effective.roles[0].channel.model, 'm2', '已知字段照常生效')
  assert.equal(errors.length, 3)
  assert.ok(errors.every((error) => error.code === SESSION_CONFIG_ERRORS.UNKNOWN_FIELD))
})

test('类型错误的字段被拒绝，不污染生效配置', () => {
  const global = { roles: [{ roleId: 'role-sashi', name: '沙僧', channel: { kind: 'in-process' } }] }
  const session = {
    version: 1,
    roleOverrides: {
      'role-sashi': { enabled: 'yes', timeoutMs: -1, name: '' },
    },
  }
  const { effective, errors } = resolveEffectiveConfig({ global, session })
  assert.equal(codes(errors).filter((code) => code === SESSION_CONFIG_ERRORS.BAD_FIELD).length, 3)
  assert.equal(effective.roles[0].enabled, true)
  assert.equal(effective.roles[0].name, '沙僧')
  assert.equal(effective.roles[0].timeoutMs, 1_800_000)
})

test('roleOverrides 指向不存在的角色 → UNKNOWN_ROLE_ID', () => {
  const global = { roles: [{ roleId: 'role-sashi', name: '沙僧' }] }
  const session = { version: 1, roleOverrides: { 'role-ghost': { description: 'x' } } }
  const { errors, effective } = resolveEffectiveConfig({ global, session })
  assert.deepEqual(codes(errors), ['UNKNOWN_ROLE_ID'])
  assert.equal(effective.roles.length, 1)
})

test('差异写盘：等于继承值的字段不写；改成继承值会删除旧覆盖', async () => {
  const fs = memoryFs()
  const store = createSessionOverrideStore(fs.deps)
  const inherited = {
    roleId: 'role-sashi',
    name: '沙僧',
    aliases: ['SS'],
    setting: '规则',
    channel: { kind: 'acp-cli', model: 'm1' },
    enabled: true,
    fallbackRoleId: null,
    timeoutMs: 1_800_000,
  }

  // 只写真正不同的字段
  let result = await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    inherited,
    patch: { setting: '规则', channel: { model: 'm2' } },
  })
  assert.equal(result.written, true)
  assert.deepEqual(result.patch, { channel: { model: 'm2' } }, 'setting 与继承值相同，不落盘')
  const text = /** @type {string} */ (fs.files.get(join(ROOT, SESSIONS_RELATIVE_DIR, 'sess-a.json')))
  assert.ok(text.includes('"model": "m2"'))
  assert.ok(!text.includes('规则'), '没有把继承值抄进文件')

  // 改成继承值 = 恢复继承，删除旧覆盖
  result = await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    inherited,
    patch: { channel: { model: 'm1' } },
  })
  assert.equal(result.written, true)
  assert.deepEqual(result.config.roleOverrides, {}, '恢复继承后角色条目消失')

  // 多字段 + 逐个恢复
  await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    inherited,
    patch: { setting: '会话描述', channel: { model: 'm3', reasoning: 'high' } },
  })
  result = await store.clearOverride(ROOT, 'sess-a', { roleId: 'role-sashi', field: 'setting' })
  assert.deepEqual(result.config.roleOverrides['role-sashi'], {
    channel: { model: 'm3', reasoning: 'high' },
  })
  result = await store.clearOverride(ROOT, 'sess-a', { roleId: 'role-sashi', field: 'model' })
  assert.deepEqual(result.config.roleOverrides['role-sashi'], { channel: { reasoning: 'high' } })
  result = await store.clearOverride(ROOT, 'sess-a', { roleId: 'role-sashi' })
  assert.deepEqual(result.config.roleOverrides, {}, '整角色恢复继承')
})

test('session 隔离：两个 sessionId 各写各的文件，互不影响', async () => {
  const fs = memoryFs()
  const store = createSessionOverrideStore(fs.deps)
  const inherited = {
    roleId: 'role-sashi',
    name: '沙僧',
    channel: { kind: 'acp-cli', model: 'm1' },
  }

  await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    inherited,
    patch: { channel: { model: 'm-a' } },
  })
  await store.setOverride(ROOT, 'sess-b', {
    roleId: 'role-sashi',
    inherited,
    patch: { channel: { model: 'm-b' } },
  })

  assert.equal(store.get(ROOT, 'sess-a').config.roleOverrides['role-sashi'].channel.model, 'm-a')
  assert.equal(store.get(ROOT, 'sess-b').config.roleOverrides['role-sashi'].channel.model, 'm-b')
  assert.notEqual(
    sessionConfigPath(ROOT, 'sess-a'),
    sessionConfigPath(ROOT, 'sess-b'),
    '文件路径必须按 sessionId 分开',
  )

  const global = { roles: [inherited] }
  const a = resolveEffectiveConfig({
    global,
    session: store.get(ROOT, 'sess-a').config,
  })
  const b = resolveEffectiveConfig({
    global,
    session: store.get(ROOT, 'sess-b').config,
  })
  assert.equal(a.effective.roles[0].channel.model, 'm-a')
  assert.equal(b.effective.roles[0].channel.model, 'm-b')
})

test('坏 JSON / 未知版本：读不抛异常，写拒绝覆盖', async () => {
  const path = join(ROOT, SESSIONS_RELATIVE_DIR, 'sess-a.json')
  const store = createSessionOverrideStore(memoryFs({ [path]: '{ "version": 1, ' }).deps)

  const loaded = store.get(ROOT, 'sess-a')
  assert.deepEqual(codes(loaded.errors), [SESSION_CONFIG_ERRORS.INVALID_JSON])
  assert.equal(loaded.corrupt, true)
  assert.deepEqual(loaded.config.roleOverrides, {})

  const result = await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    patch: { description: 'x' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.written, false)
  assert.ok(codes(result.errors).includes(SESSION_CONFIG_ERRORS.CORRUPT))

  const fs2 = memoryFs({ [path]: JSON.stringify({ version: 99 }) })
  const store2 = createSessionOverrideStore(fs2.deps)
  const loaded2 = store2.get(ROOT, 'sess-a')
  assert.deepEqual(codes(loaded2.errors), [SESSION_CONFIG_ERRORS.UNSUPPORTED_VERSION])
  assert.equal(loaded2.corrupt, true)
})

test('不合法 sessionId / 缺项目根：拒绝读写，且不触碰文件', () => {
  const fs = memoryFs()
  const store = createSessionOverrideStore(fs.deps)

  assert.equal(isValidSessionId('../evil'), false)
  assert.equal(isValidSessionId('a/b'), false)
  assert.equal(sessionConfigPath(ROOT, '../evil'), null)

  const badId = store.get(ROOT, '../evil')
  assert.deepEqual(codes(badId.errors), [SESSION_CONFIG_ERRORS.INVALID_SESSION_ID])
  assert.equal(badId.path, null)

  const noRoot = store.get('', 'sess-a')
  assert.deepEqual(codes(noRoot.errors), [SESSION_CONFIG_ERRORS.PROJECT_ROOT_UNKNOWN])
  assert.equal(fs.writes.length, 0)
})

test('已有文件里的未知字段不阻断写入（非致命告警，写入时清掉）', async () => {
  const path = join(ROOT, SESSIONS_RELATIVE_DIR, 'sess-a.json')
  const fs = memoryFs({
    [path]: JSON.stringify({ version: 1, permissionPreset: 'readonly', roleOverrides: {} }),
  })
  const store = createSessionOverrideStore(fs.deps)
  const loaded = store.get(ROOT, 'sess-a')
  assert.deepEqual(codes(loaded.errors), [SESSION_CONFIG_ERRORS.UNKNOWN_FIELD])
  assert.equal(loaded.corrupt, false)

  const result = await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    patch: { description: 'x' },
  })
  assert.equal(result.written, true)
  assert.equal(result.ok, true)
  assert.deepEqual(codes(result.warnings ?? []), [SESSION_CONFIG_ERRORS.UNKNOWN_FIELD])
  assert.ok(!JSON.stringify(result.config).includes('permissionPreset'), '写入时清掉被拒字段')
})

test('setOverride 拒绝未知字段，且不写盘', async () => {
  const fs = memoryFs()
  const store = createSessionOverrideStore(fs.deps)
  const result = await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    patch: { bogus: 1 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.written, false)
  assert.deepEqual(codes(result.errors), [SESSION_CONFIG_ERRORS.UNKNOWN_FIELD])
  assert.equal(fs.writes.length, 0)
})

test('clearOverride 未知字段 → INVALID_FIELD，不写盘', async () => {
  const fs = memoryFs()
  const store = createSessionOverrideStore(fs.deps)
  await store.setOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    patch: { description: 'x' },
  })
  const before = fs.writes.length
  const result = await store.clearOverride(ROOT, 'sess-a', {
    roleId: 'role-sashi',
    field: 'bogus',
  })
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result.errors), [SESSION_CONFIG_ERRORS.INVALID_FIELD])
  assert.equal(fs.writes.length, before)
})

test('真实磁盘：写入 .meetingstone/sessions/<sessionId>.json 并可读回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-session-'))
  try {
    const store = createSessionOverrideStore()
    await store.setOverride(root, 'sess-real', {
      roleId: 'role-sashi',
      patch: { channel: { model: 'm-real' } },
    })
    const path = /** @type {string} */ (sessionConfigPath(root, 'sess-real'))
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(parsed.roleOverrides['role-sashi'].channel.model, 'm-real')

    const loaded = store.get(root, 'sess-real')
    assert.equal(loaded.exists, true)
    assert.deepEqual(loaded.errors, [])
    assert.equal(loaded.config.roleOverrides['role-sashi'].channel.model, 'm-real')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('deepEqual / diff 辅助函数：数组与嵌套对象按值比较', () => {
  assert.equal(deepEqual(['a', 'b'], ['a', 'b']), true)
  assert.equal(deepEqual(['a', 'b'], ['a']), false)
  assert.equal(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }), true)
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)

  const inherited = {
    aliases: ['SS'],
    setting: 'd',
    channel: { kind: 'acp-cli', model: 'm1' },
  }
  const result = diffRoleOverride(inherited, {
    aliases: ['SS'],
    setting: 'd2',
    channel: { model: 'm1' },
  })
  assert.deepEqual(result.patch, { setting: 'd2' })
  assert.deepEqual(result.restored, ['aliases', 'channel.model'])
})
