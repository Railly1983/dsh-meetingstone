#!/usr/bin/env node
// @ts-check
/**
 * C2：派单提示词分段测量（只读、可复现）。
 *
 * 用**真实渲染函数**（renderTaskBrief / formatContinuation / renderOutputContract /
 * composePromptWithContinuation / measurePromptSegments）给固定合成样本分段计字节：
 *   persona（稳定前缀）→ taskBrief（L2）→ continuation（L3）→ task → outputContract
 *
 * 口径声明：
 * - bytes = UTF-8 字节数；**不是 Token**。
 * - 不输出 Token 估算、不声称节省比例；Provider Usage 一律「未知」。
 * - 样本为固定合成数据（无时间戳/随机值），输出稳定可复现。
 *
 * 用法：
 *   node scripts/measure-prompt-segments.mjs         # 人类可读
 *   node scripts/measure-prompt-segments.mjs --json  # 机器可读
 */
import { renderTaskBrief } from '../src/taskspec.js'
import { renderOutputContract } from '../src/result-contract.js'
import {
  composePromptWithContinuation,
  formatContinuation,
  measurePromptSegments,
} from '../src/context-replay.js'

const DECLARATION = 'bytes ≠ Token；Provider Usage 未知；不估算 Token、不声明节省比例。'

/** 固定人设样本（短/长两种，覆盖生产 persona 量级差异）。 */
function buildPersona(long = false) {
  const lines = [
    '你是技术骨干，负责主力开发、苦工和各类实现任务。',
    '按任务要求执行，只改被授权的文件；每个结论都要附证据，拿不到就写未验证，不要猜。',
  ]
  if (long) {
    for (let i = 1; i <= 20; i += 1) {
      lines.push(`${i}. 规则样本：提交前自检、最小必要改动、证据优先、不编造未验证结论。`)
    }
  }
  return lines.join('\n')
}

const SPEC = {
  title: 'C2 缓存基线：派单提示词段拆分',
  objective: '测量稳定前缀与动态段的字节构成，验证顺序。',
  scope: { include: ['src/context-replay.js', 'src/dsh/adapter.js'], exclude: ['src/client/**'] },
  acceptance: ['稳定段在动态段之前', '无 continuation 时不出现重放边界'],
  evidence: ['单测输出与字节数'],
  contextRefs: ['docs/design/context-contract.md'],
  artifactPolicy: 'none',
}

const PACK = {
  knownFacts: ['C1 契约已定稿', '顺序：人设→简报→交接→任务→输出契约'],
  files: ['src/context-replay.js', 'src/dsh/adapter.js', 'src/taskspec.js'],
  priorResults: [{ summary: 'C1 定稿，未改代码。' }],
  doNotRepeat: ['不要调换提示词顺序'],
}

const TASK = '请只读核对派单提示词顺序，并按 C1 契约给出偏差清单。'

const FAKE_RUN = {
  childId: 'child-fixture-0001',
  status: 'completed',
  stopReason: 'completed',
  output: '上一轮结论：顺序已正确；证据见 docs/design/context-contract.md。'.repeat(120),
}

/** @param {{ persona: string, continuation?: { text: string } | null, contract: string, task: string }} input */
function fixture(input) {
  return {
    personaHead: '你是「沙僧」。',
    persona: input.persona,
    taskBrief: renderTaskBrief(SPEC, PACK),
    continuation: input.continuation ?? null,
    task: input.task,
    outputContract: input.contract,
  }
}

function printReport(payload) {
  const lines = []
  lines.push('派单提示词分段测量（C2） · measure-prompt-segments.mjs')
  lines.push('')
  lines.push(`口径: ${DECLARATION}`)
  lines.push('样本: 固定合成（短/长人设 × 首轮/续轮；上一轮输出约 8KB）')
  lines.push('')
  for (const row of payload.rows) {
    lines.push(`${row.name}`)
    lines.push(`  顺序: ${row.segments.order.join(' → ')}`)
    lines.push(
      `  字节: ${Object.entries(row.segments.bytes)
        .map(([key, value]) => `${key}=${value}`)
        .join(' / ')}`,
    )
    lines.push(`  稳定前缀: ${row.segments.stablePrefixBytes} B（persona；同角色跨任务一致）`)
    lines.push('')
  }
  lines.push('说明: 稳定前缀只有 persona；输出契约虽稳定但固定收尾，不参与前缀缓存（C1 要求）。')
  lines.push('提示: --json 输出纯 JSON（rows / declaration / method），机器可读。')
  process.stdout.write(`${lines.join('\n')}\n`)
}

function main() {
  const shortPersona = buildPersona(false)
  const longPersona = buildPersona(true)
  const continuation = formatContinuation(FAKE_RUN)
  const contract = renderOutputContract('runs')
  const fixtures = [
    { name: '首轮 / 短人设', input: fixture({ persona: shortPersona, contract, task: TASK }) },
    { name: '首轮 / 长人设', input: fixture({ persona: longPersona, contract, task: TASK }) },
    {
      name: '续轮 / 长人设 + 交接块',
      input: fixture({ persona: longPersona, continuation, contract: renderOutputContract('none'), task: TASK }),
    },
  ]
  const rows = fixtures.map(({ name, input }) => {
    const segments = measurePromptSegments(input)
    return {
      name,
      segments,
      textBytes: Buffer.byteLength(composePromptWithContinuation(input), 'utf8'),
    }
  })
  const payload = {
    declaration: DECLARATION,
    method: {
      bytes: 'Buffer.byteLength(string, "utf8")',
      segments: 'src/context-replay.js measurePromptSegments（与 composePromptWithContinuation 同规则）',
      fixtures: '固定合成：短/长人设、TaskSpec+ContextPack、约 8KB 上一轮输出；无时间戳/随机值',
    },
    rows,
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  printReport(payload)
}

main()
