// @ts-check
/**
 * manifest 自检：防止改坏 package.json / cordis.patch.yml 的发布契约。
 * 在 CI 与本地都能跑：node scripts/verify-manifest.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const failures = []
const ok = (cond, msg) => {
  if (!cond) failures.push(msg)
}

// --- package.json ---
ok(pkg.name === 'dsh-meetingstone', `name 应为 dsh-meetingstone，实际 ${pkg.name}`)
ok(pkg.type === 'module', 'type 必须是 module（bundle 入口是 ESM）')
ok(existsSync(join(root, pkg.main ?? '')), `main 指向的文件不存在：${pkg.main}`)
ok(
  pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string',
  '必须有 dsh.bundle.patch',
)
ok(
  pkg.engines && typeof pkg.engines.dsh === 'string',
  '必须有 engines.dsh（否则安装器回退查 peer 范围，等于不设门槛）',
)
ok(
  /^>=0\.2\.2-rc\.1/.test(pkg.engines?.dsh ?? ''),
  'engines.dsh 下界应显式覆盖当前 rc 基线（见 docs/audit/02b-engine-probe.md）',
)
ok(
  Array.isArray(pkg.files) && pkg.files.includes('src'),
  'files 必须包含 src（否则发布包缺代码）',
)
const runtimeDeps = Object.keys(pkg.dependencies ?? {})
ok(runtimeDeps.length === 0, `第一版不应声明运行时依赖，实际：${runtimeDeps.join(', ')}`)

// --- cordis.patch.yml ---
const patchPath = join(root, pkg.dsh?.bundle?.patch ?? '')
ok(existsSync(patchPath), `补丁文件不存在：${pkg.dsh?.bundle?.patch}`)
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  ok(/- insert:/.test(patch), '补丁需要有 insert 段')
  ok(/\bid:\s*meetingstone\b/.test(patch), '补丁行 id 应为 meetingstone（用户按 id 覆盖）')
  ok(
    new RegExp(`name:\\s*${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(patch),
    `补丁行的 name 应等于包名 ${pkg.name}`,
  )
}

// --- 入口导出契约 ---
const entry = readFileSync(join(root, pkg.main ?? ''), 'utf8')
ok(/export\s+const\s+name\s*=/.test(entry), '入口必须导出 name')
ok(/export\s+function\s+apply\s*\(/.test(entry), '入口必须导出 apply(ctx)')

if (failures.length) {
  console.error('manifest 自检失败：')
  for (const f of failures) console.error(' - ' + f)
  process.exit(1)
}
console.log('manifest 自检通过')
