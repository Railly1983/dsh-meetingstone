// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { win32, posix } from 'node:path'

import {
  createAppxResolver,
  createKnownDirResolver,
  createNpmGlobalResolver,
  createPathResolver,
  runCommand,
} from '../src/cli/resolvers.js'

// 测试里显式指定 pathImpl，保证在 Windows 与 Linux CI 上行为一致。

test('PATH 解析：按 PATH 目录 × 扩展名找到 .cmd', () => {
  const expected = win32.join('C:\\Tools', 'codebuddy.cmd')
  const resolve = createPathResolver({
    exists: (p) => p === expected,
    pathEnv: 'C:\\Empty;C:\\Tools',
    platform: 'win32',
    pathImpl: win32,
  })
  assert.deepEqual(resolve({ bin: 'codebuddy' }), [{ path: expected, source: 'path' }])
})

test('PATH 解析：找不到返回空数组，不报错', () => {
  const resolve = createPathResolver({
    exists: () => false,
    pathEnv: 'C:\\A;C:\\B',
    platform: 'win32',
    pathImpl: win32,
  })
  assert.deepEqual(resolve({ bin: 'codex' }), [])
})

test('PATH 解析：非 Windows 不加扩展名、用 posix 分隔符', () => {
  const expected = '/usr/local/bin/claude'
  const resolve = createPathResolver({
    exists: (p) => p === expected,
    pathEnv: '/usr/local/bin:/bin',
    platform: 'linux',
    pathImpl: posix,
  })
  assert.deepEqual(resolve({ bin: 'claude' }), [{ path: expected, source: 'path' }])
})

test('npm 全局：拼 APPDATA/npm，Windows 下试 .cmd 与 .exe', () => {
  const expected = win32.join('C:\\Users\\u\\AppData\\Roaming', 'npm', 'codebuddy.cmd')
  const resolve = createNpmGlobalResolver({
    exists: (p) => p === expected,
    npmGlobalDir: 'C:\\Users\\u\\AppData\\Roaming',
    platform: 'win32',
    pathImpl: win32,
  })
  assert.deepEqual(resolve({ bin: 'codebuddy' }), [{ path: expected, source: 'npm-global' }])
})

test('npm 全局：没有 APPDATA 时安全返回空', () => {
  const resolve = createNpmGlobalResolver({
    exists: () => true,
    npmGlobalDir: '',
    platform: 'win32',
    pathImpl: win32,
  })
  assert.deepEqual(resolve({ bin: 'codex' }), [])
})

test('Appx：只认 InstallLocation 里存在的相对路径，且按包名规则过滤', async () => {
  const codexPkg = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0'
  const runtimePkg =
    'C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime.v26-1105-1297-0_x64__3k8sg7r9htsxt'
  const expected = win32.join(codexPkg, 'app', 'resources', 'codex.exe')

  const resolve = createAppxResolver({
    platform: 'win32',
    pathImpl: win32,
    run: async () => ({ code: 0, stdout: [codexPkg, runtimePkg].join('\r\n') }),
    exists: (p) => p === expected,
  })

  const found = await resolve({
    appxName: 'OpenAI.Codex',
    appxPattern: /^OpenAI\.Codex_/,
    appxRelative: ['app', 'resources', 'codex.exe'],
  })
  assert.deepEqual(found, [{ path: expected, source: 'appx' }])
})

test('Appx：查询失败 / 无输出 / 非 Windows 都返回空', async () => {
  const failing = createAppxResolver({
    platform: 'win32',
    pathImpl: win32,
    run: async () => ({ code: 1, stdout: '' }),
    exists: () => true,
  })
  assert.deepEqual(await failing({ appxName: 'X', appxRelative: ['a'] }), [])

  const empty = createAppxResolver({
    platform: 'win32',
    pathImpl: win32,
    run: async () => ({ code: 0, stdout: '\r\n' }),
    exists: () => true,
  })
  assert.deepEqual(await empty({ appxName: 'X', appxRelative: ['a'] }), [])

  const linux = createAppxResolver({ platform: 'linux', run: async () => ({ code: 0, stdout: 'x' }) })
  assert.deepEqual(await linux({ appxName: 'X' }), [])
})

test('常见目录：在 LOCALAPPDATA\\Programs 下命中', () => {
  const expected = win32.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'claude', 'claude.exe')
  const resolve = createKnownDirResolver({
    exists: (p) => p === expected,
    env: {
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    },
    pathImpl: win32,
    platform: 'win32',
  })
  const found = resolve({ bin: 'claude' })
  assert.ok(found.some((c) => c.path === expected && c.source === 'known-dir'))
})

test('常见目录：环境变量缺失时不生成空路径候选', () => {
  const resolve = createKnownDirResolver({
    exists: () => true,
    env: {},
    pathImpl: win32,
    platform: 'win32',
  })
  assert.deepEqual(resolve({ bin: 'codex' }), [])
})

test('runCommand：真实执行 node --version 能拿到退出码与输出', async () => {
  const res = await runCommand(process.execPath, ['--version'], { timeoutMs: 15_000 })
  assert.equal(res.code, 0)
  assert.match(res.stdout.trim(), /^v\d+\./)
})

test('runCommand：不存在的可执行文件不抛异常，返回非 0', async () => {
  const res = await runCommand('C:\\definitely-not-exists\\nope.exe', ['--version'], {
    timeoutMs: 5_000,
  })
  assert.notEqual(res.code, 0)
})
