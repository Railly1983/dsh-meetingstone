// @ts-check
/**
 * 右侧栏「当前会话角色编辑」的 Host 远程方法（纯逻辑）单元测试。
 *
 * 覆盖：get/set/clear 的继承语义、只写差异、恢复继承、session 隔离、
 * 白名单校验（sessionId/roleId/field）与明确错误码。
 *
 * 这是 stub harness 之外、可直接在 Node 跑的真相测试：不依赖宿主 Typert 协议，
 * 直接验证 src/gui/session.js 的纯逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { createSessionGuiApi, SESSION_GUI_ERRORS } from '../src/gui/session.js'
import { createSessionRootResolver } from '../src/gui/session-root.js'
import { createSessionOverrideStore } from '../src/session/store.js'
import { createProjectConfigStore } from '../src/project/load.js'
import { normalizeConfig } from '../src/config.js'

const ROOT = 'D:/proj'

/** 内存 session 存储。 */
function memorySessionFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    deps: {
      readText: (path) => {
        if (!files.has(path)) {
          const e = /** @type {any} */ (new Error('ENOENT'))
          e.code = 'ENOENT'
          throw e
        }
        return /** @type {string} */ (files.get(path))
      },
      writeText: async (path, text) => {
        files.set(path, text)
      },
      renameFile: async (from, to) => {
        const t = files.get(from)
        files.delete(from)
        files.set(to, t)
      },
      removeFile: async (path) => {
        files.delete(path)
      },
      ensureDir: async () => {},
      now: () => 1_700_000_000_000,
    },
  }
}

/** 内存项目配置存储（只读）。用 join 拼路径，避免 Windows 分隔符不一致。 */
function memoryProjectStore(root, cfgText) {
  const path = join(root, '.meetingstone.json')
  return createProjectConfigStore({
    readFile: (p) => {
      if (p !== path) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return cfgText
    },
    statFile: (p) =>
      p === path
        ? { mtimeMs: 1, size: cfgText.length }
        : (() => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          })(),
    now: () => 1_700_000_000_000,
    ttlMs: 10_000,
  })
}

const GLOBAL_ROLES = [
  {
    roleId: 'role-sashi',
    name: '沙僧',
    aliases: ['SS'],
    description: '骨干',
    channel: { kind: 'acp-cli', provider: 'acp', model: 'm-global', reasoning: 'medium' },
  },
]

function makeApi({ sessionFs = memorySessionFs(), projectConfig = null } = {}) {
  const cfg = { roles: GLOBAL_ROLES, projectConfigFile: '.meetingstone.json' }
  const projectStore = projectConfig
    ? memoryProjectStore(ROOT, JSON.stringify(projectConfig))
    : { get: () => ({ config: {}, errors: [] }) }
  const sessionStore = createSessionOverrideStore(sessionFs.deps)
  const api = createSessionGuiApi({
    cfg,
    projectStore,
    sessionStore,
    resolveProjectRoot: () => ROOT,
  })
  return { api, sessionStore, sessionFs }
}

test('getSessionConfig：返回 生效角色表 + 覆盖 + 字段级来源', () => {
  const { api } = makeApi()
  const view = api.getSessionConfig('sess-1')
  assert.equal(view.effective.roles.length, 1)
  assert.deepEqual(view.overrides, {})
  assert.equal(view.sources.roles['role-sashi'].layer, 'global')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.model'], 'global')
})

test('getSessionConfig：globalRaw 让默认 enabled 保持 default，不误标 global', () => {
  const raw = { roles: GLOBAL_ROLES }
  const cfg = normalizeConfig(raw)
  const api = createSessionGuiApi({
    cfg,
    globalRaw: raw,
    projectStore: { get: () => ({ config: {}, errors: [] }) },
    sessionStore: createSessionOverrideStore(memorySessionFs().deps),
    resolveProjectRoot: () => ROOT,
  })
  const view = api.getSessionConfig('sess-1')
  assert.equal(view.sources.roles['role-sashi'].fields.enabled, 'default')
})

test('setSessionOverride：只写差异，继承层不变；来源标 session', async () => {
  const { api } = makeApi()
  const result = await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  assert.equal(result.written, true)
  assert.deepEqual(result.patch, { channel: { model: 'm-session' } }, '只写真正不同的字段')

  const view = api.getSessionConfig('sess-1')
  assert.equal(view.effective.roles[0].channel.model, 'm-session')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.model'], 'session', '来源切到 session')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.provider'], 'global', '未改字段仍继承')
  // 覆盖只存差异
  assert.deepEqual(view.overrides['role-sashi'], { channel: { model: 'm-session' } })
})

test('setSessionOverride：等于继承值 → 恢复继承（不落盘该字段）', async () => {
  const { api } = makeApi()
  await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  // 改回全局值 = 恢复继承
  const result = await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-global')
  assert.ok(!('role-sashi' in result.config.roleOverrides), '恢复继承后角色条目消失')
  const view = api.getSessionConfig('sess-1')
  assert.equal(view.effective.roles[0].channel.model, 'm-global')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.model'], 'global')
})

test('setSessionOverride：别名/描述/提供商/思考强度 各自的字段白名单', async () => {
  const { api } = makeApi()
  await api.setSessionOverride('sess-1', 'role-sashi', 'alias', '新别名')
  await api.setSessionOverride('sess-1', 'role-sashi', 'description', '会话描述')
  await api.setSessionOverride('sess-1', 'role-sashi', 'provider', 'acp-2')
  await api.setSessionOverride('sess-1', 'role-sashi', 'reasoning', 'high')

  const view = api.getSessionConfig('sess-1')
  const r = view.effective.roles[0]
  assert.deepEqual(r.aliases, ['新别名'])
  assert.equal(r.description, '会话描述')
  assert.equal(r.channel.provider, 'acp-2')
  assert.equal(r.channel.reasoning, 'high')
  assert.deepEqual(view.overrides['role-sashi'], {
    aliases: ['新别名'],
    description: '会话描述',
    channel: { provider: 'acp-2', reasoning: 'high' },
  })
})

test('clearSessionOverride：恢复单字段 + 整角色', async () => {
  const { api } = makeApi()
  await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  await api.setSessionOverride('sess-1', 'role-sashi', 'description', '会话描述')

  const cleared = await api.clearSessionOverride('sess-1', 'role-sashi', 'model')
  assert.equal(cleared.config.roleOverrides['role-sashi'].channel?.model, undefined, '该字段已恢复继承')
  assert.equal(cleared.config.roleOverrides['role-sashi'].description, '会话描述')

  const all = await api.clearSessionOverride('sess-1', 'role-sashi')
  assert.ok(!('role-sashi' in all.config.roleOverrides), '整角色恢复继承')
})

test('session 隔离：两个 sessionId 互不影响', async () => {
  const { api } = makeApi()
  await api.setSessionOverride('sess-a', 'role-sashi', 'model', 'm-a')
  await api.setSessionOverride('sess-b', 'role-sashi', 'model', 'm-b')

  assert.equal(api.getSessionConfig('sess-a').effective.roles[0].channel.model, 'm-a')
  assert.equal(api.getSessionConfig('sess-b').effective.roles[0].channel.model, 'm-b')
})

test('白名单校验：坏 sessionId → INVALID_SESSION_ID', () => {
  const { api } = makeApi()
  assert.throws(() => api.setSessionOverride('../evil', 'role-sashi', 'model', 'x'), (e) => e.code === SESSION_GUI_ERRORS.INVALID_SESSION_ID)
  assert.throws(() => api.clearSessionOverride('../evil', 'role-sashi', 'model'), (e) => e.code === SESSION_GUI_ERRORS.INVALID_SESSION_ID)
})

test('白名单校验：坏 roleId → INVALID_ROLE_ID', () => {
  const { api } = makeApi()
  assert.throws(() => api.setSessionOverride('sess-1', 'ghost', 'model', 'x'), (e) => e.code === SESSION_GUI_ERRORS.INVALID_ROLE_ID)
  assert.throws(() => api.clearSessionOverride('sess-1', 'ghost', 'model'), (e) => e.code === SESSION_GUI_ERRORS.INVALID_ROLE_ID)
})

test('白名单校验：坏 field → INVALID_FIELD', () => {
  const { api } = makeApi()
  assert.throws(() => api.setSessionOverride('sess-1', 'role-sashi', 'bogus', 'x'), (e) => e.code === SESSION_GUI_ERRORS.INVALID_FIELD)
  assert.throws(() => api.clearSessionOverride('sess-1', 'role-sashi', 'bogus'), (e) => e.code === SESSION_GUI_ERRORS.INVALID_FIELD)
})

test('project 覆盖被会话覆盖再覆盖，来源正确分层', async () => {
  const { api } = makeApi({
    projectConfig: {
      version: 1,
      roleOverrides: { 'role-sashi': { channel: { model: 'm-project' } } },
    },
  })
  // 未会话覆盖前：来源 project
  let view = api.getSessionConfig('sess-1')
  assert.equal(view.effective.roles[0].channel.model, 'm-project')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.model'], 'project')

  // 会话覆盖：来源 session
  await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  view = api.getSessionConfig('sess-1')
  assert.equal(view.effective.roles[0].channel.model, 'm-session')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.model'], 'session')

  // 恢复：回到 project
  await api.clearSessionOverride('sess-1', 'role-sashi', 'model')
  view = api.getSessionConfig('sess-1')
  assert.equal(view.effective.roles[0].channel.model, 'm-project')
  assert.equal(view.sources.roles['role-sashi'].fields['channel.model'], 'project')
})

test('resolveProjectRoot 返回 null → SESSION_ROOT_UNKNOWN', () => {
  const cfg = { roles: GLOBAL_ROLES, projectConfigFile: '.meetingstone.json' }
  const api = createSessionGuiApi({
    cfg,
    projectStore: { get: () => ({ config: {}, errors: [] }) },
    sessionStore: createSessionOverrideStore(memorySessionFs().deps),
    resolveProjectRoot: () => null,
  })
  assert.throws(() => api.getSessionConfig('sess-x'), (e) => e.code === SESSION_GUI_ERRORS.SESSION_ROOT_UNKNOWN)
  assert.throws(() => api.setSessionOverride('sess-x', 'role-sashi', 'model', 'x'), (e) => e.code === SESSION_GUI_ERRORS.SESSION_ROOT_UNKNOWN)
})

test('setSessionOverride：重复设置同值 → idempotent，不重复落盘', async () => {
  const { api } = makeApi()
  const first = await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  assert.equal(first.written, true)
  assert.equal(first.idempotent, false)
  assert.equal(first.scope, 'field')
  assert.equal(first.code, null)

  const second = await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  assert.equal(second.ok, true)
  assert.equal(second.written, false)
  assert.equal(second.idempotent, true)
  assert.equal(second.code, null)
})

test('clearSessionOverride：field 省略/null 都按整角色恢复，scope=role', async () => {
  const { api } = makeApi()
  await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  await api.setSessionOverride('sess-1', 'role-sashi', 'description', '会话描述')

  const omitted = await api.clearSessionOverride('sess-1', 'role-sashi')
  assert.equal(omitted.scope, 'role')
  assert.equal(omitted.removed, true)
  assert.ok(!('role-sashi' in omitted.config.roleOverrides))

  await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  const nullField = await api.clearSessionOverride('sess-1', 'role-sashi', null)
  assert.equal(nullField.scope, 'role')
  assert.ok(!('role-sashi' in nullField.config.roleOverrides))
})

test('clearSessionOverride：重复恢复 → idempotent（removed=false, written=false）', async () => {
  const { api } = makeApi()
  await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  await api.clearSessionOverride('sess-1', 'role-sashi', 'model')
  const again = await api.clearSessionOverride('sess-1', 'role-sashi', 'model')
  assert.equal(again.ok, true)
  assert.equal(again.written, false)
  assert.equal(again.removed, false)
  assert.equal(again.idempotent, true)
  assert.equal(again.scope, 'field')
})

test('setSessionOverride：非法字段值 → ok:false + 稳定 code，不落盘', async () => {
  const { api, sessionFs } = makeApi()
  const result = await api.setSessionOverride('sess-1', 'role-sashi', 'timeoutMs', -1)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SESSION_CONFIG_BAD_FIELD')
  assert.equal(result.written, false)
  assert.equal(sessionFs.files.size, 0, '没有任何文件被写入')
})

test('setSessionOverride：坏会话文件 → 拒绝覆盖 + CORRUPT 错误码', async () => {
  const path = join(ROOT, '.meetingstone', 'sessions', 'sess-1.json')
  const sessionFs = memorySessionFs({ [path]: '{ not json' })
  const { api } = makeApi({ sessionFs })
  const result = await api.setSessionOverride('sess-1', 'role-sashi', 'model', 'm-session')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SESSION_CONFIG_CORRUPT')
  assert.equal(result.written, false)
  assert.equal(sessionFs.files.get(path), '{ not json', '不覆盖用户手写内容')
})

test('getSessionConfig：坏会话文件时 warnings 如实暴露，不抛异常', () => {
  const path = join(ROOT, '.meetingstone', 'sessions', 'sess-1.json')
  const sessionFs = memorySessionFs({ [path]: '{ not json' })
  const { api } = makeApi({ sessionFs })
  const view = api.getSessionConfig('sess-1')
  assert.ok(Array.isArray(view.warnings))
  assert.equal(view.warnings[0].code, 'SESSION_CONFIG_INVALID_JSON')
})

test('clearSessionOverride：空字符串 field → INVALID_FIELD（不当作省略）', () => {
  const { api } = makeApi()
  assert.throws(
    () => api.clearSessionOverride('sess-1', 'role-sashi', ''),
    (error) => error.code === SESSION_GUI_ERRORS.INVALID_FIELD,
  )
})

test('新会话未派单：官方 ctx.sessions.header.cwd 即可读取，不依赖 sessionRoots', () => {
  const cfg = { roles: GLOBAL_ROLES, projectConfigFile: '.meetingstone.json' }
  const sessionStore = createSessionOverrideStore(memorySessionFs().deps)
  const api = createSessionGuiApi({
    cfg,
    projectStore: { get: () => ({ config: {}, errors: [] }) },
    sessionStore,
    resolveProjectRoot: createSessionRootResolver({
      ctx: {
        reflect: {
          get(name) {
            if (name !== 'sessions') return null
            return {
              get: (id) => (id === 'sess-new' ? { header: { id, cwd: ROOT } } : undefined),
            }
          },
        },
      },
      fallback: () => {
        throw new Error('不应走派单兜底')
      },
    }),
  })

  const view = api.getSessionConfig('sess-new')
  assert.equal(view.effective.roles.length, 1)
  assert.equal(view.sources.roles['role-sashi'].layer, 'global')
})
