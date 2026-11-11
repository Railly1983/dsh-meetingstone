/**
 * 集合石 0.2.0 · GUI 只读 section（浏览器 half，接真实 Host 数据）。
 *
 * 本文件不是 Node 模块，而是宿主 client module system 直接当脚本加载的
 * lazy-CJS factory。格式与注册 API 全部取证于本机 app.asar（0.2.2-rc.1）：
 *  - dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js
 *      · 头部 window.__ModuleLoader__.load({ id, factory })
 *      · apply() 里 ctx.slots.inject("settings.section", () => ctx.slots.register({...}, Comp))
 *      · 主题用宿主 CSS token var(--dsw-alias-*)，间距/字号见其 CSS module
 *  - dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js
 *      · 只读列表用 @deepseek-ai/dsh-client-ui-primitives 的 Tag({ tone, children })
 *      · `inject: ["remote","remote.pluginInventory"]` + `ctx.remote.pluginInventory.list()`
 *  - dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js:1599-1702
 *      · `ctx.remote.$mount(contribution)` 安装 `remote.<namespace>` 服务
 *
 * 数据链路：
 *   ctx.remote.meetingstone.list()
 *     → Host src/gui/host.js（TypertRemoteService + Remote("list")）
 *     → registry.list() / cfg.channels / 最近错误
 *
 * 范围（硬要求）：只渲染「角色列表(名称+可用性)」「通道列表(channelId+kind)」
 * 「最近错误(无则显示"无")」三段；无搜索/筛选/排序/按钮/编辑/图表/动画。
 */

window.__ModuleLoader__.load({
  id: 'dsh-meetingstone',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let jsxRuntime = require('react/jsx-runtime')
    let react = require('react')
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    let jsx = jsxRuntime.jsx
    let jsxs = jsxRuntime.jsxs
    let Tag = primitives.Tag

    const NS = 'settings.meetingstone'
    const inject = ['slots', 'locale', 'remote']

    // Remote namespace / method 必须与 Host src/gui/host.js 的 GUI_REMOTE_SERVICE 对齐。
    const REMOTE_PACKAGE = 'dsh-meetingstone'
    const REMOTE_SERVICE = 'meetingstone'

    /**
     * 手写 Typert Remote contribution。
     *
     * 官方包由 `@deepseek-ai/dsh-typert-generator` 生成 `typert.remote-client.js`
     * （形如 dsh-host-plugin-inventory/lib/typert.remote-client.js）。本仓库没有生成器，
     * 且 `meetingstone/list` 是**零参数、无结果解码**的只读方法，故按生成物字段
     * 手写最小 descriptor。
     *
     * 字段不是随便写的：`ctx.remote.$mount` 会先经 `typert.remotes.register()`
     * 校验 descriptor（dsh-typert-registry/lib/index.js:143-155,584-627）：
     *   - `id` / `service` / `namespace` / `method` 必须是非空 segment；
     *   - `result` codec 要么 `{mode:"src-json"}`，要么 strict + `typeSymbol` + `create()`。
     * 这里没有 zod，故用宿主 SRC 路径的 `src-json`；Gateway 客户端对非 strict
     * 结果原样透传（dsh-api-gateway/lib/client.browser.js:1820-1845）。
     */
    const REMOTE_CONTRIBUTION = {
      package: REMOTE_PACKAGE,
      descriptors: [
        {
          id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/list`,
          service: REMOTE_SERVICE,
          namespace: REMOTE_SERVICE,
          method: 'list',
          parameters: [],
          invocation: { kind: 'direct' },
          result: { mode: 'src-json' },
        },
      ],
    }

    /**
     * Remote 返回值是外部数据，按形状收窄后再渲染；缺字段回退空数组/无错误，
     * 不把未经验证的对象直接塞进 UI。
     * @param {unknown} value
     */
    function normalizeSnapshot(value) {
      const source = value && typeof value === 'object' ? value : {}
      const roles = Array.isArray(source.roles) ? source.roles : []
      const channels = Array.isArray(source.channels) ? source.channels : []
      const error = source.lastError
      return {
        roles: roles
          .filter((role) => role && typeof role === 'object')
          .map((role) => ({
            roleId: typeof role.roleId === 'string' ? role.roleId : '',
            name: typeof role.name === 'string' ? role.name : '',
            aliases: Array.isArray(role.aliases) ? role.aliases.map(String) : [],
            enabled: role.enabled !== false,
            availability: typeof role.availability === 'string' ? role.availability : 'unknown',
          })),
        channels: channels
          .filter((channel) => channel && typeof channel === 'object')
          .map((channel) => ({
            channelId: typeof channel.channelId === 'string' ? channel.channelId : '',
            kind: typeof channel.kind === 'string' ? channel.kind : '',
          })),
        lastError:
          error && typeof error === 'object'
            ? {
                code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
                message: typeof error.message === 'string' ? error.message : '',
                at: typeof error.at === 'string' ? error.at : null,
                source: typeof error.source === 'string' ? error.source : '',
              }
            : null,
      }
    }

    // 直接消费宿主主题 token，不自带色板/框架；间距、字号沿用官方 settings-plugins
    // 的 CSS module（gap 12/10px、13px/20px、max-width 760px）。
    const C = {
      primary: 'var(--dsw-alias-label-primary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
    }
    const root = { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, color: C.primary }
    const heading = { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' }
    const note = { margin: 0, fontSize: 13, color: C.tertiary, wordBreak: 'break-word' }
    const list = { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' }
    const row = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, lineHeight: '20px', color: C.primary }
    const dim = { color: C.tertiary }
    const grow = { flex: 1, minWidth: 0, wordBreak: 'break-word' }

    const zh = {
      nav: '集合石',
      loading: '加载中…',
      loadFailed: '读取宿主数据失败',
      roles: '角色',
      channels: '通道',
      errors: '最近错误',
      none: '无',
      available: '可用',
      disabled: '已停用',
      providerUnavailable: '通道不可用',
      ambiguous: '别名冲突',
      unknown: '未知',
    }
    const en = {
      nav: 'MeetingStone',
      loading: 'Loading…',
      loadFailed: 'Failed to read host data',
      roles: 'Roles',
      channels: 'Channels',
      errors: 'Recent errors',
      none: 'None',
      available: 'Available',
      disabled: 'Disabled',
      providerUnavailable: 'Channel unavailable',
      ambiguous: 'Alias conflict',
      unknown: 'Unknown',
    }

    /** availability → 宿主 Tag 的 tone/文案 key（tone 取值见官方 TAG_TONES）。 */
    function availabilityBadge(t, availability) {
      if (availability === 'available') return { tone: 'info', label: t('available') }
      if (availability === 'disabled') return { tone: 'neutral', label: t('disabled') }
      if (availability === 'provider-unavailable') {
        return { tone: 'danger', label: t('providerUnavailable') }
      }
      if (availability === 'ambiguous') return { tone: 'warning', label: t('ambiguous') }
      return { tone: 'neutral', label: t('unknown') }
    }

    /** 只读 section：三段列表，无任何交互。 */
    function Section({ t, list: load }) {
      const [state, setState] = react.useState({ status: 'loading' })
      react.useEffect(() => {
        let current = true
        Promise.resolve()
          .then(() => load())
          .then(
            (snapshot) => {
              if (current) setState({ status: 'ready', snapshot })
            },
            (error) => {
              if (current) {
                setState({
                  status: 'error',
                  message: error instanceof Error ? error.message : String(error),
                })
              }
            },
          )
        return () => {
          current = false
        }
      }, [load])

      if (state.status === 'loading') {
        return jsx('div', { style: root, children: jsx('p', { style: note, children: t('loading') }) })
      }
      if (state.status === 'error') {
        return jsxs('div', {
          style: root,
          children: [
            jsx('p', { style: note, children: t('loadFailed') }),
            jsx('p', { style: note, children: state.message }),
          ],
        })
      }

      const snapshot = state.snapshot
      const roleRows =
        snapshot.roles.length === 0
          ? jsx('span', { style: dim, children: t('none') })
          : snapshot.roles.map((role) => {
              const badge = availabilityBadge(t, role.availability)
              return jsxs(
                'div',
                {
                  style: row,
                  children: [
                    jsx('span', { children: role.name || role.roleId }),
                    jsx('span', { style: dim, children: role.aliases.join(' / ') }),
                    jsx('span', { style: grow }),
                    jsx(Tag, { tone: badge.tone, children: badge.label }),
                  ],
                },
                role.roleId || role.name,
              )
            })

      const channelRows =
        snapshot.channels.length === 0
          ? jsx('span', { style: dim, children: t('none') })
          : snapshot.channels.map((channel, index) =>
              jsxs(
                'div',
                {
                  style: row,
                  children: [
                    jsx('span', { children: channel.channelId || t('unknown') }),
                    jsx('span', { style: dim, children: channel.kind || t('unknown') }),
                  ],
                },
                channel.channelId || String(index),
              ),
            )

      const lastError = snapshot.lastError
      const errorBody = !lastError
        ? jsx('span', { style: dim, children: t('none') })
        : jsxs('div', {
            style: { ...row, alignItems: 'flex-start' },
            children: [
              jsx('span', { children: `[${lastError.code}]` }),
              jsxs('div', {
                style: grow,
                children: [
                  jsx('div', { children: lastError.message || t('unknown') }),
                  lastError.at
                    ? jsx('div', { style: { ...dim, fontSize: 12 }, children: lastError.at })
                    : null,
                ],
              }),
            ],
          })

      return jsxs('div', {
        style: root,
        children: [
          jsx('h3', { style: heading, children: t('roles') }),
          jsxs('div', { style: list, children: roleRows }),
          jsx('h3', { style: heading, children: t('channels') }),
          jsxs('div', { style: list, children: channelRows }),
          jsx('h3', { style: heading, children: t('errors') }),
          jsxs('div', { style: list, children: errorBody }),
        ],
      })
    }

    /** 挂载 section。inject 与 register 形状对齐官方 settings-plugins。 */
    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meetingstone: section dictionaries')

      // 安装客户端 Remote namespace。$mount 返回卸载函数，绑定到插件 effect。
      try {
        const unmount = await ctx.remote.$mount(REMOTE_CONTRIBUTION)
        ctx.effect(() => () => unmount(), 'meetingstone: remote contribution')
      } catch (error) {
        // 不阻断设置页：组件会走 loadFailed 分支，明确显示读取失败，不伪装数据。
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(error)
      }

      const list = async () => {
        const result = await ctx.remote[REMOTE_SERVICE].list()
        if (!result || result.ok !== true) {
          const failure = result && result.error ? result.error : {}
          throw new Error(
            `${REMOTE_SERVICE}.list failed: ${failure.code ?? 'unknown'}: ${failure.message ?? 'unknown'}`,
          )
        }
        return normalizeSnapshot(result.value)
      }

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'meetingstone',
            order: 100,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ list }),
          },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // stub harness 用的纯函数；生产路径不依赖该导出。
    exports.__test = { normalizeSnapshot, REMOTE_CONTRIBUTION }
    return module.exports
  },
})
