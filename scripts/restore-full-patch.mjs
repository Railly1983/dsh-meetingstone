/** 恢复被插件安装器清掉的 provider/ui insert 行（从 17:26 的完整备份合并），保留当前 meetingstone config。 */
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { meetingstoneRow, readPatch, writePatch } from './patch-config.mjs'

const BACKUP = 'C:/Users/30673/.dsh/profiles/desktop/cordis.patch.yml.bak-1794444780504'
const backup = YAML.parse(readFileSync(BACKUP, 'utf8'))
const current = readPatch()
const currentRow = meetingstoneRow(current)
const currentConfig = currentRow?.config ?? {}

const merged = []
for (const row of backup) {
  if (!row) continue
  if (row.id) {
    // 保留当前版本里同 id 的 ui 行（用户设置），其余从备份恢复
    const live = current.find((r) => r && r.id === row.id)
    merged.push(live ?? row)
  } else if (row.insert) {
    merged.push(row)
  }
}

// 合并当前里新增、备份没有的行（如新 ui 设置）
for (const row of current) {
  if (!row) continue
  if (row.id && !merged.some((r) => r && r.id === row.id)) merged.push(row)
  if (row.insert) {
    const existing = new Set(
      merged.filter((r) => r && r.insert).flatMap((r) => r.insert.map((i) => i && i.id)),
    )
    const extra = row.insert.filter((i) => i && !existing.has(i.id))
    if (extra.length) merged.push({ insert: extra })
  }
}

// meetingstone config 用当前值（channels/roles 已经恢复过）
let ms = merged.find((r) => r && r.id === 'meetingstone')
if (!ms) {
  ms = { id: 'meetingstone', name: 'dsh-meetingstone', config: {} }
  merged.push(ms)
}
ms.config = currentConfig

// hy4 模型改 hy3
for (const r of merged) {
  if (!r || !r.insert) continue
  for (const i of r.insert) {
    if (i && i.id === 'subagent-acp-hy4') {
      const args = i.config?.args
      const idx = Array.isArray(args) ? args.indexOf('--model') : -1
      if (idx >= 0) args[idx + 1] = 'hy3'
    }
  }
}

// 确保 kimi provider 行存在
const hasKimi = merged.some(
  (r) => r && r.insert && r.insert.some((i) => i && i.id === 'subagent-acp-kimi'),
)
if (!hasKimi) {
  merged.push({
    insert: [
      {
        id: 'subagent-acp-kimi',
        name: '@deepseek-ai/dsh-subagent-acp',
        config: {
          providerName: 'acp-kimi',
          command: 'C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe',
          args: [
            'C:/Users/30673/AppData/Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy',
            '--acp',
            '--permission-mode',
            'acceptEdits',
            '--model',
            'kimi-k3.1-pro',
            '--effort',
            'high',
          ],
          permission: 'allow',
        },
      },
    ],
  })
}

writePatch(merged)
console.log('rows:', merged.length)
for (const r of merged) {
  if (r.id) console.log(' id:', r.id)
  if (r.insert) for (const i of r.insert) console.log('   insert:', i.id)
}
