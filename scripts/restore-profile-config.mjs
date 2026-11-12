/** 恢复 profile 里 meetingstone 行的 channels/roles（安装器可能清空或删掉该行）。 */
import { readFileSync } from 'node:fs'
import { meetingstoneRow, readPatch, writePatch } from './patch-config.mjs'

const project = JSON.parse(readFileSync('D:/MeetingStone/.meetingstone.json', 'utf8'))

const channels = [
  {
    channelId: 'ch-codex-astra',
    description: 'Codex · gpt-6-astra（唐僧专用）',
    kind: 'codex',
    provider: 'codex',
    model: 'gpt-6-astra',
  },
  {
    channelId: 'ch-codex-sol',
    description: 'Codex · gpt-6.1-sol（悟空专用）',
    kind: 'codex',
    provider: 'codex-sol',
    model: 'gpt-6.1-sol',
  },
  { channelId: 'ch-acp-flash', description: 'CodeBuddy · flash（沙僧）', kind: 'acp-cli', provider: 'acp' },
  { channelId: 'ch-acp-hy4', description: 'CodeBuddy · hy3（小白）', kind: 'acp-cli', provider: 'acp-hy4' },
  { channelId: 'ch-inprocess', description: 'DSH 原生子 Agent（八戒）', kind: 'in-process', provider: 'spawn' },
]

const roles = project.roles
  .filter((role) => role.roleId !== 'role-kimi')
  .map((role) => ({
    roleId: role.roleId,
    name: role.name,
    aliases: role.aliases ?? [],
    description: role.description ?? '',
    prompt: role.prompt ?? '',
    channel: role.channel ?? {},
    enabled: role.enabled !== false,
    timeoutMs: role.timeoutMs,
  }))

const doc = readPatch()
let row = meetingstoneRow(doc)
if (!row) {
  row = { id: 'meetingstone', name: 'dsh-meetingstone', config: {} }
  doc.push(row)
  console.log('inserted missing meetingstone row')
}
row.config = {
  ...(row.config ?? {}),
  channels,
  roles,
}
writePatch(doc)
console.log(`restored: channels=${channels.length} roles=${roles.length} rows=${doc.length}`)
