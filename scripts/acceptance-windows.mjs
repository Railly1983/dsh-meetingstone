#!/usr/bin/env node
// @ts-check
/**
 * Windows 真机验收 · 可自动化部分（零依赖，Node >= 18）。
 *
 *   node scripts/acceptance-windows.mjs                          # 严格模式
 *   node scripts/acceptance-windows.mjs --allow-pending-version  # 版本未 bump 时 release:check 只 WARN
 *   node scripts/acceptance-windows.mjs --help
 *
 * 覆盖（对应 docs/release/acceptance-windows.md §1）：
 *   1. 四条发布门禁：run-tests / verify-host-schema / verify-manifest / verify-package
 *   2. release:check：版本 / PLUGIN_VERSION / CHANGELOG（会重跑四条门禁，属交叉验证）
 *   3. 工具数 = 8：TOOL_NAMES 与 apply() 实际注册产物逐个对齐
 *   4. 命名清洗函数：src/naming.js 的 stripMarkdown / buildTaskLabel 行为正确
 *   5. git worktree 命令可用（真机隔离验收的环境前提）
 *
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 参数错误或脚本自身异常。
 * WARN 默认不影响退出码（仅 --allow-pending-version 会把版本元数据未就绪降级为 WARN）；
 * 其它检查只要 FAIL 就退出 1。
 *
 * 本脚本**只读**：不写文件、不改配置、不删除工作树、不启动真实派单。
 * 人工项（四通道派单 / Jobs 停止 / 进程清理 / 隔离 / 双项目 / 三面板）必须按文档执行。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href

const EXIT_SCRIPT_ERROR = 2
const GATE_TIMEOUT_MS = 30 * 60 * 1000
const MAX_BUFFER = 64 * 1024 * 1024

/** release:check 里属于「版本元数据」的检查项（可以因未 bump 而预期失败）。 */
const RELEASE_METADATA_CHECKS = new Set([
  'package.json 版本',
  'PLUGIN_VERSION 版本',
  'CHANGELOG 条目',
])

/** @typedef {{ status: 'PASS' | 'FAIL' | 'WARN', name: string, durationMs: number | null, summary: string, detail?: string }} CheckRow */

/** @type {CheckRow[]} */
const rows = []

/**
 * @param {'PASS' | 'FAIL' | 'WARN'} status
 * @param {string} name
 * @param {string} summary
 * @param {{ durationMs?: number | null, detail?: string }} [extra]
 */
function addRow(status, name, summary, extra = {}) {
  rows.push({
    status,
    name,
    summary,
    durationMs: extra.durationMs ?? null,
    ...(extra.detail ? { detail: extra.detail } : {}),
  })
}

function parseArgs(argv) {
  /** @type {{ allowPendingVersion: boolean, help: boolean }} */
  const args = { allowPendingVersion: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--allow-pending-version') args.allowPendingVersion = true
    else {
      console.error(`未知参数：${arg}`)
      console.error('用法：node scripts/acceptance-windows.mjs [--allow-pending-version]')
      process.exit(EXIT_SCRIPT_ERROR)
    }
  }
  return args
}

/** @param {string} text @param {number} [maxLines] */
function tail(text, maxLines = 8) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n')
}

/** @param {string} text */
function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? ''
  )
}

/**
 * 跑一个 node 脚本，捕获输出。
 * @param {string} script
 * @param {number} [timeoutMs]
 */
function runNodeScript(script, timeoutMs = GATE_TIMEOUT_MS) {
  const startedAt = Date.now()
  const res = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  const durationMs = Date.now() - startedAt
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
  return { res, output, durationMs }
}

/** run-tests 的 TAP 摘要（跨 Node 20 稳定）。 @param {string} output */
function summarizeTests(output) {
  /** @param {string} key */
  const num = (key) => new RegExp(`^# ${key} (\\d+)$`, 'm').exec(output)?.[1]
  if (num('tests')) {
    return `${num('tests')} tests / ${num('pass') ?? '?'} pass / ${num('fail') ?? '?'} fail / ${num('skipped') ?? '?'} skipped`
  }
  return firstLine(output) || 'exit 0'
}

/** 门禁脚本成功时的摘要。 @param {string} script @param {string} output */
function summarizeGate(script, output) {
  if (script.includes('run-tests')) return summarizeTests(output)
  const passLine = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^PASS[:：]/.test(line))
  return passLine ?? (firstLine(output) || 'exit 0')
}

/**
 * 跑一条门禁并记录。spawn 失败 / 非 0 退出都算 FAIL。
 * @param {string} label
 * @param {string} script
 */
function runGate(label, script) {
  const { res, output, durationMs } = runNodeScript(script)
  if (res.error) {
    addRow('FAIL', label, `无法执行：${res.error.message}`, { durationMs })
    return
  }
  if (res.status !== 0) {
    addRow('FAIL', label, `退出码 ${res.status}`, {
      durationMs,
      detail: tail(output, 10),
    })
    return
  }
  addRow('PASS', label, summarizeGate(script, output), { durationMs })
}

/**
 * release:check 输出按 `[STATUS] 检查项` 解析成行，便于区分「版本未就绪」和「门禁坏了」。
 * @param {string} output
 */
function parseReleaseCheckRows(output) {
  /** @type {Array<{ status: string, name: string, detail: string[] }>} */
  const parsed = []
  /** @type {{ status: string, name: string, detail: string[] } | null} */
  let current = null
  for (const raw of String(output).split(/\r?\n/)) {
    const m = /^\[(PASS|FAIL|SKIP)\]\s+(.+)$/.exec(raw)
    if (m) {
      current = { status: m[1], name: m[2].trim(), detail: [] }
      parsed.push(current)
      continue
    }
    if (current && /^\s{6,}\S/.test(raw)) current.detail.push(raw.trim())
    else if (raw.trim() === '' || /^=+$/.test(raw.trim())) current = null
  }
  return parsed
}

/** 检查 release:check（会重跑四条门禁）。 @param {boolean} allowPendingVersion */
function checkReleaseCheck(allowPendingVersion) {
  const label = 'release:check（版本/CHANGELOG + 门禁重跑）'
  const { res, output, durationMs } = runNodeScript('scripts/release-check.mjs')
  if (res.error) {
    addRow('FAIL', label, `无法执行：${res.error.message}`, { durationMs })
    return
  }

  const parsed = parseReleaseCheckRows(output)
  const target = /^目标版本：([^\s（]+)/m.exec(output)?.[1] ?? '未知'
  const failed = parsed.filter((row) => row.status === 'FAIL')
  const gateFailed = failed.filter((row) => !RELEASE_METADATA_CHECKS.has(row.name))
  const metadataFailed = failed.filter((row) => RELEASE_METADATA_CHECKS.has(row.name))

  if (res.status === 0 && failed.length === 0) {
    addRow('PASS', label, `目标 ${target} · 版本/CHANGELOG 一致 · 门禁重跑通过`, { durationMs })
    return
  }

  const summarizeFailure = (list) =>
    list
      .map((row) => `${row.name}${row.detail[0] ? `（${row.detail[0]}）` : ''}`)
      .join('；')

  if (failed.length > 0 && gateFailed.length === 0 && allowPendingVersion) {
    addRow(
      'WARN',
      label,
      `版本元数据未就绪（预期，允许放行）· ${metadataFailed.length} 项`,
      {
        durationMs,
        detail: `${summarizeFailure(metadataFailed)}\n按 docs/release/0.1.0-alpha-checklist.md §1–2 bump 版本后重跑；发布前不得保留 WARN。`,
      },
    )
    return
  }

  if (failed.length > 0) {
    addRow(
      'FAIL',
      label,
      `退出码 ${res.status} · ${failed.length} 项失败（${failed.map((row) => row.name).join(' / ')}）`,
      {
        durationMs,
        detail: summarizeFailure(failed),
      },
    )
    return
  }

  addRow('FAIL', label, `退出码 ${res.status}，但没有解析到失败项`, {
    durationMs,
    detail: tail(output, 10),
  })
}

/** 工具数 = 8，且与 TOOL_NAMES 完全一致。 */
async function checkToolCount() {
  const label = '工具数 = 8'
  try {
    const { apply } = await import(`${rootUrl}/src/index.js`)
    const { TOOL_NAMES } = await import(`${rootUrl}/src/dsh/register.js`)

    const registered = []
    const ctx = {
      effect(fn) {
        fn()
      },
      tools: {
        register(tool) {
          registered.push(tool)
          return () => {}
        },
      },
      logger: { info() {} },
    }
    apply(ctx, {})

    const declared = Object.values(TOOL_NAMES)
    const registeredNames = registered.map((tool) => tool.name)
    const problems = []
    if (declared.length !== 8) problems.push(`TOOL_NAMES 声明 ${declared.length} 个（应为 8）`)
    if (registered.length !== 8) problems.push(`apply() 实际注册 ${registered.length} 个（应为 8）`)

    const missing = declared.filter((name) => !registeredNames.includes(name))
    const extra = registeredNames.filter((name) => !declared.includes(name))
    if (missing.length) problems.push(`缺少注册：${missing.join(', ')}`)
    if (extra.length) problems.push(`多出未声明：${extra.join(', ')}`)
    if (new Set(registeredNames).size !== registeredNames.length) problems.push('存在重复工具名')

    if (problems.length) {
      addRow('FAIL', label, problems.join('；'), { detail: registeredNames.join(', ') })
      return
    }
    addRow('PASS', label, `8 个：${registeredNames.join(', ')}`)
  } catch (error) {
    addRow('FAIL', label, `检查失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 命名清洗函数存在且行为符合 docs/gui-0.2.0.md §6.2。 */
async function checkNaming() {
  const label = '命名清洗函数（src/naming.js）'
  try {
    const naming = await import(`${rootUrl}/src/naming.js`)
    const { stripMarkdown, buildTaskLabel, taskShortTitle, TASK_TITLE_MAX_CHARS } = naming

    for (const [name, value] of Object.entries({ stripMarkdown, buildTaskLabel, taskShortTitle })) {
      if (typeof value !== 'function') throw new Error(`缺少导出函数 ${name}`)
    }

    const cleaned = stripMarkdown('**P0-4** `验收` [链接](https://example.com)')
    if (cleaned !== 'P0-4 验收 链接') {
      throw new Error(`stripMarkdown 行为不符：得到「${cleaned}」，应为「P0-4 验收 链接」`)
    }

    const labelText = buildTaskLabel({ name: '八戒' }, '### 任务：**修复** `bug`')
    if (labelText !== '八戒 · 修复 bug') {
      throw new Error(`buildTaskLabel 行为不符：得到「${labelText}」`)
    }

    const forbidden = /[*_~#`|\\[\](){}<>]/
    if (forbidden.test(labelText)) {
      throw new Error(`标签仍含 Markdown 符号：「${labelText}」`)
    }

    const longTitle = taskShortTitle('长'.repeat(30))
    const length = Array.from(longTitle).length
    if (length > TASK_TITLE_MAX_CHARS || !longTitle.endsWith('…')) {
      throw new Error(`长目标截断不符：${length} 字「${longTitle}」`)
    }

    const fallback = buildTaskLabel({}, '')
    if (fallback !== '未知角色 · 未命名任务') {
      throw new Error(`空角色/空任务回退不符：「${fallback}」`)
    }

    addRow('PASS', label, `示例「${labelText}」· 截断 ${length}/${TASK_TITLE_MAX_CHARS} 字 · 空值回退正确`)
  } catch (error) {
    addRow('FAIL', label, error instanceof Error ? error.message : String(error))
  }
}

/**
 * git worktree 命令可用（当前目录应在列表里）。
 * Windows 上 git 可能是 .exe（直接 spawn 即可）；直接 spawn 失败时再退到 shell。
 * @param {string[]} args
 */
function runGit(args) {
  const options = {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }
  let res = spawnSync('git', args, options)
  if (res.error && res.error.code === 'ENOENT' && process.platform === 'win32') {
    res = spawnSync('git', args, { ...options, shell: true })
  }
  return res
}

function checkWorktree() {
  const label = 'git worktree 命令可用'
  try {
    const versionRes = runGit(['--version'])
    if (versionRes.error || versionRes.status !== 0) {
      const reason = versionRes.error?.message ?? `退出码 ${versionRes.status}`
      addRow('FAIL', label, `git 不可用：${reason}`)
      return
    }
    const version = firstLine(versionRes.stdout) || 'git（版本未知）'

    const listRes = runGit(['worktree', 'list', '--porcelain'])
    if (listRes.error || listRes.status !== 0) {
      const output = `${listRes.stdout ?? ''}${listRes.stderr ?? ''}`
      addRow('FAIL', label, 'git worktree list 失败', {
        detail: tail(output || listRes.error?.message || '', 10),
      })
      return
    }

    const paths = [...String(listRes.stdout).matchAll(/^worktree (.+)$/gm)].map((m) => m[1].trim())
    const normalize = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const currentListed = paths.some((p) => normalize(p) === normalize(root))

    if (paths.length === 0) {
      addRow('FAIL', label, `${version} · worktree list 为空，无法确认命令可用`)
      return
    }
    if (!currentListed) {
      addRow(
        'WARN',
        label,
        `${version} · 命令可用，共 ${paths.length} 棵；当前目录未被 git 登记（可能经 junction/大小写差异访问）`,
      )
      return
    }
    addRow('PASS', label, `${version} · 已登记 ${paths.length} 棵工作树，当前目录在列表中`)
  } catch (error) {
    addRow('FAIL', label, error instanceof Error ? error.message : String(error))
  }
}

/** 简单的中日韩字符宽度，用于表格对齐（零依赖）。 @param {string} text */
function displayWidth(text) {
  let width = 0
  for (const ch of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? 2
      : 1
  }
  return width
}

/** @param {string} text @param {number} width */
function padRight(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** @param {CheckRow[]} list */
function printTable(list) {
  const nameWidth = Math.max(12, ...list.map((row) => displayWidth(row.name)))
  const header = `${padRight('状态', 4)}  ${padRight('检查', nameWidth)}  ${padRight('耗时', 7)}  结果`
  console.log(header)
  console.log('─'.repeat(Math.max(72, displayWidth(header))))
  for (const row of list) {
    const duration = row.durationMs == null ? '-' : `${(row.durationMs / 1000).toFixed(1)}s`
    console.log(
      `${padRight(row.status, 4)}  ${padRight(row.name, nameWidth)}  ${padRight(duration, 7)}  ${row.summary}`,
    )
  }
}

function printUsage() {
  console.log('用法：node scripts/acceptance-windows.mjs [--allow-pending-version]')
  console.log('')
  console.log('  --allow-pending-version  版本/CHANGELOG 未 bump 时把 release:check 记为 WARN（不退出 1）')
  console.log('  -h, --help               显示本帮助')
  console.log('')
  console.log('人工项见 docs/release/acceptance-windows.md；本脚本不启动真实派单。')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  console.log('dsh-meetingstone · Windows 真机验收（可自动化部分）')
  console.log(`Node ${process.version} · ${process.platform} ${process.arch} · 工作目录：${root}`)
  console.log('='.repeat(78))

  runGate('门禁 · 测试（npm test）', 'scripts/run-tests.mjs')
  runGate('门禁 · 工具 schema', 'scripts/verify-host-schema.mjs')
  runGate('门禁 · manifest', 'scripts/verify-manifest.mjs')
  runGate('门禁 · 发布包', 'scripts/verify-package.mjs')
  checkReleaseCheck(args.allowPendingVersion)

  await checkToolCount()
  await checkNaming()
  checkWorktree()

  console.log('')
  printTable(rows)
  console.log('='.repeat(78))

  const failed = rows.filter((row) => row.status === 'FAIL')
  const warned = rows.filter((row) => row.status === 'WARN')
  const passed = rows.filter((row) => row.status === 'PASS')

  const details = rows.filter((row) => row.status !== 'PASS' && row.detail)
  if (details.length) {
    console.log('')
    console.log('详情：')
    for (const row of details) {
      console.log(`[${row.status}] ${row.name}`)
      for (const line of String(row.detail).split(/\r?\n/)) console.log(`       ${line}`)
    }
  }

  console.log('')
  if (failed.length) {
    console.log(`结果：不通过 —— ${passed.length} PASS / ${warned.length} WARN / ${failed.length} FAIL`)
    console.log('先修 FAIL，再重跑：npm run acceptance')
    process.exitCode = 1
    return
  }

  if (warned.length) {
    console.log(
      `结果：可自动化部分通过（含 ${warned.length} WARN）—— ${passed.length} PASS / ${warned.length} WARN / 0 FAIL`,
    )
    console.log('WARN 中版本元数据未就绪属发布前阻塞项：bump 版本后重跑 npm run release:check，发布前不得保留。')
  } else {
    console.log(`结果：可自动化部分通过 —— ${passed.length} PASS / 0 WARN / 0 FAIL`)
  }

  console.log('')
  console.log('注意：本脚本不覆盖四通道派单 / Jobs 停止 / 进程清理 / 工作树隔离 / 双项目 / 三面板。')
  console.log('真机人工项按 docs/release/acceptance-windows.md §2 执行并留证据；自动化通过 ≠ 真机通过。')
}

try {
  await main()
} catch (error) {
  console.error(`acceptance-windows 执行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(EXIT_SCRIPT_ERROR)
}
