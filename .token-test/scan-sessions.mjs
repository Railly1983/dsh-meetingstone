#!/usr/bin/env node
// 只读扫描 DSH 会话日志，统计每个会话的真实 provider usage（四桶）与 subagent 标签。
// 用法: node scan-sessions.mjs [--root <sessionsRoot>] [--workspace <dirName>] [--json]
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressAll(buf) {
  const idx = []
  let p = 0
  while ((p = buf.indexOf(MAGIC, p)) !== -1) { idx.push(p); p += 4 }
  const out = []
  for (let i = 0; i < idx.length; i++) {
    const frame = buf.subarray(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length)
    try { out.push(zlib.zstdDecompressSync(frame)) } catch { /* tail frame may be partial */ }
  }
  return Buffer.concat(out)
}

function usageOf(e) {
  if (e?.data?.usage) return e.data.usage
  if (Array.isArray(e?.data?.stream)) {
    for (let i = e.data.stream.length - 1; i >= 0; i--) {
      const c = e.data.stream[i]?.chunk
      if (c?.type === 'usage' && c.usage) return c.usage
    }
  }
  return undefined
}

function buckets(u) {
  return {
    uncachedInput: u.inputTokens ?? u.input_tokens ?? 0,
    output: u.outputTokens ?? u.output_tokens ?? 0,
    cacheRead: u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? 0,
  }
}

function scanSession(file, collectCalls = false) {
  const lines = decompressAll(readFileSync(file)).toString('utf8').split('\n').filter(Boolean)
  const info = {
    sessionId: null, createdAt: null, isSeeded: null, parentSession: null,
    labels: [], calls: 0, buckets: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    perLabel: {}, modelIds: new Set(), firstCall: null, lastCall: null, eventCount: lines.length,
    types: {}, callList: [],
  }
  let currentLabel = null
  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    info.types[e.type] = (info.types[e.type] ?? 0) + 1
    if (e.type === 'session') {
      info.sessionId = e.sessionId ?? e.data?.sessionId ?? null
      info.createdAt = e.createdAt ?? null
      info.isSeeded = e.isSeeded ?? null
      info.parentSession = e.parentSession ?? null
    }
    if (e.type === 'subagent/descriptor' && e.data?.label) {
      currentLabel = e.data.label
      info.labels.push(e.data.label)
    }
    if (e.type !== 'assistant/message' && e.type !== 'assistant/attempt') continue
    const u = usageOf(e)
    if (!u) continue
    const b = buckets(u)
    info.calls += 1
    for (const k of Object.keys(b)) info.buckets[k] += b[k]
    const key = currentLabel ?? '(main)'
    info.perLabel[key] ??= { calls: 0, total: 0, cacheRead: 0, uncachedInput: 0, output: 0 }
    info.perLabel[key].calls += 1
    info.perLabel[key].total += b.uncachedInput + b.output + b.cacheRead + b.cacheWrite
    info.perLabel[key].cacheRead += b.cacheRead
    info.perLabel[key].uncachedInput += b.uncachedInput
    info.perLabel[key].output += b.output
    const model = u.model ?? e.data?.model ?? e.data?.message?.model
    if (model) info.modelIds.add(model)
    if (!info.firstCall) info.firstCall = { at: e.time ?? null, total: b.uncachedInput + b.output + b.cacheRead + b.cacheWrite }
    info.lastCall = { at: e.time ?? null, total: b.uncachedInput + b.output + b.cacheRead + b.cacheWrite }
    if (collectCalls) {
      info.callList.push({
        idx: info.callList.length + 1,
        at: e.time ?? null,
        turn: e.data?.turn ?? null,
        step: e.data?.step ?? null,
        uncached: b.uncachedInput,
        cacheRead: b.cacheRead,
        output: b.output,
      })
    }
  }
  info.modelIds = [...info.modelIds]
  info.total = info.buckets.uncachedInput + info.buckets.output + info.buckets.cacheRead + info.buckets.cacheWrite
  info.cacheHitRate = info.total > 0 ? info.buckets.cacheRead / (info.buckets.cacheRead + info.buckets.uncachedInput) : null
  return info
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const root = flag('--root', join(homedir(), '.dsh', 'sessions'))
const ws = flag('--workspace', '--D-MeetingStone--')
const json = argv.includes('--json')
const dir = join(root, ws)
if (!existsSync(dir)) { console.error('no such dir: ' + dir); process.exit(2) }

const results = []
const collectCalls = argv.includes('--calls')
const labelFilter = flag('--label', null)
for (const name of readdirSync(dir)) {
  const file = join(dir, name, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) continue
  try {
    const info = scanSession(file, collectCalls)
    info.dir = name
    results.push(info)
  } catch (error) {
    results.push({ dir: name, error: String(error?.message ?? error) })
  }
}
results.sort((a, b) => (b.lastCall?.at ?? 0) - (a.lastCall?.at ?? 0))
if (json) {
  console.log(JSON.stringify(results.map((r) => ({ ...r, types: undefined })), null, 2))
} else {
  for (const r of results) {
    if (r.error) { console.log(`${r.dir}: ERROR ${r.error}`); continue }
    if (labelFilter && !r.labels.some((l) => l.includes(labelFilter))) continue
    const labels = r.labels.length ? r.labels.join(' | ') : '(main)'
    const t0 = r.firstCall?.at ?? 0
    const t1 = r.lastCall?.at ?? 0
    console.log([
      r.dir.slice(0, 36).padEnd(38),
      `calls=${String(r.calls).padStart(4)}`,
      `uncached=${String(r.buckets.uncachedInput).padStart(9)}`,
      `cacheRead=${String(r.buckets.cacheRead).padStart(10)}`,
      `out=${String(r.buckets.output).padStart(7)}`,
      `hit=${(r.cacheHitRate === null ? 'n/a' : (r.cacheHitRate * 100).toFixed(1) + '%').padStart(6)}`,
      `total=${String(r.total).padStart(10)}`,
      `span=${t0 && t1 ? ((t1 - t0) / 1000).toFixed(1) + 's' : 'n/a'}`,
      `labels=${labels}`,
    ].join(' '))
    if (collectCalls && r.callList) {
      for (const c of r.callList) {
        console.log(`    #${String(c.idx).padStart(2)} turn=${c.turn} step=${c.step} uncached=${String(c.uncached).padStart(6)} cacheRead=${String(c.cacheRead).padStart(7)} out=${String(c.output).padStart(5)}`)
      }
    }
  }
}
