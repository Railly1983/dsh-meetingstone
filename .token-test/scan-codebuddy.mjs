#!/usr/bin/env node
// 只读扫描 CodeBuddy 会话日志（~/.codebuddy/projects/<proj>/<session>.jsonl），
// 聚合真实 provider usage：prompt_tokens / cached_tokens / completion_tokens。
// 每个 API 调用 = 一条带 providerData.rawUsage 的记录（messageId 唯一）。
// 用法: node scan-codebuddy.mjs [--root dir] [--project substr] [--since ms] [--json]
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const root = flag('--root', join(homedir(), '.codebuddy', 'projects'))
const projectFilter = flag('--project', null)
const since = flag('--since', null) === null ? null : Number(flag('--since', null))
const json = argv.includes('--json')
const collectCalls = argv.includes('--calls')

if (!existsSync(root)) { console.error('no such root: ' + root); process.exit(2) }

const rows = []
for (const proj of readdirSync(root)) {
  if (!proj.includes('MeetingStone') && !(projectFilter && proj.includes(projectFilter))) continue
  const dir = join(root, proj)
  if (!statSync(dir).isDirectory()) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    const mtime = statSync(file).mtimeMs
    if (since !== null && mtime < since) continue
    const calls = []
    const toolCounts = {}
    let sessionId = name.replace(/\.jsonl$/, '')
    let title = null
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.sessionId) sessionId = e.sessionId
      if (e.type === 'ai-title' && e.title) title = e.title
      const pd = e.providerData
      const ru = pd?.rawUsage
      if (ru) {
        calls.push({
          msgId: pd.messageId,
          step: pd.stepSeq,
          model: pd.model,
          prompt: ru.prompt_tokens ?? 0,
          completion: ru.completion_tokens ?? 0,
          cached: ru.prompt_tokens_details?.cached_tokens ?? 0,
          at: e.timestamp ?? null,
        })
      }
      const tn = pd?.toolName ?? e.toolName
      if (tn) toolCounts[tn] = (toolCounts[tn] ?? 0) + 1
    }
    if (calls.length === 0) continue
    const seen = new Set()
    const uniq = calls.filter((c) => {
      const key = c.msgId ?? `${c.step}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const sum = (k) => uniq.reduce((s, c) => s + c[k], 0)
    const prompt = sum('prompt')
    const cached = sum('cached')
    const completion = sum('completion')
    rows.push({
      project: proj, sessionId, title, file: name,
      requests: uniq.length,
      promptTokens: prompt,
      cachedTokens: cached,
      uncachedTokens: prompt - cached,
      completionTokens: completion,
      totalTokens: prompt + completion,
      cacheHitRate: prompt > 0 ? cached / prompt : null,
      callList: uniq,
      models: [...new Set(uniq.map((c) => c.model).filter(Boolean))],
      firstAt: uniq[0]?.at ?? null,
      lastAt: uniq[uniq.length - 1]?.at ?? null,
      spanMs: uniq[0]?.at && uniq[uniq.length - 1]?.at ? uniq[uniq.length - 1].at - uniq[0].at : null,
      toolCounts,
    })
  }
}
rows.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

if (json) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  if (rows.length === 0) console.log('(no CodeBuddy session files matched)')
  for (const r of rows) {
    console.log([
      `${r.project.slice(-24)}`.padEnd(26),
      r.sessionId.slice(0, 8),
      `req=${String(r.requests).padStart(3)}`,
      `prompt=${String(r.promptTokens).padStart(8)}`,
      `uncached=${String(r.uncachedTokens).padStart(8)}`,
      `cached=${String(r.cachedTokens).padStart(8)}`,
      `out=${String(r.completionTokens).padStart(6)}`,
      `hit=${(r.cacheHitRate === null ? 'n/a' : (r.cacheHitRate * 100).toFixed(1) + '%').padStart(6)}`,
      `span=${r.spanMs === null ? 'n/a' : (r.spanMs / 1000).toFixed(0) + 's'}`.padEnd(10),
      `tools=${JSON.stringify(r.toolCounts)}`,
      `model=${r.models.join(',')}`,
    ].join(' '))
    if (collectCalls) {
      for (const c of r.callList ?? []) {
        console.log(`    #${String(c.step).padStart(2)} prompt=${String(c.prompt).padStart(7)} cached=${String(c.cached).padStart(7)} uncached=${String(c.prompt - c.cached).padStart(7)} out=${String(c.completion).padStart(5)}`)
      }
    }
  }
}
