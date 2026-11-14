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
  const line = `::${level} title=${title}::${encoded.slice(0, 1500)}`
  // 同时写 stdout 与 stderr：不同 runner 对两者的缓冲/吞掉行为不一致。
  console.log(line)
  console.error(line)
}

// 先无条件报告环境与结果，确保即使后面判断出错也能看到。
emit(
  'notice',
  'CI-TEST-ENV',
  `node=${process.version} platform=${process.platform} status=${String(status)} outLen=${stdout.length} errLen=${stderr.length}`,
)

if (status !== 0) {
  const lines = combined.split(/\r?\n/)
  // 只抓「测试失败」本身，排除被测代码自己打到 stderr 的噪音
  // （例如 GUI 注册失败时会 warn，那是被测行为，不是失败原因）。
  const failLines = lines.filter((line) => /^✖\s|^not ok \d+ -/.test(line))
  const assertLines = lines.filter((line) => /AssertionError|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(line))
  const picked = [...failLines, ...assertLines].slice(0, 25)
  emit('error', 'FAILED-TESTS', picked.length > 0 ? picked.join('\n') : lines.slice(-30).join('\n'))
} else {
  const summary = combined.split(/\r?\n/).filter((line) => /^# (tests|pass|fail|skipped)/.test(line))
  emit('notice', 'TESTS-PASSED', summary.join(' | '))
}

process.exit(status)
