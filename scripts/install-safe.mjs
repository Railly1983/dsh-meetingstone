#!/usr/bin/env node
/**
 * Safe install: Canary boot check -> overlay plugin files -> detached watcher restarts DSH
 * and verifies there is no new crash log (rolls back on failure).
 *
 * Why file overlay instead of plugin manager:
 *   pnpm remove/add rewrites cordis.patch.yml and drops our provider insert rows and
 *   the meetingstone config (measured twice). Overlaying the package directory keeps
 *   the profile patch untouched.
 *
 * Usage:
 *   node scripts/install-safe.mjs --tgz <new.tgz> [--previous <old.tgz>] [--no-restart]
 *
 * Exit codes: 0 installed (watcher restarts + verifies); 1 canary failed, desktop untouched;
 *             3 install/watcher failed.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

/** Overlay package/ from tgz onto the installed plugin directory. */
function install(target) {
  const targetDir = join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-meetingstone')
  const stage = mkdtempSync(join(tmpdir(), 'ms-stage-'))
  const extract = sh(`tar -xzf "${target}" -C "${stage}"`, 120000)
  if (extract.status !== 0) {
    return { status: extract.status, stdout: extract.stdout, stderr: extract.stderr }
  }
  const source = join(stage, 'package')
  if (!existsSync(source)) {
    return { status: 1, stdout: '', stderr: 'tgz has no package/ root' }
  }
  mkdirSync(targetDir, { recursive: true })
  cpSync(source, targetDir, { recursive: true, force: true })
  rmSync(stage, { recursive: true, force: true })
  return { status: 0, stdout: 'overlaid', stderr: '' }
}

// 1) Canary
console.log('[1/3] boot-canary ...')
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

// 2) Overlay install
console.log('[2/3] overlay into desktop profile ...')
const startedAt = Date.now()
const result = install(tgz)
if (result.status !== 0) {
  console.error('install-safe: install failed')
  console.error((result.stderr || result.stdout).split('\n').slice(-8).join('\n'))
  process.exit(3)
}
// 同步 profile 依赖串，避免 pnpm 把旧 tgz 装回
try {
  const profilePkgPath = join(HOME, 'profiles', 'desktop', 'package.json')
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  profilePkg.dependencies = profilePkg.dependencies || {}
  profilePkg.dependencies['dsh-meetingstone'] = 'file:' + tgz.replace(/\\/g, '/')
  writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
} catch (error) {
  console.warn('install-safe: profile dependency sync warning:', error.message)
}
console.log('installed.')

if (skipRestart) {
  console.log('install-safe: --no-restart, done.')
  process.exit(0)
}

// 3) Detached watcher restart + crash check + rollback
const fallbackRaw =
  previous ??
  readdirSync(PACKAGES)
    .filter((name) => name.endsWith('.tgz') && join(PACKAGES, name) !== tgz)
    .sort()
    .pop()
const fallback = fallbackRaw && isAbsolute(fallbackRaw) ? fallbackRaw : fallbackRaw ? join(PACKAGES, fallbackRaw) : undefined
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
  `"${fallback}"`,
  '-StartMs',
  String(startedAt),
  '-ResultFile',
  `"${resultFile}"`,
].join(' ')

const wmiCommand = 'powershell.exe ' + watcherArgs
const outer = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${wmiCommand.replace(/'/g, "''")}'} | Out-Null`
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
console.log(`install-safe: rollback target: ${fallback}`)
process.exit(0)
