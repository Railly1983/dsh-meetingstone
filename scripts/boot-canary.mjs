#!/usr/bin/env node
/**
 * Boot canary：把待安装的插件 tgz 装进一个**独立临时 profile**，启动后检测是否出现
 * "entry did not activate / failed"，通过后才允许安装到真实 profile。
 *
 * 背景：DSH 的 web boot 只要有一个插件 entry 激活失败，整个应用就弹崩溃对话框；
 * 而真实 desktop profile 无法用 CLI 启动（"managed exclusively by the Electron application"）。
 * 因此用 --from-default-profile web 复制一份官方模板做金丝雀。
 *
 * 用法：
 *   node scripts/boot-canary.mjs --tgz C:\...\dsh-meetingstone-0.1.0-alpha.tgz
 *   node scripts/boot-canary.mjs --tgz <tgz> --keep     # 保留 canary profile 便于排查
 *
 * 退出码：0 通过；1 失败。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const DSH =
  opt('dsh') ??
  process.env.DSH_CLI ??
  'C:/Users/30673/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
const tgz = opt('tgz')
const timeoutMs = Number(opt('timeout-ms', '90000'))
const keep = flag('keep')

if (!tgz) {
  console.error('boot-canary: --tgz <path> is required')
  process.exit(1)
}
if (!existsSync(tgz)) {
  console.error(`boot-canary: tgz not found: ${tgz}`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const profile = `ms-canary-${stamp}`
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = join(home, 'profiles', profile)

function runDsh(argv, timeout = 600000) {
  const result = spawnSync(`"${DSH}" ${argv}`, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: true,
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function cleanup() {
  if (keep) {
    console.error(`boot-canary: kept profile ${profileDir}`)
    return
  }
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    console.error(`boot-canary: cleanup warning: ${error.message}`)
  }
}

// 1) 从官方 web 模板创建独立 profile（不会触碰 desktop）
const create = runDsh(`--profile ${profile} --from-default-profile web --dump-config`)
if (create.status !== 0) {
  console.error('boot-canary: FAIL (cannot create canary profile)')
  console.error((create.stderr || create.stdout).split('\n').slice(-8).join('\n'))
  cleanup()
  process.exit(1)
}

// 2) 安装待验证插件
const install = runDsh(`plugin --profile ${profile} add "${tgz}"`)
if (install.status !== 0) {
  console.error('boot-canary: FAIL (plugin install into canary failed)')
  console.error((install.stderr || install.stdout).split('\n').slice(-8).join('\n'))
  cleanup()
  process.exit(1)
}

// 3) 启动并等待 URL / 失败标志
const outFile = join(tmpdir(), `ms-canary-${stamp}.out.log`)
const errFile = join(tmpdir(), `ms-canary-${stamp}.err.log`)
const child = spawn(
  `"${DSH}" --profile ${profile} --no-open --port 0 2>"${errFile}"`,
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true },
)
let out = ''
child.stdout.on('data', (buffer) => {
  out += String(buffer)
})

const startedAt = Date.now()
let verdict = null // 'ok' | 'fail'
let detail = ''
while (Date.now() - startedAt < timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (out.includes('did not activate') || out.includes(' failed')) {
    verdict = 'fail'
    detail = out
    break
  }
  if (/dsh web: http:\/\/(127\.0\.0\.1|\[::1\]):\d+/.test(out)) {
    verdict = 'ok'
    break
  }
}
if (verdict === null) {
  verdict = 'fail'
  detail = `timeout after ${timeoutMs}ms`
}

// 4) 杀掉 canary 进程树
try {
  spawnSync(`taskkill /PID ${child.pid} /T /F`, {
    windowsHide: true,
    timeout: 15000,
    shell: true,
  })
} catch {
  /* ignore */
}

let errText = ''
try {
  errText = readFileSync(errFile, 'utf8')
} catch {
  /* ignore */
}
const failedLines = `${out}\n${errText}`
  .split(/\r?\n/)
  .filter((line) => /did not activate|entry .* failed|failed to (load|activate)/i.test(line))
  .slice(0, 8)

cleanup()

if (verdict === 'ok') {
  console.log(`PASS boot-canary: ${profile} booted with ${tgz}`)
  process.exit(0)
}

console.error(`FAIL boot-canary: ${tgz} did not boot cleanly`)
if (detail) console.error(detail.split('\n').slice(-10).join('\n'))
for (const line of failedLines) console.error(`  ${line.trim()}`)
process.exit(1)
