// @ts-check
/**
 * P0-U0 只读取证脚本：从本机 app.asar 读宿主 GUI 实现，打印结论对应的源码片段。
 *
 * 用法：
 *   node docs/audit/p0-u0-review/extract-evidence.mjs            # 全部结论
 *   node docs/audit/p0-u0-review/extract-evidence.mjs button     # 只看某节
 *
 * 只读 app.asar，不写 profile、不改宿主文件；输出即 evidence.md 的命令来源。
 * 行号对应当前安装的 0.2.2-rc.1 构建；升级宿主后需重跑并复核。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'

const ASAR =
  process.env.DSH_ASAR ??
  join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar')
const only = process.argv[2]

const buf = readFileSync(ASAR)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

/** @param {string} inner @returns {string | null} */
function read(inner) {
  let node = header
  for (const segment of inner.split('/')) node = node?.files?.[segment]
  if (!node || node.size === undefined) return null
  if (node.unpacked) return readFileSync(join(dirname(ASAR), 'app.asar.unpacked', inner))
  return buf.subarray(base + Number(node.offset), base + Number(node.offset) + Number(node.size)).toString('utf8')
}

/** @param {string} inner @param {number} from @param {number} to @param {string} label */
function lines(inner, from, to, label) {
  const text = read(inner)
  if (text === null) throw new Error(`not found: ${inner}`)
  console.log(`\n### ${label}\n# ${inner}:${from}-${to}`)
  text
    .split(/\r?\n/)
    .slice(from - 1, to)
    .forEach((line, index) => console.log(`${String(from + index).padStart(5)}: ${line}`))
}

console.log(`asar: ${ASAR}`)
console.log(`sha256: ${createHash('sha256').update(buf).digest('hex')}`)
console.log(`bytes: ${buf.length}`)
let pkg = header
for (const segment of 'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives'.split('/')) pkg = pkg?.files?.[segment]
console.log(`primitives package in node_modules: ${pkg?.size !== undefined}`)

const bundle = read('dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js')
if (bundle === null) throw new Error('web frontend bundle not found')
const start = bundle.indexOf('const FU=Object.freeze(Object.defineProperty({__proto__:null,')
const end = bundle.indexOf('},Symbol.toStringTag', start)
const exportsList = [...bundle.slice(start, end).matchAll(/(?:^|,)([A-Za-z_$][\w$]*):/g)].map((m) => m[1])
console.log(`\nprimitives exports: ${exportsList.length}`)
console.log(
  `absent: ${['Icon', 'Select', 'Popover', 'Dropdown', 'IconButton']
    .map((name) => `${name}=${exportsList.includes(name)}`)
    .join(' ')}`,
)
console.log(
  `icons: ${exportsList.filter((name) => /^IconUsers|^IconUser/.test(name)).join(', ')}`,
)

const sections = {
  moduleTable: () => {
    console.log(bundle.slice(bundle.indexOf('function YZ()') - 40, bundle.indexOf('function YZ()') + 500))
  },
  button: () => console.log(bundle.slice(bundle.indexOf('const vi=k.forwardRef'), bundle.indexOf('const vi=k.forwardRef') + 700)),
  switch: () => console.log(bundle.slice(bundle.indexOf('function YD('), bundle.indexOf('function YD(') + 520)),
  tooltip: () => console.log(bundle.slice(bundle.indexOf('function Mn('), bundle.indexOf('function Mn(') + 650)),
  toast: () => console.log(bundle.slice(bundle.indexOf('function sA('), bundle.indexOf('function sA(') + 700)),
  modal: () => console.log(bundle.slice(bundle.indexOf('function wy('), bundle.indexOf('function wy(') + 900)),
  icon: () => console.log(bundle.slice(bundle.indexOf('function M(e,t)'), bundle.indexOf('function M(e,t)') + 260)),
  header: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', 22916, 22957, 'header.actions declaration'),
  headerRegistrant: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js', 1247, 1272, 'header action inject(sessionId)'),
  settingsSection: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', 1547, 1562, 'settings.section declaration'),
  settingsRegistrant: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js', 255, 266, 'settings.section inject()'),
  sidebarDecl: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js', 5667, 5716, 'sidebar pane slot declaration'),
  sidebarInject: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js', 2138, 2142, 'sidebar pane inject(sessionId, actions)'),
  sidebarParams: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js', 2183, 2195, 'tab params revision'),
  planParams: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-plan/lib/client.js', 177, 182, 'read useTabInfo().tab.navigation.params'),
  priority: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js', 4834, 4846, 'priority bands'),
  crash: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', 631, 645, 'slot entry crash boundary'),
  i18n: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js', 1675, 1716, 'locale register/bind'),
  theme: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js', 1779, 1877, 'token inspect list'),
  practices: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md', 34, 35, 'official UI rules'),
  pluginButton: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js', 4586, 4595, 'Button minimal usage'),
  switchUsage: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', 713, 726, 'Switch minimal usage'),
  modelMenu: () =>
    lines('dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js', 1522, 1569, 'MenuSurface model/effort picker'),
}

for (const [name, run] of Object.entries(sections)) {
  if (only && name !== only) continue
  run()
}
