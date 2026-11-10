// @ts-check
/**
 * 跨 Node 版本的测试入口。
 *
 * 为什么不直接 `node --test "tests/**\/*.test.mjs"`：
 * - `--test` 的 glob 支持是 Node ≥21 才有的；本机系统 node 是 v20，`npm run` 会用它
 * - Windows 的 cmd 不展开 glob，靠 shell 也不行
 * 所以这里自己枚举文件再传给 `node --test`，任何 Node 20+ 都能跑。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 递归收集 `*.test.mjs`。 */
function collect(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...collect(full))
    else if (entry.endsWith('.test.mjs')) out.push(full)
  }
  return out.sort()
}

const files = collect('tests')
if (files.length === 0) {
  console.error('没有找到任何测试文件（tests/**/*.test.mjs）')
  process.exit(1)
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(res.status ?? 1)
