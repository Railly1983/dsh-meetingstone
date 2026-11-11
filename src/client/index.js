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
 *  - dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js:1669-1677
 *      · `ctx.remote.$mount(contribution)` 安装 `remote.<namespace>` 服务
 *      · 命名空间服务名 = `remote.${namespace}`（同文件 2074-2076），由
 *        `RemoteNamespaceService extends cordis.Service` 在**子 fiber** 里 provide
 *        （同文件 1773-1785、1961）；因此**不能**在父插件里直接读。
 *  - dsh/node_modules/@deepseek-ai/cordis/src/reflect.ts:152-178
 *      · 未在 fiber.inject 声明的服务读取会抛 `cannot get property "..." without inject`
 *  - dsh/node_modules/@deepseek-ai/cordis/src/registry.ts:300-302
 *      · 官方动态注入：`ctx.inject(deps, callback)`（= `ctx.plugin({inject, apply})`），
 *        子 fiber 等到 deps 全部可用才 apply（fiber.ts:603-628 `_checkImpl`/`_refresh`）
 *
 * 数据链路（读取发生在 `ctx.inject(['remote.meetingstone'], cb)` 的就绪子 ctx 里）：
 *   ctx.remote.meetingstone.list()
 *     → Host src/gui/host.js（TypertRemoteService + Remote("list")）
 *     → registry.list() / cfg.channels / cfg.limits / cfg 调度字段 / 本机 CLI 探测
 *
 * 范围：只做**全局**设置（CLI 连接、全局角色库、默认模型、额度/并发策略、
 * 全局调度规则、最近错误）；只读，无搜索/筛选/排序/按钮/编辑/图表/动画。
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
    // Cordis 里命名空间服务的准确键名（见文件头 api-gateway 2074-2076）。
    const REMOTE_INJECT = `remote.${REMOTE_SERVICE}`

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

    /** @param {unknown} value */
    function asString(value) {
      return typeof value === 'string' ? value : ''
    }

    /** @param {unknown} value */
    function asObject(value) {
      return value && typeof value === 'object' ? value : {}
    }

    /** @param {unknown} value @returns {any[]} */
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    /** 通道实例（含模型/强度）→ 只读视图。 */
    function normalizeChannelDetail(channel) {
      const source = asObject(channel)
      return {
        channelId: asString(source.channelId),
        description: asString(source.description),
        kind: asString(source.kind),
        provider: asString(source.provider),
        model: asString(source.model),
        reasoning: asString(source.reasoning),
      }
    }

    /** CLI 探测结果 → 只读视图；`null` 表示宿主没有返回探测数据。 */
    function normalizeCli(value) {
      if (!Array.isArray(value)) return null
      return value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          cli: asString(item.cli),
          label: asString(item.label) || asString(item.cli),
          installed: item.installed === true,
          path: asString(item.path),
          version: asString(item.version),
          source: asString(item.source),
          notes: asArray(item.notes).map(String),
          checkedAt: typeof item.checkedAt === 'string' ? item.checkedAt : null,
        }))
    }

    /** 全局配置视图；缺字段回退到空串/默认值，不猜。 */
    function normalizeGlobal(value) {
      const source = asObject(value)
      const limits = asObject(source.limits)
      const maxParallel =
        Number.isFinite(limits.maxParallelWritesTotal) && limits.maxParallelWritesTotal >= 1
          ? Math.trunc(limits.maxParallelWritesTotal)
          : 4
      return {
        defaultRoleId: asString(source.defaultRoleId),
        dispatchNotes: asString(source.dispatchNotes),
        projectConfigFile: asString(source.projectConfigFile) || '.meetingstone.json',
        limits: {
          serializeWrites: limits.serializeWrites !== false,
          maxParallelWritesTotal: maxParallel,
          defaultIsolation: limits.defaultIsolation === 'none' ? 'none' : 'worktree',
        },
        channels: asArray(source.channels)
          .filter((channel) => channel && typeof channel === 'object')
          .map(normalizeChannelDetail),
        cli: normalizeCli(source.cli),
        cliError: asString(source.cliError) || null,
      }
    }

    /**
     * Remote 返回值是外部数据，按形状收窄后再渲染；缺字段回退空数组/无错误，
     * 不把未经验证的对象直接塞进 UI。
     * @param {unknown} value
     */
    function normalizeSnapshot(value) {
      const source = asObject(value)
      const roles = asArray(source.roles)
      const channels = asArray(source.channels)
      const error = source.lastError
      return {
        roles: roles
          .filter((role) => role && typeof role === 'object')
          .map((role) => ({
            roleId: asString(role.roleId),
            name: asString(role.name),
            aliases: asArray(role.aliases).map(String),
            enabled: role.enabled !== false,
            availability: asString(role.availability) || 'unknown',
            channelId: asString(role.channelId),
            provider: asString(role.provider),
            model: asString(role.model),
            reasoning: asString(role.reasoning),
          })),
        channels: channels
          .filter((channel) => channel && typeof channel === 'object')
          .map((channel) => ({
            channelId: asString(channel.channelId),
            kind: asString(channel.kind),
          })),
        lastError:
          error && typeof error === 'object'
            ? {
                code: asString(error.code) || 'UNKNOWN',
                message: asString(error.message),
                at: typeof error.at === 'string' ? error.at : null,
                source: asString(error.source),
              }
            : null,
        global: normalizeGlobal(source.global),
      }
    }

    /** 不可用快照：Remote 没挂上 / 命名空间没就绪时仍让页面可见、可解释。 */
    function unavailableSnapshot(code, message) {
      return {
        roles: [],
        channels: [],
        lastError: null,
        global: normalizeGlobal(null),
        unavailable: { code: asString(code) || 'REMOTE_UNAVAILABLE', message: asString(message) },
      }
    }

    // 直接消费宿主主题 token，不自带色板/框架；间距、字号沿用官方 settings-plugins
    // 的 CSS module（gap 12/10px、13px/20px、max-width 760px）。
    const C = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
    }
    const root = { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14, color: C.primary }
    const heading = { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: '22px' }
    const subheading = { fontSize: 12, lineHeight: '18px', color: C.tertiary }
    const note = { margin: 0, fontSize: 13, lineHeight: '20px', color: C.tertiary, wordBreak: 'break-word' }
    const list = { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' }
    const row = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, lineHeight: '20px', color: C.primary }
    const dim = { color: C.tertiary }
    const grow = { flex: 1, minWidth: 0, wordBreak: 'break-word' }
    const code = {
      fontFamily: 'var(--ds-font-family-code)',
      fontSize: 12,
      lineHeight: '18px',
      color: C.secondary,
      wordBreak: 'break-all',
    }
    const meta = { fontSize: 12, lineHeight: '18px', color: C.tertiary, wordBreak: 'break-all' }
    // 宿主设置卡片：同一组 alias token（官方 settings-plugin-inventory 的卡片样式）。
    const card = {
      border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
      borderRadius: 'var(--dsw-radius-xl, 12px)',
      background: 'var(--dsw-alias-settings-card-fill)',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }
    const kv = {
      display: 'grid',
      gridTemplateColumns: '140px minmax(0, 1fr)',
      gap: '6px 10px',
      margin: 0,
    }
    const kvItem = { display: 'contents' }
    const dt = { color: C.tertiary, fontSize: 12, lineHeight: '18px' }
    const dd = { margin: 0, color: C.secondary, fontSize: 13, lineHeight: '20px', wordBreak: 'break-word' }

    const zh = {
      nav: '集合石',
      loading: '加载中…',
      loadFailed: '读取宿主数据失败',
      unavailable: '远程数据不可用',
      cli: 'CLI 连接',
      roles: '全局角色库',
      channels: '通道',
      models: '默认模型',
      limits: '额度与并发策略',
      rules: '全局调度规则',
      errors: '最近错误',
      none: '无',
      notSet: '未设置',
      available: '可用',
      disabled: '已停用',
      providerUnavailable: '通道不可用',
      ambiguous: '别名冲突',
      unknown: '未知',
      installed: '已安装',
      notInstalled: '未安装',
      version: '版本',
      source: '来源',
      noCli: '未获取到本机 CLI 探测结果',
      cliTimeout: 'CLI 探测超时（下次打开将复用缓存）',
      defaultRole: '默认角色',
      channelModels: '通道模型',
      noChannels: '未配置通道实例',
      model: '模型',
      reasoning: '思考强度',
      parallelLimit: '并行写任务上限',
      serializeWrites: '同项目串行',
      on: '开',
      off: '关',
      isolation: '默认隔离',
      isolationWorktree: '每任务独立工作树',
      isolationNone: '主工作区（串行）',
      projectConfigFile: '项目配置文件',
      dispatchNotes: '调度提示',
    }
    const en = {
      nav: 'MeetingStone',
      loading: 'Loading…',
      loadFailed: 'Failed to read host data',
      unavailable: 'Remote data unavailable',
      cli: 'CLI connections',
      roles: 'Global role library',
      channels: 'Channels',
      models: 'Default models',
      limits: 'Quota & concurrency',
      rules: 'Global dispatch rules',
      errors: 'Recent errors',
      none: 'None',
      notSet: 'Not set',
      available: 'Available',
      disabled: 'Disabled',
      providerUnavailable: 'Channel unavailable',
      ambiguous: 'Alias conflict',
      unknown: 'Unknown',
      installed: 'Installed',
      notInstalled: 'Not installed',
      version: 'Version',
      source: 'Source',
      noCli: 'No local CLI probe result available',
      cliTimeout: 'CLI probe timed out (cache will be reused next time)',
      defaultRole: 'Default role',
      channelModels: 'Channel models',
      noChannels: 'No channel instance configured',
      model: 'Model',
      reasoning: 'Reasoning',
      parallelLimit: 'Parallel write limit',
      serializeWrites: 'Serialize same project',
      on: 'On',
      off: 'Off',
      isolation: 'Default isolation',
      isolationWorktree: 'Worktree per task',
      isolationNone: 'Main workspace (serialized)',
      projectConfigFile: 'Project config file',
      dispatchNotes: 'Dispatch notes',
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

    /** 键值行：`<dt>` 标签 + `<dd>` 值；语义化 dl 便于读屏。 */
    function kvRow(term, value, key) {
      return jsxs(
        'div',
        {
          style: kvItem,
          children: [
            jsx('dt', { style: dt, children: term }),
            jsx('dd', { style: dd, children: value }),
          ],
        },
        key ?? term,
      )
    }

    /** CLI 连接：只投影本机探测结果；拿不到就明说，不猜。 */
    function CliList({ t, global }) {
      if (!global.cli) {
        const message = global.cliError === 'CLI_PROBE_TIMEOUT' ? t('cliTimeout') : t('noCli')
        return jsx('p', { style: note, children: message })
      }
      if (global.cli.length === 0) {
        return jsx('span', { style: dim, children: t('none') })
      }
      return jsxs(
        'div',
        {
          style: list,
          children: global.cli.map((item) => {
            const label = item.label || item.cli || t('unknown')
            const version = item.installed ? item.version : ''
            return jsxs(
              'div',
              {
                style: { display: 'flex', flexDirection: 'column', gap: 2 },
                children: [
                  jsxs('div', {
                    style: row,
                    children: [
                      jsx('span', { children: label }),
                      version ? jsx('span', { style: code, children: `v${version.replace(/^v/, '')}` }) : null,
                      jsx('span', { style: grow }),
                      jsx(Tag, {
                        tone: item.installed ? 'info' : 'neutral',
                        children: item.installed ? t('installed') : t('notInstalled'),
                      }),
                    ],
                  }),
                  item.installed && item.path
                    ? jsx('div', { style: meta, children: item.path })
                    : null,
                ],
              },
              item.cli || label,
            )
          }),
        },
      )
    }

    /** 只读 section：全局配置 + 角色/通道 + 最近错误，无任何交互。 */
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
        return jsx('div', {
          style: root,
          children: jsx('p', { style: note, role: 'status', 'aria-live': 'polite', children: t('loading') }),
        })
      }
      if (state.status === 'error') {
        return jsxs('div', {
          style: root,
          role: 'alert',
          children: [
            jsx('p', { style: note, children: t('loadFailed') }),
            jsx('p', { style: note, children: state.message }),
          ],
        })
      }

      const snapshot = state.snapshot
      const global = snapshot.global
      const unavailable = snapshot.unavailable

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

      const defaultRole = global.defaultRoleId
        ? snapshot.roles.find((role) => role.roleId === global.defaultRoleId)
        : undefined
      const defaultModel = defaultRole
        ? defaultRole.model ||
          (global.channels.find((channel) => channel.channelId === defaultRole.channelId)?.model ?? '')
        : ''
      const defaultRoleLabel = defaultRole
        ? `${defaultRole.name || defaultRole.roleId}（${defaultRole.roleId}）`
        : t('notSet')

      const modelRows =
        global.channels.length === 0
          ? jsx('span', { style: dim, children: t('noChannels') })
          : global.channels.map((channel) => {
              const detail = [channel.kind, channel.provider].filter(Boolean).join(' · ')
              return jsxs(
                'div',
                {
                  style: row,
                  children: [
                    jsx('span', { style: code, children: channel.channelId || t('unknown') }),
                    jsx('span', { style: grow }),
                    detail ? jsx('span', { style: dim, children: detail }) : null,
                    jsx('span', { style: dim, children: channel.model || t('notSet') }),
                    channel.reasoning ? jsx('span', { style: dim, children: `(${channel.reasoning})` }) : null,
                  ],
                },
                channel.channelId || channel.model,
              )
            })

      const limits = global.limits
      const limitsBody = jsxs('dl', {
        style: kv,
        children: [
          kvRow(t('parallelLimit'), String(limits.maxParallelWritesTotal), 'max'),
          kvRow(t('serializeWrites'), limits.serializeWrites ? t('on') : t('off'), 'serialize'),
          kvRow(
            t('isolation'),
            limits.defaultIsolation === 'none' ? t('isolationNone') : t('isolationWorktree'),
            'isolation',
          ),
        ],
      })

      const rulesBody = jsxs('dl', {
        style: kv,
        children: [
          kvRow(t('defaultRole'), defaultRoleLabel, 'defaultRole'),
          kvRow(t('projectConfigFile'), global.projectConfigFile, 'projectConfigFile'),
          kvRow(t('dispatchNotes'), global.dispatchNotes || t('none'), 'dispatchNotes'),
        ],
      })

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
                    ? jsx('div', { style: meta, children: lastError.at })
                    : null,
                ],
              }),
            ],
          })

      return jsxs('div', {
        style: root,
        children: [
          unavailable
            ? jsxs('p', {
                style: { ...note, color: 'var(--dsw-alias-state-error-primary)' },
                role: 'status',
                children: [`${t('unavailable')} · ${unavailable.message || unavailable.code}`],
              })
            : null,
          jsx('h3', { style: heading, children: t('cli') }),
          jsx('div', { style: card, children: jsx(CliList, { t, global }) }),
          jsx('h3', { style: heading, children: t('roles') }),
          jsx('div', { style: card, children: jsxs('div', { style: list, children: roleRows }) }),
          jsx('h3', { style: heading, children: t('models') }),
          jsxs('div', {
            style: card,
            children: [
              jsxs('dl', {
                style: kv,
                children: [
                  kvRow(t('defaultRole'), defaultRoleLabel, 'defaultRole'),
                  kvRow(t('model'), defaultModel || t('notSet'), 'defaultModel'),
                ],
              }),
              jsx('div', { style: subheading, children: t('channelModels') }),
              jsx('div', { style: list, children: modelRows }),
            ],
          }),
          jsx('h3', { style: heading, children: t('limits') }),
          jsx('div', { style: card, children: limitsBody }),
          jsx('h3', { style: heading, children: t('rules') }),
          jsx('div', { style: card, children: rulesBody }),
          jsx('h3', { style: heading, children: t('errors') }),
          jsx('div', { style: card, children: errorBody }),
        ],
      })
    }

    /**
     * 数据加载器。`service` 必须是已就绪的 `remote.meetingstone` 命名空间服务；
     * 由调用方保证「可用后才注册」，这里不再做未声明注入的裸访问。
     * @param {any} service
     */
    function makeLoader(service) {
      return async () => {
        const result = await service.list()
        if (!result || result.ok !== true) {
          const failure = result && result.error ? result.error : {}
          throw new Error(
            `${REMOTE_SERVICE}.list failed: ${failure.code ?? 'unknown'}: ${failure.message ?? 'unknown'}`,
          )
        }
        return normalizeSnapshot(result.value)
      }
    }

    /**
     * 注册 settings.section。注册形状对齐官方 settings-plugins：
     * `ctx.slots.inject(name, () => ctx.slots.register({ name, id, order, label, locale, inject }, C))`。
     * @param {any} slotCtx 拥有该 slot 注册的 ctx（会随其 fiber 卸载自动注销）
     * @param {() => Promise<any>} loader
     * @param {(key: string) => string} t
     */
    function registerSection(slotCtx, loader, t) {
      slotCtx.slots.inject('settings.section', () =>
        slotCtx.slots.register(
          {
            name: 'settings.section',
            id: 'meetingstone',
            order: 100,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ list: loader }),
          },
          Section,
        ),
      )
    }

    /**
     * 挂载 section。inject 与 register 形状对齐官方 settings-plugins。
     *
     * 顺序是硬要求（Cordis 4.1.0 的 inject 语义）：
     *   1. 先用模块级 `inject: ['remote']` 挂载贡献 → 命名空间服务 `remote.meetingstone`
     *      在独立子 fiber 中 provide（api-gateway client.browser.js:1773-1785,1961,2074）；
     *   2. 再用 `ctx.inject(['remote.meetingstone'], cb)` 动态声明依赖：Cordis 会等该服务
     *      就绪后才执行 cb（registry.ts:300-302、fiber.ts:603-628）。cb 内读
     *      `ctx.remote.meetingstone` 才是合法的已声明访问；
     *   3. section 的 slot 注册与数据读取都放在 cb 里，服务不可用就不会裸访问/抛错。
     * 挂载失败时仍注册 section，但 loader 返回 unavailable 快照，页面可见且解释原因。
     */
    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meetingstone: section dictionaries')

      let unmount
      try {
        unmount = await ctx.remote.$mount(REMOTE_CONTRIBUTION)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(error)
        registerSection(ctx, async () => unavailableSnapshot('REMOTE_MOUNT_FAILED', message), t)
        return
      }
      // $mount 返回卸载函数；绑定到本插件 effect，卸载/重载时回收命名空间服务。
      ctx.effect(() => () => unmount(), 'meetingstone: remote contribution')

      ctx.inject([REMOTE_INJECT], (readyCtx) => {
        const service = readyCtx.remote[REMOTE_SERVICE]
        registerSection(readyCtx, makeLoader(service), t)
      })
    }

    exports.apply = apply
    exports.inject = inject
    // stub harness 用的纯函数；生产路径不依赖该导出。
    exports.__test = {
      normalizeSnapshot,
      normalizeGlobal,
      unavailableSnapshot,
      REMOTE_CONTRIBUTION,
      REMOTE_INJECT,
    }
    return module.exports
  },
})
