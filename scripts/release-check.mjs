#!/usr/bin/env node
// @ts-check
/**
 * 发布就绪检查（零依赖，Node >= 18）。
 *
 *   node scripts/release-check.mjs                 # 按目标版本检查 + 跑四条门禁
 *   node scripts/release-check.mjs --no-gates      # 只查版本 / CHANGELOG
 *   node scripts/release-check.mjs --version 0.1.0  # 显式指定目标版本
 *
 * 目标版本的来源优先级：
 *   1. `--version <v>`
 *   2. `docs/release/<version>-checklist.md` 中**最近修改**的一份（文件名即版本）
 *   3. `package.json` 的 version
 *
 * 检查项：
 *   - package.json version === 目标版本
 *   - src/index.js PLUGIN_VERSION === 目标版本
 *   - CHANGELOG.md 有 `## [<目标版本>]`（或 `## <目标版本>`）条目
 *   - 四条发布门禁：run-tests / verify-host-schema / verify-manifest / verify-package
 *
 * 任一项 FAIL 时退出码为 1；SKIP 不算 FAIL。此脚本**只读**，不修改任何文件、不发布。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'docs', 'release')

/** @typedef {{ status: 'PASS' | 'FAIL' | 'SKIP', check: string, detail: string }} Result */

function parseArgs(argv) {
  /** @type {{ version?: string, gates: boolean, help: boolean }} */
  const args = { gates: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--no-gates') args.gates = false
    else if (a === '--version') {
      args.version = argv[++i]
      if (!args.version) {
        console.error('--version 需要一个版本号')
        process.exit(2)
      }
    } else if (a.startsWith('--version=')) args.version = a.slice('--version='.length)
    else {
      console.error(`未知参数：${a}`)
      process.exit(2)
    }
  }
  return args
}

function readJson(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/** 从 docs/release/*-checklist.md 的文件名取版本，按 mtime 取最新。 */
function targetFromReleaseDocs() {
  if (!existsSync(releaseDir)) return null
  const candidates = []
  for (const name of readdirSync(releaseDir)) {
    const m = /^(.+)-checklist\.md$/i.exec(name)
    if (!m) continue
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m[1])) continue
    const path = join(releaseDir, name)
    try {
      candidates.push({ version: m[1], path, mtime: statSync(path).mtimeMs })
    } catch {
      /* 读不到就跳过，不让检查本身崩 */
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return {
    version: candidates[0].version,
    source: `docs/release/${candidates[0].path.split(/[\\/]/).pop()}`,
  }
}

/** @param {string} source */
function readText(source) {
  try {
    return readFileSync(source, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

function hasChangelogEntry(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 接受：## [0.1.0-alpha] - date / ## 0.1.0-alpha / ## v0.1.0-alpha
  return new RegExp(`^##\\s*\\[?v?${escaped}\\]?(?:\\s|$)`, 'm').test(changelog)
}

/** @param {string} script @param {string} output */
function summarizeGate(script, output) {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (script.includes('run-tests')) {
    const num = (label) => new RegExp(`^# ${label} (\\d+)$`, 'm').exec(output)?.[1]
    return [
      `${num('tests') ?? '?'} tests / ${num('pass') ?? '?'} pass / ${num('fail') ?? '?'} fail / ${num('skipped') ?? '?'} skipped`,
    ].join(' · ')
  }
  return lines.find((l) => /^PASS[:：]/.test(l)) ?? lines.at(-1) ?? 'exit 0'
}

/** @param {string} script */
function runGate(script) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const tail = output.split(/\r?\n/).slice(-8).join('\n')
  if (result.error) {
    return { ok: false, durationMs, detail: `无法执行：${result.error.message}` }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      durationMs,
      detail: `退出码 ${result.status}；输出末尾：\n${tail}`,
    }
  }
  return { ok: true, durationMs, detail: summarizeGate(script, output) }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/release-check.mjs [--version <v>] [--no-gates]')
    return
  }

  const pkg = readJson(join(root, 'package.json'))
  const entry = readText(join(root, 'src', 'index.js'))
  if (entry == null) {
    console.error('读不到 src/index.js')
    process.exit(1)
  }
  const versionMatch = /export\s+const\s+PLUGIN_VERSION\s*=\s*(['"])([^'"\n]+)\1/.exec(entry)
  const pluginVersion = versionMatch ? versionMatch[2] : null

  const fromDoc = args.version ? null : targetFromReleaseDocs()
  const target = args.version ?? fromDoc?.version ?? pkg.version
  const targetSource = args.version
    ? '--version'
    : fromDoc?.source ?? 'package.json'

  /** @type {Result[]} */
  const results = []
  const push = (status, check, detail) => results.push({ status, check, detail })

  push(
    pkg.version === target ? 'PASS' : 'FAIL',
    'package.json 版本',
    `${pkg.version} ${pkg.version === target ? '==' : '!='} ${target}`,
  )

  if (!pluginVersion) {
    push('FAIL', 'PLUGIN_VERSION', 'src/index.js 未找到 PLUGIN_VERSION 导出')
  } else {
    push(
      pluginVersion === target ? 'PASS' : 'FAIL',
      'PLUGIN_VERSION 版本',
      `${pluginVersion} ${pluginVersion === target ? '==' : '!='} ${target}`,
    )
  }

  const changelog = readText(join(root, 'CHANGELOG.md'))
  if (changelog == null) {
    push('FAIL', 'CHANGELOG 条目', '读不到 CHANGELOG.md')
  } else if (hasChangelogEntry(changelog, target)) {
    push('PASS', 'CHANGELOG 条目', `存在 "## [${target}]"`)
  } else {
    push('FAIL', 'CHANGELOG 条目', `缺少 "## [${target}]"（不能只写在 [Unreleased]）`)
  }

  const gates = [
    { name: '门禁 · 测试', script: 'scripts/run-tests.mjs' },
    { name: '门禁 · 客户端注入冒烟', script: 'scripts/smoke-client-inject.mjs' },
    { name: '门禁 · D1 渲染核对', script: 'scripts/verify-d1-render.mjs' },
    { name: '门禁 · D1 交互核对', script: 'scripts/verify-d1-interaction.mjs' },
    { name: '门禁 · 工具 schema', script: 'scripts/verify-host-schema.mjs' },
    { name: '门禁 · manifest', script: 'scripts/verify-manifest.mjs' },
    { name: '门禁 · 发布包', script: 'scripts/verify-package.mjs' },
  ]
  if (args.gates) {
    for (const gate of gates) {
      const r = runGate(gate.script)
      push(
        r.ok ? 'PASS' : 'FAIL',
        gate.name,
        `${(r.durationMs / 1000).toFixed(1)}s · ${r.detail}`,
      )
    }
  } else {
    for (const gate of gates) push('SKIP', gate.name, '--no-gates')
  }

  console.log(`dsh-meetingstone 发布就绪检查`)
  console.log(`目标版本：${target}  （来源：${targetSource}）`)
  console.log('='.repeat(72))
  for (const r of results) {
    console.log(`[${r.status}] ${r.check}`)
    for (const line of String(r.detail).split(/\r?\n/)) console.log(`       ${line}`)
  }
  console.log('='.repeat(72))

  const failed = results.filter((r) => r.status === 'FAIL')
  const passed = results.filter((r) => r.status === 'PASS')
  const skipped = results.filter((r) => r.status === 'SKIP')
  if (failed.length > 0) {
    console.log(`结果：不可发布 —— ${failed.length} FAIL / ${passed.length} PASS / ${skipped.length} SKIP`)
    console.log('按 docs/release/ 下对应版本的清单处理后重跑。')
    process.exitCode = 1
  } else {
    console.log(`结果：可发布（元数据 + 门禁通过） —— ${passed.length} PASS / ${skipped.length} SKIP`)
    console.log('真机冒烟（派单 / PONG / Jobs / 设置页 / 停止）仍需人工完成，见发布清单。')
  }
}

try {
  main()
} catch (error) {
  console.error(`release-check 执行失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
