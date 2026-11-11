#!/usr/bin/env node
// @ts-check
/**
 * 工具回执字节对照（A/B 基线）。
 *
 * 依据 docs/reference/efficiency-v1.0.md §7.2 / §9：
 * 用「可复现的旧/新输出对照」证明工具回执瘦身效果，而不是只凭估算。
 *
 * 做法：
 * - 用【假 ctx + 假 dispatcher / 假 run-store】调用真实的 registerTools（src/dsh/register.js），
 *   让「新机制」的回执字节来自当前仓库里真正在跑的工具代码，而非手写数字。
 * - 「旧机制」用两种方式重建：
 *   dispatch  -> 构造瘦身前的完整 dispatcher 回执（含长人设 / 模型参数 / Context Pack / 工作树）；
 *   get_task  -> 用当前工具保留的 full:true 通道等价重建「旧版默认全文」；
 *   list_roles-> 用当前工具保留的 verbose:true 通道等价重建「旧版全量详情」。
 * - bytes = JSON.stringify(value ?? null) 的 UTF-8 字节数，与工具 output.render
 *   （register.js 的 renderObject）序列化方式完全一致。
 * - approxTokens 仅为估算：ceil(max(bytes/4, CJK 字符数/1))，标注「估算」。
 *
 * 零依赖：只用 node: 内置模块 + 本仓库 src/ 模块；刻意不输出时间戳 / 随机值，保证输出稳定。
 *
 * 用法：
 *   node scripts/measure-tool-output.mjs           # 人类可读表格 + 对照
 *   node scripts/measure-tool-output.mjs --json    # 纯 JSON（机器可读）
 */
import {
  registerTools,
  TOOL_NAMES,
  TASK_RESULT_HEAD_BYTES,
  TASK_RESULT_TAIL_BYTES,
} from '../src/dsh/register.js'

// ────────────────────────────────────────────────────────────────────────────
// 1. 固定合成样本（确定、无随机、无时间戳）
// ────────────────────────────────────────────────────────────────────────────

/** 带长人设的 role：模拟旧版把完整系统提示原样回传主控的情形。 */
function buildLongPersona() {
  const lines = [
    '你是「悟空」，集合石 MeetingStone 多 CLI 协作框架中的主力开发角色（role-wukong）。',
    '你运行在 DeepSeek Harness 宿主提供的 codex 通道上，负责核心功能开发、关键重构、',
    '疑难缺陷定位与性能问题排查，对交付质量与可验收性负最终责任。',
    '',
    '【身份与边界】',
    '- 你是被派发的子 Agent，只在当前任务授权范围内工作；不得擅自提升权限或切换更高成本模型。',
    '- 不得访问与任务无关的凭据、密钥、登录令牌或跨 CLI 的完整会话状态。',
    '- 工作树隔离只隔离文件布局，不是权限沙箱；涉及外部副作用前必须确认边界。',
    '',
    '【工作方法】',
    '- 先读现有代码与测试，确认真实 schema、调用方与宿主 API，再动手，不凭猜测改接口。',
    '- 优先复用 DSH 原生 Jobs / Subagent / Workspace / Permissions 能力，不自建队列与数据库。',
    '- 输出结论、证据、产物引用与未解决问题；完整日志写入产物目录，不回传长篇复述。',
    '- 修改前先跑对应模块单测作基线，修改后回归；失败先定位根因，不绕过校验。',
    '',
    '【行为规范】',
  ]
  const rules = [
    '提交前自检：不改动未授权文件，不留调试代码，不编造未验证的结论。',
    '遇到不确定之处先说明并请求澄清，不擅自假设接口字段或配置语义。',
    '每次改动保持最小必要，不做与当前任务无关的顺手重构。',
    '所有可观测数据如实标注口径，估算值必须标记「估算」，不得冒充真实 Usage。',
    '回执保持紧凑：完整人设、模型参数与上下文包不随每次工具调用回传主控。',
  ]
  for (let i = 0; i < 24; i += 1) {
    lines.push(`${String(i + 1).padStart(2, '0')}. ${rules[i % rules.length]}`)
  }
  lines.push('', '【交付验收】', '- 变更清单、测试证据、遗留风险齐备；不声称已实现或已节省，直到有可复现测试数据。')
  return lines.join('\n')
}

/**
 * ~8KB 任务结果：确定性填充到接近 8000 字节。
 * 头/尾固定，中间是带 CJK 的复核记录，用来同时覆盖 bytes/4 与 CJK 字符数口径。
 */
function buildTaskText() {
  const head = [
    '# 任务结果：审核登录模块权限边界',
    'status: completed',
    'reviewer: 悟空 (role-wukong)',
    'scope: src/auth/, tests/auth/（只读审查，未修改代码）',
    '',
    '## 结论',
    '发现 2 个权限检查缺口，均位于授权回调路径；其余检查点未发现越权或绕过风险。',
    '',
    '## 逐项复核记录',
  ].join('\n')
  const tail = [
    '',
    '## 验收',
    '- 已列出确认问题及证据位置：2 项',
    '- 已区分真实问题与潜在风险：是',
    '- 检查范围明确：src/auth/、tests/auth/',
    '- 结论：通过（需修复上述 2 项后复核）',
    '',
    'artifacts: .meetingstone/runs/child-baseline-0001/review.md',
  ].join('\n')
  const findings = [
    '授权回调未校验租户归属，跨租户 code 可被换绑到当前会话',
    '刷新令牌重放窗口内缺少 jti 去重，存在短时重复兑换风险',
    '普通用户无法访问管理员接口，角色判定在网关层已覆盖',
    '密码重置链接一次性作废逻辑正常，未发现可复用令牌',
    '会话固定攻击防护有效，登录后 sessionId 已轮换',
  ]
  const target = 8000
  const lines = [head]
  let i = 1
  for (;;) {
    const line = `  ${String(i).padStart(3, '0')} | src/auth/callback.ts:${40 + i} | ${findings[i % findings.length]} | 证据：review.md#${i}`
    const candidate = [...lines, line, tail].join('\n')
    if (Buffer.byteLength(candidate, 'utf8') > target) break
    lines.push(line)
    i += 1
  }
  lines.push(tail)
  return lines.join('\n')
}

const PERSONA = buildLongPersona()

/** 旧版 dispatch 全量回执里的完整 role（长人设 + 模型参数）。 */
const ROLE_FULL = {
  roleId: 'role-wukong',
  name: '悟空',
  aliases: ['WK', '行者'],
  enabled: true,
  description: '主力开发角色，承担核心功能开发、关键重构与疑难缺陷定位，对交付质量负责。',
  prompt: PERSONA,
  channel: { kind: 'acp-cli', channelId: 'ch-codex-main', model: 'deepseek-coder-v3' },
  model: 'deepseek-coder-v3',
  temperature: 0.2,
  maxTokens: 8192,
  topP: 0.95,
  timeoutMs: 600000,
  permissionPreset: 'project-write',
  source: 'global',
}

/**
 * 旧版 dispatch「全量回执」（构造基线 / 模拟）：
 * 瘦身后 register.js 的 dispatch.execute 只保留其中的 taskRef/roleId/roleName/isolation，
 * 这里把瘦身前 dispatcher 原样返回的完整对象作为 A 基线。
 * 同时作为假 dispatcher.dispatch() 的返回值，保证新旧两份回执来自同一份数据。
 */
const DISPATCH_RAW = {
  ok: true,
  taskRef: {
    kind: 'subagent-activation',
    childId: 'child-baseline-0001',
    name: 'agent-wukong-0001',
    provider: 'codex',
    jobId: 'meetingstone-dispatch-0001',
    operationId: 'op-baseline-0001',
    startedAt: 1731312000000,
  },
  role: ROLE_FULL,
  startedAt: 1731312000000,
  isolation: 'worktree',
  operationId: 'op-baseline-0001',
  worktree: {
    path: 'D:/MeetingStone/.meetingstone/worktrees/op-baseline-0001',
    branch: 'meetingstone/op-baseline-0001',
    baseSha: '9f2c1b7a6d4e3f50819c0ba2d6e7f8341c5d0a9b2e',
  },
  contextPack: {
    project: { name: '集合石', workspace: 'D:/MeetingStone' },
    task: { title: '审核登录模块权限边界', objective: '检查越权访问与权限绕过' },
    knownFacts: ['DSH 版本 0.2.2-rc.1', '测试入口 tests/auth/'],
    files: ['src/auth/callback.ts', 'tests/auth/callback.test.ts'],
    doNotRepeat: ['不要重新扫描整个仓库', '不要重复测试正常完成路径'],
  },
}

const TASK_TEXT = buildTaskText()

/** list_roles 的 5 个角色（紧凑 vs verbose）。 */
const ROLES = [
  {
    roleId: 'role-wukong', name: '悟空', aliases: ['WK', '行者'], enabled: true,
    description: '主力开发，承担核心功能开发、关键重构与疑难缺陷定位，对交付质量负责。',
    prompt: '你是悟空，主力开发角色。',
    channel: { kind: 'acp-cli', channelId: 'ch-codex', model: 'deepseek-coder-v3' }, source: 'global',
  },
  {
    roleId: 'role-bajie', name: '八戒', aliases: ['BJ'], enabled: true,
    description: '调研与文档，负责资料检索、方案对比与文档撰写，输出可复核的结论摘要。',
    prompt: '你是八戒，调研与文档角色。',
    channel: { kind: 'acp-cli', channelId: 'ch-claude', model: 'claude-sonnet-4' }, source: 'global',
  },
  {
    roleId: 'role-sashi', name: '沙僧', aliases: ['SS'], enabled: true,
    description: '技术骨干，负责测试、构建校验与问题定位，保证改动可回归、可验证。',
    prompt: '你是沙僧，测试与校验角色。',
    channel: { kind: 'acp-cli', channelId: 'ch-codex', model: 'hy4' }, source: 'global',
  },
  {
    roleId: 'role-tangseng', name: '唐僧', aliases: ['TS'], enabled: true,
    description: '验收与把关，负责范围与边界确认、结果复核与最终签字，守住质量护栏。',
    prompt: '你是唐僧，验收把关角色。',
    channel: { kind: 'acp-cli', channelId: 'ch-codebuddy', model: 'hy4' }, source: 'global',
  },
  {
    roleId: 'role-guangyin', name: '观音', aliases: ['GY'], enabled: false,
    description: '协调与排期，负责任务拆解、并行工作面协调与风险上报，不直接改代码。',
    prompt: '你是观音，协调排期角色。',
    channel: { kind: 'acp-cli', channelId: 'ch-codex', model: 'hy4' }, source: 'project',
  },
]

// ────────────────────────────────────────────────────────────────────────────
// 2. 假 ctx + 假 dispatcher / 假 run-store → 真实工具
// ────────────────────────────────────────────────────────────────────────────

/** @returns {Map<string, any>} 已注册的工具定义 */
function buildTools() {
  /** @type {Map<string, any>} */
  const registered = new Map()
  const fakeCtx = { tools: { register: (spec) => registered.set(spec.name, spec) } }
  const deps = {
    registry: { list: () => ROLES, errors: [] },
    dispatcher: {
      dispatch: async () => DISPATCH_RAW,
      getTask: async (childId) => ({
        childId,
        status: 'completed',
        stopReason: 'completed',
        output: TASK_TEXT,
        result: TASK_TEXT,
        jobId: 'meetingstone-dispatch-0001',
      }),
      cancel: async () => ({ stopConfirmed: false }),
    },
    probe: { probe: async () => ({}), probeAll: async () => [] },
    // 假 run-store：磁盘无记录，get_task 走内存终态（结果稳定、不依赖 cwd）
    loadPersistedRun: async () => null,
  }
  registerTools(fakeCtx, deps)
  return registered
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 度量口径
// ────────────────────────────────────────────────────────────────────────────

/** CJK 表意文字范围（扩展 A / 基本区 / 兼容区），用于正则。 */
const CJK_RANGES = '\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF'
/** 同一范围的人类可读标注（避免把区间字符原样打进 JSON）。 */
const CJK_LABEL = 'U+3400-4DBF / U+4E00-9FFF / U+F900-FAFF'

/** 粗略口径：bytes/4（ASCII）与 CJK 字符数/1 取大者，标注「估算」。 */
function approxTokens(text) {
  const bytes = Buffer.byteLength(text, 'utf8')
  const re = new RegExp(`[${CJK_RANGES}]`, 'g')
  let cjk = 0
  while (re.exec(text) !== null) cjk += 1
  return Math.ceil(Math.max(bytes / 4, cjk))
}

/** 与工具 output.render（renderObject）一致的序列化。 */
function receiptJson(value) {
  return JSON.stringify(value ?? null)
}

/** @returns {{ name: string, bytes: number, approxTokens: number, note: string }} */
function measure(name, value, note) {
  const json = receiptJson(value)
  return {
    name,
    bytes: Buffer.byteLength(json, 'utf8'),
    approxTokens: approxTokens(json),
    note,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 输出
// ────────────────────────────────────────────────────────────────────────────

const DECLARATION = '估算≠真实 Token、Provider Usage 优先；无 Usage 时写「未知」，不用估算数冒充真实 Token。'
const APPROX_NOTE = '估算（非真实 Token）：approxTokens = ceil(max(bytes/4, CJK 字符数/1))。'

/** 终端显示宽度（CJK 按 2 列），保证表格对齐。 */
function displayWidth(s) {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

function pad(s, width) {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}

function printReport(payload) {
  const L = []
  L.push('工具回执字节对照（A/B 基线） · measure-tool-output.mjs')
  L.push('')
  L.push('口径  : bytes = JSON.stringify(value ?? null) 的 UTF-8 字节数（与工具 renderObject 序列化一致）')
  L.push('估算  : ' + APPROX_NOTE)
  L.push('声明  : ' + DECLARATION)
  L.push('样本  : 固定合成场景（3 组 × 旧/新）；非 35 条运行记录，无中位数 / 分布；输出刻意不含时间戳以保证稳定')
  L.push('')

  const headers = ['场景 / 变体', 'bytes', 'approxTokens(估算)', 'note']
  const cols = [
    (r) => r.name,
    (r) => String(r.bytes),
    (r) => String(r.approxTokens),
    (r) => r.note,
  ]
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...payload.rows.map((r) => displayWidth(cols[i](r)))),
  )
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+'
  const fmt = (cells) => '| ' + cells.map((c, i) => pad(c, widths[i])).join(' | ') + ' |'
  L.push(sep)
  L.push(fmt(headers))
  L.push(sep)
  for (const r of payload.rows) L.push(fmt(cols.map((c) => c(r))))
  L.push(sep)

  L.push('')
  L.push('新旧对照（bytes / approxTokens 均为估算对照）')
  for (const c of payload.comparisons) {
    L.push(
      `  ${c.scenario.padEnd(11)} 旧 ${String(c.oldBytes).padStart(6)} B → 新 ${String(c.newBytes).padStart(6)} B` +
        `  ·  省 ${String(c.savedBytes).padStart(6)} B (${String(c.savedPct).padStart(5)}%)` +
        `  ·  估算 ${c.oldApproxTokens} → ${c.newApproxTokens}`,
    )
  }
  L.push('')
  L.push('提示: --json 输出纯 JSON（rows / comparisons / method / declaration），机器可读。')
  process.stdout.write(L.join('\n') + '\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 主流程
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const tools = buildTools()

  // 新机制：真实工具默认输出
  const newDispatch = await tools.get(TOOL_NAMES.DISPATCH).execute(
    { role: 'WK', task: '审核登录模块权限边界' },
    { agent: { session: { header: { cwd: 'D:/MeetingStone' } } } },
  )
  const oldGetTask = await tools.get(TOOL_NAMES.GET_TASK).execute(
    { childId: 'child-baseline-0001', full: true },
  )
  const newGetTask = await tools.get(TOOL_NAMES.GET_TASK).execute(
    { childId: 'child-baseline-0001' },
  )
  const oldListRoles = await tools.get(TOOL_NAMES.LIST_ROLES).execute({ verbose: true })
  const newListRoles = await tools.get(TOOL_NAMES.LIST_ROLES).execute({})

  const rows = [
    measure(
      'dispatch / 旧版全量回执',
      DISPATCH_RAW,
      '构造基线（模拟）：完整 role + 长人设 + 模型参数 + Context Pack + 工作树',
    ),
    measure(
      'dispatch / 新版紧凑回执',
      newDispatch,
      '真实工具：仅 ok / taskRef / roleId / roleName / isolation',
    ),
    measure(
      'get_task / 旧机制默认全文',
      oldGetTask,
      'full:true 等价重建：约 8KB 全文（旧版默认即全文）',
    ),
    measure(
      'get_task / 新机制默认摘要',
      newGetTask,
      `真实工具默认：首 ${TASK_RESULT_HEAD_BYTES}B + 末 ${TASK_RESULT_TAIL_BYTES}B + 截断标记`,
    ),
    measure(
      'list_roles / 旧机制全量详情',
      oldListRoles,
      'verbose:true 等价重建：5 个角色全字段（含 description / channel / model / source）',
    ),
    measure(
      'list_roles / 新机制紧凑',
      newListRoles,
      '真实工具默认：每角色 5 字段（roleId / name / aliases / enabled / availability）',
    ),
  ]

  const pairs = [
    { scenario: 'dispatch', old: rows[0], new: rows[1] },
    { scenario: 'get_task', old: rows[2], new: rows[3] },
    { scenario: 'list_roles', old: rows[4], new: rows[5] },
  ]
  const comparisons = pairs.map((p) => {
    const saved = p.old.bytes - p.new.bytes
    return {
      scenario: p.scenario,
      oldName: p.old.name,
      newName: p.new.name,
      oldBytes: p.old.bytes,
      newBytes: p.new.bytes,
      savedBytes: saved,
      savedPct: p.old.bytes === 0 ? 0 : Number(((saved / p.old.bytes) * 100).toFixed(1)),
      oldApproxTokens: p.old.approxTokens,
      newApproxTokens: p.new.approxTokens,
    }
  })

  const payload = {
    declaration: DECLARATION,
    approxTokensNote: APPROX_NOTE,
    method: {
      bytes: 'Buffer.byteLength(JSON.stringify(value ?? null), "utf8")；与 register.js 的 renderObject 一致',
      approxTokens: `ceil(max(bytes/4, CJK 字符数/1))；CJK = ${CJK_LABEL}；仅为估算，非真实 Token`,
      summaryRule: `get_task 默认首 ${TASK_RESULT_HEAD_BYTES}B + 末 ${TASK_RESULT_TAIL_BYTES}B，full:true 返回全文`,
      fixtures: '固定合成数据：长人设角色派单、约 8KB 任务结果、5 个角色；无时间戳 / 随机值，输出稳定',
      oldVsNew: {
        dispatch: '旧版 = 构造的完整 dispatcher 回执（长人设 / 模型参数 / Context Pack / 工作树）；新版 = 真实工具紧凑回执',
        get_task: '旧机制默认全文 = 当前工具 full:true 输出；新机制 = 当前工具默认摘要',
        list_roles: '旧机制全量详情 = 当前工具 verbose:true 输出；新机制 = 当前工具默认紧凑',
      },
    },
    rows,
    comparisons,
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    printReport(payload)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
