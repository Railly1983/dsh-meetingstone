// @ts-check
/**
 * 从 app.asar 里提取单个文件到临时目录，用于排查宿主实现（只读诊断工具）。
 *
 * asar 格式：8 字节 pickle 头 + UInt32 headerSize + header JSON + 文件数据。
 * 用法：node scripts/asar-extract.mjs <asar路径> <内部路径> [输出文件]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [, , asarPath, innerPath, outPath] = process.argv

if (!asarPath || !innerPath) {
  console.error('用法: node scripts/asar-extract.mjs <app.asar> <node_modules/xxx/lib/index.js> [out]')
  process.exit(1)
}

const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(12)
const headerJson = buf.subarray(16, 16 + headerSize).toString('utf8')
const header = JSON.parse(headerJson)
const baseOffset = 16 + headerSize

/** 递归按路径找节点。 */
function find(node, parts) {
  let cur = node
  for (const part of parts) {
    if (!cur || !cur.files || !cur.files[part]) return null
    cur = cur.files[part]
  }
  return cur
}

const normalized = innerPath.replace(/\\/g, '/').replace(/^\//, '')
const node = find(header, normalized.split('/'))
if (!node || typeof node.offset !== 'string' && typeof node.offset !== 'number') {
  console.error(`未找到：${normalized}`)
  process.exit(1)
}
if (!('size' in node)) {
  console.error(`目标是目录，不是文件：${normalized}`)
  process.exit(1)
}

const start = baseOffset + Number(node.offset)
const data = buf.subarray(start, start + Number(node.size))
const target = outPath || `${process.env.TEMP || '/tmp'}/asar-${normalized.split('/').pop()}`
writeFileSync(target, data)
console.log(`extracted ${normalized} -> ${target} (${data.length} bytes)`)
