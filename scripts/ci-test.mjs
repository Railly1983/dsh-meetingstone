// @ts-check
/**
 * 在 CI 里跑测试，并把失败摘要写成 GitHub annotation。
 *
 * ## 为什么需要它
 *
 * GitHub Actions 的详细日志需要认证才能读取，但 **annotation 是公开的**。
 * 之前 CI 一红，只能看到「Process completed with exit code 1」，定位成本极高
 * （2026-11-14：本地全绿、runner 上 4 秒失败，无法判断原因）。
 *
 * 这个脚本把失败的关键行用 `::error::` 输出，GitHub 会把它们变成 annotation，
 * 于是任何人都能在提交页/PR 上直接看到失败原因。
 *
 * 用法：node scripts/ci-test.mjs
 * 退出码与测试本身一致。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runner = join(root, 'scripts', 'run-tests.mjs')

const result = spawnSync(process.execPath, [runner], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: process.env,
})

const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''
const combined = `${stdout}\n${stderr}`
process.stdout.write(stdout)
process.stderr.write(stderr)

const status = result.status ?? 1

/** GitHub 的 annotation 单条有长度限制，且换行要编码成 %0A。 */
function emit(level, title, body) {
  const encoded = String(body).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')
  console.log(`::${level} title=${title}::${encoded.slice(0, 1500)}`)
}

if (status !== 0) {
  const lines = combined.split(/\r?\n/)
  // 优先抓真正的失败信号，而不是普通日志行。
  const signals = lines.filter((line) =>
    /✖|not ok |ERR_MODULE_NOT_FOUND|Cannot find (module|package)|AssertionError|Error:|error code/i.test(line),
  )
  const picked = (signals.length > 0 ? signals : lines.slice(-25)).slice(0, 20)
  emit('error', 'TESTS-FAILED', picked.join('\n'))
  // 附带真实开关信息，便于判断是不是环境问题而不是代码问题。
  const env = [
    `node=${process.version}`,
    `platform=${process.platform}`,
    `cwd=${root}`,
    `wraps=${status}`,
  ].join(' , ')
  emit('notice', 'CI-ENV', env)
} else {
  const summary = combined.split(/\r?\n/).filter((line) => /^# (tests|pass|fail|skipped)/.test(line))
  console.log(summary.join('\n'))
}

process.exit(status)
