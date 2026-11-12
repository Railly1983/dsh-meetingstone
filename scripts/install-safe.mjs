#!/usr/bin/env node
/**
 * 安全安装：Canary 启动验证 → 安装到 desktop → 重启 → 崩溃自动回滚。
 *
 * 用法：
 *   node scripts/install-safe.mjs --tgz C:\...\dsh-meetingstone-0.1.0-alpha.tgz
 *   node scripts/install-safe.mjs --tgz <new.tgz> --previous <old.tgz>
 *
 * 退出码：0 成功；1 Canary 失败（未安装）；2 安装后启动崩溃并已回滚；3 安装/重启流程错误。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
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

if (!tgz || !existsSync(tgz)) {
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

function latestCrashTime() {
  const dir = join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'logs')
  try {
    const files = readdirSync(dir)
      .filter((name) => name.startsWith('crash-') && name.endsWith('.log'))
      .map((name) => statSync(join(dir, name)).mtimeMs)
    return files.length ? Math.max(...files) : 0
  } catch {
    return 0
  }
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

// 2) 安装
console.log('[2/3] install into desktop …')
const startedAt = Date.now()
const result = install(tgz)
if (result.add.status !== 0) {
  console.error('install-safe: install failed')
  console.error((result.add.stderr || result.add.stdout).split('\n').slice(-8).join('\n'))
  process.exit(3)
}
console.log('installed.')

if (skipRestart) {
  console.log('install-safe: --no-restart, done.')
  process.exit(0)
}

// 3) 重启并观察崩溃日志
console.log('[3/3] restart and watch for crash …')
sh(
  'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:/MeetingStone/scripts/restart-dsh.ps1"',
  60000,
)
const deadline = Date.now() + 40000
let crashed = false
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (latestCrashTime() > startedAt) {
    crashed = true
    break
  }
}

const fallback =
  previous ??
  readdirSync(PACKAGES)
    .filter((name) => name.endsWith('.tgz') && join(PACKAGES, name) !== tgz)
    .sort()
    .pop()

if (!crashed) {
  console.log('PASS install-safe: booted without new crash log')
  process.exit(0)
}

console.error('FAIL install-safe: crash log appeared after install; rolling back …')
if (!fallback) {
  console.error('No previous tgz found; manual rollback required.')
  process.exit(2)
}
const rollback = install(join(PACKAGES, fallback))
if (rollback.add.status !== 0) {
  console.error(`Rollback failed; reinstall manually: ${fallback}`)
  process.exit(2)
}
sh(
  'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:/MeetingStone/scripts/restart-dsh.ps1"',
  60000,
)
console.error(`install-safe: rolled back to ${fallback}`)
process.exit(2)
