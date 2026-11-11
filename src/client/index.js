/**
 * 集合石 0.2.0 · GUI 最小骨架（浏览器 half，只读 section）。
 *
 * 本文件不是 Node 模块，而是宿主 client module system 直接当脚本加载的
 * lazy-CJS factory。格式与注册 API 全部取证于本机 app.asar（0.2.2-rc.1）：
 *  - dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js
 *      · 头部 window.__ModuleLoader__.load({ id, factory })
 *      · apply() 里 ctx.slots.inject("settings.section", () => ctx.slots.register({...}, Comp))
 *      · 主题用宿主 CSS token var(--dsw-alias-*)，间距/字号见其 CSS module
 *  - dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js
 *      · 只读列表用 @deepseek-ai/dsh-client-ui-primitives 的 Tag({ tone, children })
 *
 * 范围（硬要求）：只渲染「角色列表(名称+别名+是否可用)」「通道列表(channelId+kind)」
 * 「最近错误(无则显示"无")」三段；无搜索/筛选/排序/按钮/编辑/图表/动画。
 *
 * 数据：占位。浏览器 half 读不到 Host 侧 .meetingstone.json；真实数据须经
 * Host 侧 remote face（见 docs/gui-0.2.0.md）。占位值只用于把骨架画出来，不冒充真实状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-meetingstone',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let jsxRuntime = require('react/jsx-runtime')
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    let jsx = jsxRuntime.jsx
    let jsxs = jsxRuntime.jsxs
    let Tag = primitives.Tag

    // 占位快照：形状对齐 Host 侧 registry.list() / cfg.channels / registry.errors。
    const SNAPSHOT = {
      roles: [
        { name: '唐僧', aliases: ['TT', '领导'], available: true },
        { name: '悟空', aliases: ['WK', '专家'], available: true },
        { name: '八戒', aliases: ['BJ', '调度'], available: false },
        { name: '沙僧', aliases: ['SS', '主力执行'], available: true },
        { name: '小白', aliases: ['XB', '打杂'], available: true },
      ],
      channels: [
        { channelId: 'ch-codex-astra', kind: 'codex' },
        { channelId: 'ch-codex-sol', kind: 'codex' },
        { channelId: 'ch-inprocess', kind: 'in-process' },
        { channelId: 'ch-acp-flash', kind: 'acp-cli' },
        { channelId: 'ch-acp-hy4', kind: 'acp-cli' },
      ],
      errors: [],
    }

    // 直接消费宿主主题 token，不自带色板/框架；间距、字号沿用官方 settings-plugins
    // 的 CSS module（gap 12/10px、13px/20px、max-width 760px）。
    const C = {
      primary: 'var(--dsw-alias-label-primary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
    }
    const root = { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, color: C.primary }
    const heading = { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' }
    const note = { margin: 0, fontSize: 13, color: C.tertiary }
    const list = { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' }
    const row = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, lineHeight: '20px', color: C.primary }
    const dim = { color: C.tertiary }

    const zh = {
      nav: '集合石',
      placeholder: '占位数据（浏览器 half 暂未接 Host 快照）',
      roles: '角色',
      channels: '通道',
      errors: '最近错误',
      none: '无',
      available: '可用',
      unavailable: '不可用',
    }
    const en = {
      nav: 'MeetingStone',
      placeholder: 'Placeholder data (browser half not wired to Host snapshot yet)',
      roles: 'Roles',
      channels: 'Channels',
      errors: 'Recent errors',
      none: 'None',
      available: 'Available',
      unavailable: 'Unavailable',
    }

    const NS = 'settings.meetingstone'
    const inject = ['slots', 'locale']

    /** 只读 section：只画三段列表，无任何交互。 */
    function Section({ t }) {
      const roleRows = SNAPSHOT.roles.map((r) =>
        jsxs(
          'div',
          {
            style: row,
            children: [
              jsx('span', { children: r.name }),
              jsx('span', { style: dim, children: r.aliases.join(' / ') }),
              jsx(Tag, {
                tone: r.available ? 'info' : 'neutral',
                children: r.available ? t('available') : t('unavailable'),
              }),
            ],
          },
          r.name,
        ),
      )

      const channelRows = SNAPSHOT.channels.map((c) =>
        jsxs(
          'div',
          {
            style: row,
            children: [
              jsx('span', { children: c.channelId }),
              jsx('span', { style: dim, children: c.kind }),
            ],
          },
          c.channelId,
        ),
      )

      const errorRows =
        SNAPSHOT.errors.length === 0
          ? jsx('span', { style: dim, children: t('none') })
          : SNAPSHOT.errors.map((e, i) => jsx('div', { style: row, children: String(e) }, String(i)))

      return jsxs('div', {
        style: root,
        children: [
          jsx('p', { style: note, children: t('placeholder') }),
          jsx('h3', { style: heading, children: t('roles') }),
          jsxs('div', { style: list, children: roleRows }),
          jsx('h3', { style: heading, children: t('channels') }),
          jsxs('div', { style: list, children: channelRows }),
          jsx('h3', { style: heading, children: t('errors') }),
          jsxs('div', { style: list, children: errorRows }),
        ],
      })
    }

    /** 挂载 section。inject 与 register 形状对齐官方 settings-plugins。 */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meetingstone: section dictionaries')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'meetingstone',
            order: 100,
            label: () => t('nav'),
            locale: NS,
          },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
