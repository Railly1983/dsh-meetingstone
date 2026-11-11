// @ts-check
/**
 * 宿主 GUI 契约 stub 测试（P0-U0 + U1a 合规化）。
 *
 * 真实 primitives 不是本机 node_modules 里的包，而是 Web bundle 的共享模块
 * （`window.__ModuleLoader__` 的 require 表把 `@deepseek-ai/dsh-client-ui-primitives`
 * 映射到 bundle 内对象），Node 侧无法直接 import。本测试用
 * `tests/fixtures/gui-primitives-contract.json`（从本机 0.2.2-rc.1 只读取证）
 * 作为契约，验证四件事：
 *
 * 1. 契约事实：Button/Switch/Tooltip/Toast/Modal 的 props、图标名、缺失导出
 *    （Icon/Select/Popover/Dropdown/IconButton/users-round）与源码一致；
 * 2. stub 组件按契约接受最小 props（Button variant/size/icon/aria、Switch 受控、
 *    Tooltip 单子元素、Toast text/onDone、Icon size/className）；
 * 3. `src/client/index.js` **不再 require primitives**：用“require 即抛错”的 loader
 *    执行浏览器 half，header/section/sidebar 仍完成注册；header 用内联 SVG，
 *    Tag 是本地实现；侧栏只读调 strict `getSessionConfig`；
 * 4. 源码审计：无 `require('@deepseek-ai/dsh-client-ui-primitives')`、无
 *    `primitives.*`、priority 是字符串档位。
 *
 * 不覆盖：真实 Host 渲染、真实 CSS token 计算、真机点击。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const contract = JSON.parse(
  await readFile(join(ROOT, 'tests/fixtures/gui-primitives-contract.json'), 'utf8'),
)

/** 允许的 Button variant/size；来源见 contract.button。 */
const VARIANTS = contract.button.variants
const SIZES = contract.button.sizes

/**
 * 按契约构造 primitives stub；每个组件记录调用并断言收到的 props 在契约内。
 * 这不是宿主实现，只是“props 形状”的可执行契约（本插件自身不再使用该包）。
 */
function createPrimitivesStub() {
  const calls = { Button: [], Switch: [], Tooltip: [], Toast: [], Icon: [] }

  function Button(props) {
    const variant = props.variant ?? contract.button.defaultVariant
    const size = props.size ?? contract.button.defaultSize
    assert.ok(VARIANTS.includes(variant), `Button.variant 必须是 ${VARIANTS.join('|')}，收到 ${variant}`)
    assert.ok(SIZES.includes(size), `Button.size 必须是 ${SIZES.join('|')}，收到 ${size}`)
    // 原生 button props（aria-*/disabled/title/onClick）原样透传。
    const { variant: _v, size: _s, icon, className, children, ...native } = props
    calls.Button.push({ variant, size, hasIcon: icon !== undefined, native })
    return {
      type: 'button',
      props: { ...native, className, 'data-variant': variant, 'data-size': size, children: [icon, children] },
    }
  }

  function Switch(props) {
    assert.equal(typeof props.checked, 'boolean', 'Switch.checked 必须是布尔（受控）')
    assert.equal(typeof props.onChange, 'function', 'Switch 必须提供 onChange(next)')
    assert.ok(props.onChange.length <= 1, 'Switch.onChange 只接收 next')
    if (props.disabled !== undefined) assert.equal(typeof props.disabled, 'boolean')
    calls.Switch.push(props)
    return {
      type: 'button',
      props: {
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        title: props.title,
        disabled: props.disabled,
      },
    }
  }

  function Tooltip(props) {
    assert.ok(
      typeof props.label === 'string' || typeof props.label === 'function',
      'Tooltip.label 必须是 string 或 () => string',
    )
    assert.ok(props.children, 'Tooltip 需要一个可接 ref 的子元素')
    calls.Tooltip.push(props)
    return props.children
  }

  function Toast(props) {
    assert.equal(typeof props.text, 'string', 'Toast.text 必须是字符串')
    calls.Toast.push(props)
    return { type: 'div', props: { role: 'alert', children: props.text } }
  }

  function IconUsersOutlineRegular(props) {
    assert.ok(props.size === undefined || typeof props.size === 'number')
    assert.ok(props.className === undefined || typeof props.className === 'string')
    calls.Icon.push(props)
    return { type: 'svg', props: { width: props.size ?? 16, height: props.size ?? 16, 'aria-hidden': 'true' } }
  }

  function Tag(props) {
    assert.ok(contract.tagTones.includes(props.tone ?? 'outline'), `Tag.tone 必须是 ${contract.tagTones.join('|')}`)
    return { type: 'span', props: { 'data-tone': props.tone ?? 'outline', children: props.children } }
  }

  return { calls, Button, Switch, Tooltip, Toast, IconUsersOutlineRegular, Tag }
}

test('契约：primitives 导出面与缺失项（Icon/Select/Popover/Dropdown/IconButton）', () => {
  assert.ok(contract.exports.length >= 250, '导出表应来自完整 bundle 反查')
  for (const name of [
    'Button',
    'Switch',
    'Tooltip',
    'Toast',
    'Modal',
    'Menu',
    'MenuGroup',
    'MenuItemButton',
    'MenuSurface',
    'HoverCard',
    'Tag',
    'StateDot',
    'IconUsersOutlineRegular',
    'IconUsersOutlineMedium',
    'IconUserOutlineRegular',
    'IconUserOutlineMedium',
  ]) {
    assert.ok(contract.exports.includes(name), `官方导出缺少 ${name}`)
  }
  for (const name of ['Icon', 'Select', 'Popover', 'Dropdown', 'IconButton', 'ToastProvider', 'useToast']) {
    assert.ok(!contract.exports.includes(name), `${name} 不应出现在导出表中`)
    assert.ok(contract.absent.includes(name), `${name} 必须记录为不可用项`)
  }
  assert.equal(contract.switch.controlledOnly, true)
  assert.equal(contract.composition.tooltipWrapsSwitch, false, 'Switch 非 forwardRef，不能直接塞进 Tooltip')
  assert.deepEqual(contract.icons.users, ['IconUsersOutlineRegular', 'IconUsersOutlineMedium'])
  assert.ok(!contract.icons.users.some((name) => /users-round/.test(name)), '不存在 users-round 图标')
})

test('stub：Button/Switch/Tooltip/Toast/Icon 按已核验 props 接受最小用法', () => {
  const stub = createPrimitivesStub()

  const button = stub.Button({
    variant: 'outline',
    size: 'sm',
    icon: stub.IconUsersOutlineRegular({ size: 13 }),
    'aria-label': '管理角色',
    disabled: true,
    onClick: () => {},
    children: '更新',
  })
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-label'], '管理角色', 'aria-* 必须透传到原生 button')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['data-variant'], 'outline')
  assert.equal(button.props['data-size'], 'sm')
  assert.equal(stub.calls.Button[0].hasIcon, true)

  let next = null
  const sw = stub.Switch({
    checked: true,
    label: '角色可用',
    disabled: false,
    onChange: (value) => {
      next = value
    },
  })
  assert.equal(sw.props.role, 'switch')
  assert.equal(sw.props['aria-checked'], true)
  assert.equal(sw.props['aria-label'], '角色可用')
  stub.calls.Switch[0].onChange(false)
  assert.equal(next, false, 'Switch 点击应回传 !checked')

  const tip = stub.Tooltip({ label: '提示', side: 'top', children: button })
  assert.equal(tip, button, 'Tooltip 返回其唯一子元素')

  const toast = stub.Toast({ text: '已保存', onDone: () => {} })
  assert.equal(toast.props.role, 'alert')
  assert.equal(stub.calls.Toast[0].text, '已保存')

  const icon = stub.IconUsersOutlineRegular({ size: 16, className: 'x' })
  assert.equal(icon.props['aria-hidden'], 'true', '图标必须 aria-hidden，可访问名由外层 button 提供')
  assert.equal(icon.props.width, 16)
})

/** 极简 React：组件不重渲染，只支持 useState/useEffect/useId。 */
function fakeReact() {
  return {
    useState(initial) {
      return [initial, () => {}]
    },
    useEffect() {},
    useId: () => 'stub-id',
    createElement: (type, props) => ({ type, props }),
  }
}

/** 用假 loader/require/ctx 执行浏览器 half；primitives 一律“require 即抛错”。 */
async function loadClientWithoutPrimitives() {
  const registrations = []
  const mounted = []
  const logs = []
  const sessionCalls = []
  const fakeRequire = (name) => {
    if (name === 'react/jsx-runtime') {
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    }
    if (name === 'react') return fakeReact()
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      throw new Error('U1a: client must not require primitives')
    }
    if (name === 'zod') return { z }
    throw new Error(`stub require: unexpected module ${name}`)
  }

  let captured = null
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } }
  try {
    const source = pathToFileURL(join(ROOT, 'src/client/index.js')).href
    await import(`${source}?stub=${Math.random()}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.equal(captured?.id, 'dsh-meetingstone')

  const exports = captured.factory(fakeRequire)
  const ctx = {
    effect(fn) {
      return fn()
    },
    get(key) {
      if (key === 'remote.meetingstone') {
        return {
          async list() {
            return { ok: true, value: { roles: [], channels: [], lastError: null } }
          },
          async getSessionConfig(sessionId) {
            sessionCalls.push(sessionId)
            return {
              ok: true,
              value: {
                effective: {
                  roles: [
                    {
                      roleId: 'role-sashi',
                      name: '沙僧',
                      aliases: ['SS'],
                      channel: { channelId: 'ch-acp-flash', provider: 'acp', model: 'flash-1' },
                    },
                  ],
                  defaultRoleId: 'role-sashi',
                },
                overrides: {},
                sources: { roles: { 'role-sashi': { layer: 'global' } }, defaultRoleId: 'global' },
              },
            }
          },
        }
      }
      if (key === 'sidebarRight') return { openTab() {} }
      if (key === 'sidebarRightTabs') return { register: () => () => {} }
      return undefined
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    remote: {
      async $mount(contribution) {
        mounted.push(contribution)
        return async () => {}
      },
    },
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
      error: (line) => logs.push(['error', line]),
    },
  }

  await exports.apply(ctx)
  return { exports, registrations, mounted, logs, sessionCalls }
}

/** 在 stub JSX 树里找 svg（stub 不执行函数组件，展开一次）。 */
function findSvg(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'svg') return node
  if (typeof node.type === 'function' && node.props?.children === undefined) {
    return findSvg(node.type(node.props))
  }
  const children = node.props?.children
  const list = Array.isArray(children) ? children : children ? [children] : []
  for (const child of list) {
    const found = findSvg(child)
    if (found) return found
  }
  return null
}

test('Browser half：不 require primitives 也能完成注册，header 用内联 SVG', async () => {
  const { registrations, mounted, logs, sessionCalls } = await loadClientWithoutPrimitives()
  assert.equal(mounted.length, 1, 'Remote contribution 仍应挂载')
  assert.equal(mounted[0].descriptors.length, 4, 'list + 三个 strict 会话方法')

  const names = registrations.map((entry) => entry.options.name)
  assert.deepEqual(names, [
    'conversation.session.header.actions',
    'settings.section',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])

  const header = registrations[0]
  const props = header.options.inject('sess-1')
  assert.equal(props.sessionId, 'sess-1')
  const tree = header.Component(props)
  const button = tree.props.children.find((child) => child && child.type === 'button')
  assert.ok(button, 'HeaderEntry 仍渲染 button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-label'], 'headerTitle')
  assert.equal(button.props.title, 'headerDesc')
  const svg = findSvg(button)
  assert.ok(svg, 'header 必须使用内联 SVG')
  assert.equal(svg.props['aria-hidden'], 'true')
  assert.equal(svg.props.focusable, 'false')

  // 侧栏 seat 只读调 strict getSessionConfig（不是无参 list）。
  const pane = registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const result = await pane.options.inject('sess-2').loadSession()
  assert.deepEqual(sessionCalls, ['sess-2'])
  assert.equal(result.ok, true)
  assert.equal(result.view.roles[0].sourceLayer, 'global')

  assert.ok(logs.some(([level]) => level === 'info'), '注册成功应有 info 日志')
})

test('源码审计：无 primitives 依赖，priority 字符串，侧栏接 strict getSessionConfig', async () => {
  const source = await readFile(join(ROOT, 'src/client/index.js'), 'utf8')
  assert.doesNotMatch(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/, '不得 require primitives')
  assert.doesNotMatch(source, /\bprimitives\./, '不得使用 primitives.* 导出面')
  assert.match(source, /function Tag\(/, '本地最小 Tag')
  assert.match(source, /function IconUsers\(/, '内联 SVG')
  assert.match(source, /priority: 'extension'/, 'priority 必须是官方档位字符串')
  assert.doesNotMatch(source, /priority:\s*\d/, 'priority 不能是数字')
  assert.match(source, /service\.getSessionConfig\(sessionId\)/, '侧栏调用 strict getSessionConfig')
  assert.match(source, /headerTitle: '角色'/, '顶部入口文案「角色」')
})

test('slots 契约：settings.section/header/sidebar 的 scope 与 sessionId/params 形状', () => {
  const slots = contract.slots
  assert.deepEqual(
    { kind: slots['settings.section'].kind, scope: slots['settings.section'].scope },
    { kind: 'list', scope: 'root' },
  )
  assert.equal(slots['settings.section'].sessionId, false)
  assert.equal(slots['settings.section'].injectArgs, 0)
  assert.deepEqual(slots['settings.section'].ownerProps, ['close'])

  const header = slots['conversation.session.header.actions']
  assert.equal(header.scope, 'session')
  assert.equal(header.standardPropsIncludeSessionId, true)
  assert.equal(header.params, false)

  const pane = slots['sidebar.right.pane.tab']
  assert.equal(pane.kind, 'keyed')
  assert.equal(pane.scope, 'session')
  assert.equal(pane.standardPropsIncludeSessionId, true)
  assert.equal(pane.paramsVia, 'useTabInfo().tab.navigation.params')
  assert.equal(pane.key, 'tab type definition.id')
})
