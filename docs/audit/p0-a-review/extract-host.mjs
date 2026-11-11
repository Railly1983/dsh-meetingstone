// Read-only extraction of installed host evidence. No profile or host file changes.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const path=process.argv[2] ?? resolve(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/app.asar')
const b=readFileSync(path), size=b.readUInt32LE(12)
const header=JSON.parse(b.subarray(16,16+size).toString('utf8'))
const dir=fileURLToPath(new URL('.',import.meta.url))
for (const [inner,output] of [
  ['dsh-jobs-local/lib/index.js','host-jobs.js'],
  ['dsh-client-ui-jobs/lib/client.js','host-jobs-client.js'],
  ['dsh-jobs/README.zh.md','host-contract.md'],
  ['dsh-client-ui-jobs/README.zh.md','host-jobs-readme.md'],
]) {
  let node=header
  for(const segment of `dsh/node_modules/@deepseek-ai/${inner}`.split('/')) node=node?.files?.[segment]
  if(!node || node.offset === undefined || node.unpacked) throw Error(`cannot extract ${inner}`)
  const start=16+size+Number(node.offset)
  const bytes=b.subarray(start,start+Number(node.size))
  writeFileSync(resolve(dir,output),bytes)
  console.log(output,`bytes=${bytes.length}`,`sha256=${createHash('sha256').update(bytes).digest('hex')}`)
}
console.log('source',path)
