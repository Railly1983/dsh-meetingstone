// @ts-check
/**
 * 发布包内容校验（`npm pack --dry-run`）。
 *
 * 目的：确保真正发出去的 tarball 里**有该有的、没有不该有的**。
 * - 必须有：入口、src 树、cordis.patch.yml、README、LICENSE、package.json
 * - 不能有：tests/、docs/audit/、.meetingstone.json、node_modules/、personas.json
 *
 * 用法：node scripts/verify-package.mjs（失败退出码 1）
 */
import { spawnSync } from 'node:child_process'

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'src/index.js',
  'src/config.js',
  'src/roles/registry.js',
  'src/dispatch/dispatcher.js',
  'src/dsh/adapter.js',
  'src/project/load.js',
  'src/cli/probe.js',
]

const FORBIDDEN_PREFIXES = [
  'tests/',
  'docs/audit/',
  'scripts/',
  'examples/',
  'node_modules/',
  '.github/',
]

const FORBIDDEN_EXACT = ['.meetingstone.json', 'personas.json', 'pnpm-lock.yaml']

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 32 * 1024 * 1024,
})

if (result.error) {
  console.error(`无法执行 npm pack：${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error('npm pack --dry-run 失败：')
  console.error(result.stderr || result.stdout)
  process.exit(1)
}

/** npm 有时会在 stdout 前面混入 notice 行，取最后一个 JSON 数组。 */
const text = result.stdout ?? ''
const start = text.indexOf('[')
const end = text.lastIndexOf(']')
if (start === -1 || end === -1) {
  console.error('无法解析 npm pack 输出：')
  console.error(text)
  process.exit(1)
}

/** @type {Array<{ files: Array<{ path: string, size: number }>, size: number }>} */
const packs = JSON.parse(text.slice(start, end + 1))
const files = packs[0]?.files ?? []
const paths = files.map((f) => f.path.replace(/\\/g, '/')).sort()

const failures = []

for (const required of REQUIRED) {
  if (!paths.includes(required)) failures.push(`缺少必需文件：${required}`)
}

for (const p of paths) {
  if (FORBIDDEN_EXACT.includes(p)) {
    failures.push(`不该被打包：${p}`)
    continue
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (p.startsWith(prefix)) failures.push(`不该被打包：${p}`)
  }
}

const totalSize = files.reduce((n, f) => n + (f.size ?? 0), 0)
if (totalSize > 2 * 1024 * 1024) {
  failures.push(`包体积 ${(totalSize / 1024).toFixed(0)} KB 超过 2 MB，检查是否误打包了大文件`)
}

if (failures.length) {
  console.error('发布包校验失败：')
  for (const f of [...new Set(failures)]) console.error(' - ' + f)
  process.exit(1)
}

console.log(`PASS: 发布包含 ${paths.length} 个文件，共 ${(totalSize / 1024).toFixed(1)} KB`)
for (const p of paths) console.log(`  ${p}`)
