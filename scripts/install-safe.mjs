#!/usr/bin/env node
/**
 * 安全安装：Canary 启动验证 → 安装到 desktop → 由独立 watcher 重启并验收（崩溃自动回滚）。
 *
 * 用法：
 *   node scripts/install-safe.mjs --tgz C:\...\dsh-meetingstone-0.1.0-alpha.2.tgz
 *   node scripts/install-safe.mjs --tgz <new.tgz> --previous <old.tgz>
 *
 * 退出码：0 已安装并交由 watcher 重启验收；1 Canary 失败（未安装）；3 安装/启动 watcher 失败。
 *
 * 为什么重启放在独立 watcher：
 *   本进程是 DSH 的子进程，直接重启 DSH 会把自己一起杀掉，无法再做崩溃检测与回滚。
 *   watcher 通过 WMI 的 Win32_Process.Create 启动，脱离 DSH 进程树。
 */
import { spawnSync } from 'node:child_process'
import { snapshotConfig, restoreIfLost } from './patch-config.mjs'
import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const NODE = process.execPath
const DSH =
  opt('dsh') ??
  process.env.DSH_CLI ??
  'C:/Users/30673/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PACKAGES = join(HOME, 'packages')
const tgz = opt('tgz')
const previous = opt('previous')
const skipRestart = args.includes('--no-restart')

if (!tgz) {
  console.error('install-safe: --tgz <path> is required')
  process.exit(1)
}
try {
  statSync(tgz)
} catch {
  console.error(`install-safe: tgz not found: ${tgz}`)
  process.exit(1)
}

function sh(command, timeout = 900000) {
  const result = spawnSync(command, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: true,
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function install(target) {
  const remove = sh(`"${DSH}" plugin --profile desktop remove dsh-meetingstone`)
  const add = sh(`"${DSH}" plugin --profile desktop add "${target}"`)
  return { remove, add }
}

// 1) Canary
console.log('[1/3] boot-canary …')
const canary = spawnSync(NODE, [join(process.cwd(), 'scripts', 'boot-canary.mjs'), '--tgz', tgz], {
  encoding: 'utf8',
  timeout: 900000,
  windowsHide: true,
})
process.stdout.write(canary.stdout ?? '')
process.stderr.write(canary.stderr ?? '')
if (canary.status !== 0) {
  console.error('install-safe: Canary failed; desktop profile untouched.')
  process.exit(1)
}

// 2) 安装（先快照 profile patch 的 meetingstone 配置，安装器可能清空它）
console.log('[2/3] install into desktop …')
const configSnapshot = join(tmpdir(), `ms-patch-config-${Date.now()}.json`)
try {
  const saved = snapshotConfig(configSnapshot)
  console.log(`[2/3] config snapshot: ${Object.keys(saved).length} keys`)
} catch (error) {
  console.error('install-safe: config snapshot warning:', error.message)
}
const startedAt = Date.now()
const result = install(tgz)
if (result.add.status !== 0) {
  console.error('install-safe: install failed')
  console.error((result.add.stderr || result.add.stdout).split('\n').slice(-8).join('\n'))
  process.exit(3)
}
try {
  if (restoreIfLost(configSnapshot)) console.log('[2/3] profile config restored after install')
} catch (error) {
  console.error('install-safe: config restore warning:', error.message)
}
console.log('installed.')

if (skipRestart) {
  console.log('install-safe: --no-restart, done. Restart manually to verify.')
  process.exit(0)
}

// 3) 独立 watcher 重启并验收
const fallback =
  previous ??
  readdirSync(PACKAGES)
    .filter((name) => name.endsWith('.tgz') && join(PACKAGES, name) !== tgz)
    .sort()
    .pop()
if (!fallback) {
  console.error('install-safe: no previous tgz for rollback; refusing auto-restart.')
  process.exit(3)
}

const resultFile = join(tmpdir(), `ms-install-safe-${Date.now()}.result`)
const watcherArgs = [
  '-NoProfile',
  '-WindowStyle',
  'Hidden',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  '"D:/MeetingStone/scripts/post-install-watch.ps1"',
  '-NewTgz',
  `"${tgz}"`,
  '-PrevTgz',
  `"${join(PACKAGES, fallback)}"`,
  '-StartMs',
  String(startedAt),
  '-ResultFile',
  `"${resultFile}"`,
].join(' ')

const wmiCommand =
  'powershell.exe ' +
  watcherArgs.replace(/'/g, "''") +
  ''
const outer = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${wmiCommand}'} | Out-Null`
const spawned = sh(
  `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${outer}"`,
  60000,
)
if (spawned.status !== 0) {
  console.error('install-safe: failed to start detached watcher')
  console.error((spawned.stderr || spawned.stdout).split('\n').slice(-6).join('\n'))
  process.exit(3)
}

console.log('[3/3] detached watcher will restart DSH and verify boot.')
console.log(`install-safe: result file: ${resultFile}`)
console.log(`install-safe: rollback target: ${join(PACKAGES, fallback)}`)
process.exit(0)
