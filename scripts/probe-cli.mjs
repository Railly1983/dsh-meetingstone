// @ts-check
/**
 * 手动跑一次本机 CLI 探测，打印结果。
 * 用法：node scripts/probe-cli.mjs [codex|codebuddy|claude]
 *
 * 这是 C2 的验收脚本：能证明"PATH 查不到的商店应用 CLI 也能被找到"。
 */
import { createProbe } from '../src/cli/probe.js'
import { createDefaultResolvers, runCommand } from '../src/cli/resolvers.js'

const only = process.argv[2]
const probe = createProbe({
  resolvers: createDefaultResolvers({ run: runCommand }),
  runner: runCommand,
})

const results = only ? [await probe.probe(only, { force: true })] : await probe.probeAll({ force: true })

for (const r of results) {
  console.log(`\n=== ${r.cli} ===`)
  console.log(`installed : ${r.installed}`)
  console.log(`path      : ${r.path ?? '-'}`)
  console.log(`version   : ${r.version ?? '-'}`)
  console.log(`source    : ${r.source ?? '-'}`)
  if (r.notes.length) {
    console.log('notes:')
    for (const n of r.notes) console.log(`  - ${n}`)
  }
}

const anyInstalled = results.some((r) => r.installed)
process.exit(anyInstalled ? 0 : 1)
