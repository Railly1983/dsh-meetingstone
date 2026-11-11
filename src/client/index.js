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

    /** 右侧栏 tab 的 id（header 点击时用它打开面板）。 */
    const TAB_ID = 'meetingstone-roles'
    /** 标题右侧入口（conversation.session.header.actions）的 id。 */
    const HEADER_ACTION_ID = 'meetingstone-role'

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
        ...['getSessionConfig', 'setSessionOverride', 'clearSessionOverride'].map((method) => ({
          id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/${method}`,
          service: REMOTE_SERVICE,
          namespace: REMOTE_SERVICE,
          method,
          parameters: [],
          invocation: { kind: 'direct' },
          result: { mode: 'src-json' },
        })),
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
      // V1 三区精简
      collab: '默认协作配置',
      advanced: '高级设置',
      manageRoles: '管理角色',
      roleCount: '角色数量',
      openAdvanced: '展开',
      closeAdvanced: '收起',
      cliPaths: 'CLI 完整路径',
      configFile: '配置文件',
      openConfig: '打开配置文件',
      diagLog: '诊断日志位于 .meetingstone/runs',
      errorWarning: '最近一次错误',
      errorDetails: '查看详情',
      // 顶部集合石入口 + 右侧栏「当前会话角色」
      headerTitle: '集合石角色',
      headerDesc: '编辑当前会话的角色覆盖',
      tabTitle: '集合石角色',
      paneTitle: '当前会话角色覆盖',
      openPanel: '打开集合石角色面板',
      noRoles: '当前会话没有可用角色',
      inherited: '继承',
      overridden: '覆盖',
      restore: '恢复继承',
      aliasField: '别名',
      descField: '描述',
      providerField: '提供商',
      modelField: '模型',
      reasoningField: '思考强度',
      dispatchNotesField: '调度规则',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败',
      notSet: '未设置',
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
      // V1 三区精简
      collab: 'Default collaboration',
      advanced: 'Advanced',
      manageRoles: 'Manage roles',
      roleCount: 'Role count',
      openAdvanced: 'Expand',
      closeAdvanced: 'Collapse',
      cliPaths: 'CLI full paths',
      configFile: 'Config file',
      openConfig: 'Open config file',
      diagLog: 'Diagnostic logs are under .meetingstone/runs',
      errorWarning: 'Most recent error',
      errorDetails: 'View details',
      // 顶部集合石入口 + 右侧栏「当前会话角色」
      headerTitle: 'MeetingStone Roles',
      headerDesc: 'Edit role overrides for this session',
      tabTitle: 'MeetingStone Roles',
      paneTitle: 'Session role overrides',
      openPanel: 'Open MeetingStone role panel',
      noRoles: 'No roles available in this session',
      inherited: 'Inherited',
      overridden: 'Overridden',
      restore: 'Restore inherited',
      aliasField: 'Alias',
      descField: 'Description',
      providerField: 'Provider',
      modelField: 'Model',
      reasoningField: 'Reasoning',
      dispatchNotesField: 'Dispatch notes',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed',
      notSet: 'Not set',
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
                ],
              },
              item.cli || label,
            )
          }),
        },
      )
    }

    /** 高级：CLI 完整路径（仅已安装）。完整路径从区 1 移入此处，避免主页面噪声。 */
    function CliPaths({ t, global }) {
      const installed = (global.cli || []).filter((item) => item.installed && item.path)
      if (installed.length === 0) return jsx('span', { style: dim, children: t('none') })
      return jsxs('div', {
        style: list,
        children: installed.map((item) => {
          const label = item.label || item.cli || t('unknown')
          return jsxs(
            'div',
            {
              style: row,
              children: [
                jsx('span', { children: label }),
                jsx('span', { style: grow }),
                jsx('span', { style: meta, children: item.path }),
              ],
            },
            item.cli || label,
          )
        }),
      })
    }

    /** 高级：通道模型映射（channelId → kind·provider·model·reasoning）。 */
    function ChannelModels({ t, global }) {
      if (global.channels.length === 0) return jsx('span', { style: dim, children: t('noChannels') })
      return jsxs('div', {
        style: list,
        children: global.channels.map((channel) => {
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
        }),
      })
    }

    /**
     * 纯函数渲染「已就绪」设置页（V1 三区）。抽出来便于 stub harness 断言结构，
     * 不依赖 React 状态机。advancedOpen=false 时高级区折叠（默认）。
     * @param {(key: string) => string} t
     * @param {any} snapshot
     * @param {{ advancedOpen?: boolean, openRoles?: () => void, onToggleAdvanced?: () => void }} opts
     */
    function renderSection(t, snapshot, opts = {}) {
      const global = snapshot.global
      const advancedOpen = opts.advancedOpen !== false
      const openRoles = typeof opts.openRoles === 'function' ? opts.openRoles : () => {}
      const onToggleAdvanced =
        typeof opts.onToggleAdvanced === 'function' ? opts.onToggleAdvanced : () => {}

      const roleCount = snapshot.roles.length
      const defaultRole = global.defaultRoleId
        ? snapshot.roles.find((role) => role.roleId === global.defaultRoleId)
        : undefined
      const defaultRoleLabel = defaultRole
        ? `${defaultRole.name || defaultRole.roleId}（${defaultRole.roleId}）`
        : t('notSet')
      const limits = global.limits

      // 错误：有则一条警告（可点击看详情）；无则不占位（不显示「无」）。
      const lastError = snapshot.lastError
      const errorCard = !lastError
        ? null
        : jsxs('div', {
            role: 'alert',
            style: { ...card, borderColor: 'var(--dsw-alias-state-error-primary)' },
            children: [
              jsxs('div', {
                style: row,
                children: [
                  jsx(Tag, { tone: 'danger', children: t('errorWarning') }),
                  jsx('span', { style: grow }),
                  jsx('button', {
                    type: 'button',
                    style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0 },
                    onClick: () => {},
                    children: t('errorDetails'),
                  }),
                ],
              }),
              jsxs('div', {
                style: grow,
                children: [
                  jsx('div', {
                    children: `[${lastError.code}] ${lastError.message || t('unknown')}`,
                  }),
                  lastError.at ? jsx('div', { style: meta, children: lastError.at }) : null,
                ],
              }),
            ],
          })

      // 高级区（默认折叠）：隔离 / CLI 完整路径 / 通道模型映射 / 配置文件入口。
      const advancedBody = !advancedOpen
        ? null
        : jsxs('div', {
            style: card,
            children: [
              jsxs('dl', {
                style: kv,
                children: [
                  kvRow(
                    t('isolation'),
                    limits.defaultIsolation === 'none' ? t('isolationNone') : t('isolationWorktree'),
                    'isolation',
                  ),
                ],
              }),
              jsx('div', { style: subheading, children: t('cliPaths') }),
              jsx(CliPaths, { t, global }),
              jsx('div', { style: subheading, children: t('channelModels') }),
              jsx(ChannelModels, { t, global }),
              jsx('div', { style: subheading, children: t('configFile') }),
              jsxs('div', {
                style: row,
                children: [
                  jsx('span', { style: code, children: 'cordis.patch.yml' }),
                  jsx('span', { style: grow }),
                  jsx('button', {
                    type: 'button',
                    style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0 },
                    onClick: () => {},
                    children: t('openConfig'),
                  }),
                ],
              }),
              jsx('p', { style: note, children: t('diagLog') }),
            ],
          })

      return jsxs('div', {
        style: root,
        children: [
          errorCard,
          // 区 1：CLI 连接（四平台自动检测 / 版本 / 状态；完整路径已移入高级）。
          jsx('h3', { style: heading, children: t('cli') }),
          jsx('div', { style: card, children: jsx(CliList, { t, global }) }),
          // 区 2：默认协作配置（角色数量 + 管理入口；不在此做编辑器）。
          jsx('h3', { style: heading, children: t('collab') }),
          jsx('div', {
            style: card,
            children: jsxs('div', {
              style: list,
              children: [
                jsxs('div', {
                  style: row,
                  children: [
                    jsx('span', { children: t('roleCount') }),
                    jsx('span', { children: String(roleCount) }),
                    jsx('span', { style: grow }),
                    jsx('button', {
                      type: 'button',
                      style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0 },
                      onClick: openRoles,
                      children: t('manageRoles'),
                    }),
                  ],
                }),
                kvRow(t('defaultRole'), defaultRoleLabel, 'defaultRole'),
                kvRow(t('parallelLimit'), String(limits.maxParallelWritesTotal), 'max'),
                kvRow(t('serializeWrites'), limits.serializeWrites ? t('on') : t('off'), 'serialize'),
                kvRow(t('dispatchNotes'), global.dispatchNotes || t('none'), 'dispatchNotes'),
              ],
            }),
          }),
          // 区 3：高级设置（默认折叠）。
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10 },
            children: [
              jsx('h3', { style: { ...heading, flex: 1 }, children: t('advanced') }),
              jsx('button', {
                type: 'button',
                style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0 },
                'aria-expanded': advancedOpen,
                onClick: onToggleAdvanced,
                children: advancedOpen ? t('closeAdvanced') : t('openAdvanced'),
              }),
            ],
          }),
          advancedBody,
        ],
      })
    }

    /** 只读 section：V1 三区结构 + 最近错误（条件显示）；无任何搜索/编辑/动画。 */
    function Section({ t, list: load, openRoles }) {
      const [state, setState] = react.useState({ status: 'loading' })
      const [advancedOpen, setAdvancedOpen] = react.useState(false)
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
      const unavailable = snapshot.unavailable
      // 加载成功但 remote 未就绪：仍渲染三区骨架，让页面可见并解释原因。
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
          renderSection(t, snapshot, {
            advancedOpen,
            openRoles,
            onToggleAdvanced: () => setAdvancedOpen(!advancedOpen),
          }),
        ],
      })
    }

    /** Cordis 服务访问必须走 ctx.get（直接读属性会抛 without inject）。 */
    function sidebarRightTabsOf(slotCtx) {
      try {
        return typeof slotCtx.get === 'function' ? slotCtx.get('sidebarRightTabs') : undefined
      } catch {
        return undefined
      }
    }

    /** GUI 注册期错误：注册失败时页面上要能看见原因，而不是整块消失。 */
    const guiErrors = []

    /**
     * 数据加载器。`serviceOrGet` 可以是服务实例，也可以是返回服务的函数。
     *
     * 真机教训（0.1.0-alpha）：把 `slot` 注册整段放进 `ctx.inject(['remote.meetingstone'], cb)`
     * 会导致 cb 永不执行时「设置页与顶部入口都不出现」——命名空间服务由 $mount 在子 fiber
     * provide，父 fiber 的 inject 不保证被唤醒。改为：注册永远立即发生，读取服务时用
     * `ctx.get()` 动态取；取不到就返回 unavailable 快照，页面仍可见并解释原因。
     * @param {any | (() => any | null)} serviceOrGet
     */
    function makeLoader(serviceOrGet) {
      return async () => {
        const service = typeof serviceOrGet === 'function' ? serviceOrGet() : serviceOrGet
        if (!service || typeof service.list !== 'function') {
          return unavailableSnapshot('REMOTE_UNAVAILABLE', 'remote.meetingstone 尚未就绪')
        }
        const result = await service.list()
        if (!result || result.ok !== true) {
          const failure = result && result.error ? result.error : {}
          throw new Error(
            `${REMOTE_SERVICE}.list failed: ${failure.code ?? 'unknown'}: ${failure.message ?? 'unknown'}`,
          )
        }
        const snapshot = normalizeSnapshot(result.value)
        if (guiErrors.length > 0 && snapshot.lastError === null) {
          snapshot.lastError = {
            code: 'GUI_REGISTRATION_FAILED',
            message: guiErrors.join(' | '),
            at: null,
            source: 'client',
          }
        }
        return snapshot
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
            inject: () => ({
              list: loader,
              // 区 2「管理角色」入口：打开右侧栏会话角色面板（复用既有 TAB_ID）。
              openRoles: () => {
                try {
                  sidebarRightTabsOf(slotCtx)?.open?.(TAB_ID)
                } catch {
                  /* 宿主未提供 open 时静默 */
                }
              },
            }),
          },
          Section,
        ),
      )
    }

    /** 可覆盖字段的元数据：从生效角色读取值、写覆盖时构造 patch 形状。 */
    const OVERRIDABLE_FIELDS = [
      {
        key: 'alias',
        labelKey: 'aliasField',
        get: (/** @type {any} */ r) => (Array.isArray(r.aliases) ? r.aliases.join(', ') : ''),
        toValue: (/** @type {string} */ raw) =>
          raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
      },
      { key: 'description', labelKey: 'descField', get: (/** @type {any} */ r) => r.description ?? '' },
      {
        key: 'provider',
        labelKey: 'providerField',
        get: (/** @type {any} */ r) => r.channel?.provider ?? '',
      },
      {
        key: 'model',
        labelKey: 'modelField',
        get: (/** @type {any} */ r) => r.channel?.model ?? '',
      },
      {
        key: 'reasoning',
        labelKey: 'reasoningField',
        get: (/** @type {any} */ r) => r.channel?.reasoning ?? '',
      },
    ]

    /**
     * 加载当前会话的角色视图。service 必须是已就绪的 `remote.meetingstone` 命名空间服务。
     * @param {any} service
     */
    function makeSessionLoader(service) {
      return async (sessionId) => {
        const result = await service.getSessionConfig(sessionId)
        if (!result || result.ok !== true) {
          const failure = result && result.error ? result.error : {}
          throw new Error(
            `${REMOTE_SERVICE}.getSessionConfig failed: ${failure.code ?? 'unknown'}: ${failure.message ?? 'unknown'}`,
          )
        }
        return result.value
      }
    }

    /** @param {any} service @param {string} sessionId @param {string} roleId @param {string} field @param {unknown} value */
    async function applySessionOverride(service, sessionId, roleId, field, value) {
      const result = await service.setSessionOverride(sessionId, roleId, field, value)
      if (!result || result.ok !== true) {
        const failure = result && result.error ? result.error : {}
        throw new Error(
          `${REMOTE_SERVICE}.setSessionOverride failed: ${failure.code ?? 'unknown'}: ${failure.message ?? 'unknown'}`,
        )
      }
      return result.value
    }

    /** @param {any} service @param {string} sessionId @param {string} roleId @param {string} [field] */
    async function clearSessionOverride(service, sessionId, roleId, field) {
      const result = await service.clearSessionOverride(sessionId, roleId, field ?? null)
      if (!result || result.ok !== true) {
        const failure = result && result.error ? result.error : {}
        throw new Error(
          `${REMOTE_SERVICE}.clearSessionOverride failed: ${failure.code ?? 'unknown'}: ${failure.message ?? 'unknown'}`,
        )
      }
      return result.value
    }

    /** 标题右侧入口：图标按钮（宿主 Icon，回退文字）；点击打开右侧栏 tab。 */
    function HeaderEntry({ t, openRolePanel }) {
      const label = t('headerTitle')
      const desc = t('headerDesc')
      const icon =
        typeof primitives.Icon === 'function'
          ? jsx(primitives.Icon, { name: 'users', 'aria-label': label, title: desc })
          : jsx('span', { children: label })
      return jsx('button', {
        type: 'button',
        className: 'dsh-meetingstone-header-entry',
        'aria-label': label,
        title: desc,
        onClick: () => {
          try {
            if (openRolePanel) openRolePanel()
          } catch {
            /* 宿主未提供 sidebarRightTabs.open 时静默 */
          }
        },
        children: icon,
      })
    }

    /** 右侧栏 tab 标题。 */
    function SidebarRoleTitle({ t }) {
      return jsx('span', { children: t('tabTitle') })
    }

    /** 单个角色的覆盖编辑卡片（只用宿主 token，不自带 CSS）。 */
    function RoleCard({ t, role, sources, service, sessionId, onChanged }) {
      const srcFields = sources?.[role.roleId]?.fields ?? {}
      return jsxs('div', {
        style: card,
        children: [
          jsx('div', { style: row, children: [jsx('strong', { children: role.name || role.roleId }), jsx('span', { style: grow })] }),
          ...OVERRIDABLE_FIELDS.map((field) => {
            const fieldPath = field.key.startsWith('channel.') ? field.key : field.key
            const src = srcFields[fieldPath] ?? srcFields[field.key] ?? 'default'
            const isOverridden = src === 'session'
            const value = field.get(role)
            return jsxs(
              'div',
              {
                style: { display: 'flex', flexDirection: 'column', gap: 4 },
                children: [
                  jsxs('div', {
                    style: row,
                    children: [
                      jsx('span', { style: dt, children: t(field.labelKey) }),
                      jsx('span', { style: grow }),
                      jsx(Tag, {
                        tone: isOverridden ? 'warning' : 'neutral',
                        children: isOverridden ? t('overridden') : t('inherited'),
                      }),
                    ],
                  }),
                  jsx('input', {
                    type: 'text',
                    value: value,
                    placeholder: t('notSet'),
                    style: { ...code, width: '100%' },
                    onInput: async (/** @type {any} */ e) => {
                      const raw = e?.target?.value ?? ''
                      try {
                        const next = field.key === 'alias' ? field.toValue(raw) : raw
                        await applySessionOverride(service, sessionId, role.roleId, field.key, next)
                        if (onChanged) onChanged()
                      } catch {
                        /* 写入失败：保持原值，下一轮刷新会显示真实状态 */
                      }
                    },
                  }),
                  isOverridden
                    ? jsx('button', {
                        type: 'button',
                        style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 },
                        onClick: async () => {
                          try {
                            await clearSessionOverride(service, sessionId, role.roleId, field.key)
                            if (onChanged) onChanged()
                          } catch {
                            /* 同上 */
                          }
                        },
                        children: t('restore'),
                      })
                    : null,
                ],
              },
              `${role.roleId}.${field.key}`,
            )
          }),
        ],
      })
    }

    /**
     * 惰性服务代理：render 时 `remote.meetingstone` 可能还没就绪，
     * 每次方法调用时再取；取不到抛可诊断错误（由 UI 显示"读取失败"）。
     * @param {() => any | null} getService
     */
    function lazyRemoteService(getService) {
      const call = (/** @type {string} */ name) => (...args) => {
        const service = getService()
        if (!service || typeof service[name] !== 'function') {
          throw new Error('REMOTE_UNAVAILABLE: remote.meetingstone 尚未就绪')
        }
        return service[name](...args)
      }
      return {
        getSessionConfig: call('getSessionConfig'),
        setSessionOverride: call('setSessionOverride'),
        clearSessionOverride: call('clearSessionOverride'),
      }
    }

    /** 右侧栏「当前会话角色」面板：拉取视图 → 渲染角色覆盖卡 → 写回。 */
    function SidebarRolePane({ t, sessionId, service }) {
      const [state, setState] = react.useState({ status: 'loading' })
      const reload = () => {
        Promise.resolve()
          .then(() => makeSessionLoader(service)(sessionId))
          .then(
            (view) => setState({ status: 'ready', view }),
            (error) =>
              setState({
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              }),
          )
      }
      react.useEffect(() => {
        let current = true
        Promise.resolve()
          .then(() => makeSessionLoader(service)(sessionId))
          .then(
            (view) => {
              if (current) setState({ status: 'ready', view })
            },
            (error) => {
              if (current)
                setState({
                  status: 'error',
                  message: error instanceof Error ? error.message : String(error),
                })
            },
          )
        return () => {
          current = false
        }
      }, [sessionId, service])

      if (state.status === 'loading') {
        return jsx('div', { style: note, children: t('loading') })
      }
      if (state.status === 'error') {
        return jsxs('div', { role: 'alert', children: [jsx('p', { style: note, children: t('loadFailed') }), jsx('p', { style: note, children: state.message })] })
      }

      const view = state.view
      const roles = Array.isArray(view?.effective?.roles) ? view.effective.roles : []
      const sources = view?.sources?.roles ?? {}
      return jsxs('div', {
        style: root,
        children: [
          jsx('h3', { style: heading, children: t('paneTitle') }),
          roles.length === 0
            ? jsx('p', { style: note, children: t('noRoles') })
            : jsxs('div', {
                style: list,
                children: roles.map((role) =>
                  jsx(RoleCard, {
                    key: role.roleId,
                    t,
                    role,
                    sources,
                    service,
                    sessionId,
                    onChanged: reload,
                  }),
                ),
              }),
        ],
      })
    }

    /**
     * 注册 title 右侧入口 `conversation.session.header.actions`（kind:list, scope:session）。
     * 注册形状对齐官方：{ name, id, order, locale, inject(sessionId) }。
     * @param {any} slotCtx
     * @param {any} service 已就绪的 remote.meetingstone 服务
     * @param {(key: string) => string} t
     */
    function registerHeaderAction(slotCtx, service, t) {
      const openPanel = () => {
        try {
          sidebarRightTabsOf(slotCtx)?.open?.(TAB_ID)
        } catch {
          /* 宿主未提供 open 时静默 */
        }
      }
      slotCtx.slots.inject('conversation.session.header.actions', () =>
        slotCtx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: HEADER_ACTION_ID,
            order: 60,
            locale: NS,
            inject: (/** @type {string} */ sessionId) => ({ sessionId, openRolePanel: openPanel, t }),
          },
          HeaderEntry,
        ),
      )
    }

    /**
     * 两步式注册右侧栏 tab：先 `sidebarRightTabs.register` 注册 tab，再注册两个
     * keyed seat（内容 + 标题，scope session）。
     * @param {any} slotCtx
     * @param {() => any | null} getService 动态取 remote.meetingstone（可能尚未就绪）
     * @param {(key: string) => string} t
     */
    function registerSidebarTab(slotCtx, getService, t) {
      // 1) tab 本体
      if (typeof sidebarRightTabsOf(slotCtx)?.register === 'function') {
        sidebarRightTabsOf(slotCtx).register({
          id: TAB_ID,
          kind: 'meetingstone-roles',
          priority: 50,
          title: () => t('tabTitle'),
        })
      }
      // 2) keyed seats（scope session）
      slotCtx.slots.inject('sidebar.right.pane.tab', () =>
        slotCtx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            id: TAB_ID,
            locale: NS,
            inject: (/** @type {string} */ sessionId) => ({
              sessionId,
              service: lazyRemoteService(getService),
              t,
            }),
          },
          SidebarRolePane,
        ),
      )
      slotCtx.slots.inject('sidebar.right.pane.tab.title', () =>
        slotCtx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            id: TAB_ID,
            locale: NS,
            inject: () => ({ t }),
          },
          SidebarRoleTitle,
        ),
      )
    }

    /**
     * 挂载 section。注册与 `remote.meetingstone` 的就绪**解耦**：
     *
     * 0.1.0-alpha 真机事故：把 slot 注册放进 `ctx.inject(['remote.meetingstone'], cb)`，
     * 该服务由 $mount 在子 fiber provide，父 fiber 的注入回调并不保证被唤醒；
     * 结果是设置页与对话顶部入口**都不出现**（用户看到的就是这个）。
     * 现在：$mount 之后立即注册 section / header / sidebar，服务读取走 `ctx.get()` 惰性获取；
     * 取不到时显示 unavailable 快照，而不是让整个 UI 消失。
     */
    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meetingstone: section dictionaries')

      // 任何一段注册失败都不能拖垮宿主启动（0.1.0-alpha 真机事故：一个 slot 注册
      // 抛错导致 web boot "entry did not activate"，整个应用无法打开）。
      const guard = (/** @type {string} */ label, /** @type {() => void} */ fn) => {
        try {
          fn()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          guiErrors.push(`${label}: ${message}`)
          try {
            console.error(`[meetingstone] GUI ${label} failed:`, error)
          } catch {
            /* console 不可用 */
          }
          if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[meetingstone] GUI ${label} failed: ${message}`)
        }
      }

      let unmount
      try {
        unmount = await ctx.remote.$mount(REMOTE_CONTRIBUTION)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(error)
        guard('section(mount-failed)', () => registerSection(ctx, async () => unavailableSnapshot('REMOTE_MOUNT_FAILED', message), t))
        return
      }
      // $mount 返回卸载函数；绑定到本插件 effect，卸载/重载时回收命名空间服务。
      ctx.effect(() => () => unmount(), 'meetingstone: remote contribution')

      // 动态取名空间服务：不在 fiber.inject 里声明（会阻塞注册），用官方 ctx.get()。
      const getService = () => {
        try {
          const key = Array.isArray(REMOTE_INJECT) ? REMOTE_INJECT[0] : REMOTE_INJECT
          const fromGet = typeof ctx.get === 'function' ? ctx.get(key) : undefined
          return fromGet ?? null
        } catch {
          return null
        }
      }

      guard('section', () => registerSection(ctx, makeLoader(getService), t))
      guard('header', () => registerHeaderAction(ctx, getService, t))
      guard('sidebar', () => registerSidebarTab(ctx, getService, t))
    }

    exports.apply = apply
    exports.inject = inject
    // stub harness 用的纯函数；生产路径不依赖该导出。
    exports.__test = {
      normalizeSnapshot,
      normalizeGlobal,
      unavailableSnapshot,
      renderSection,
      CliList,
      CliPaths,
      ChannelModels,
      REMOTE_CONTRIBUTION,
      REMOTE_INJECT,
      TAB_ID,
      HEADER_ACTION_ID,
      makeSessionLoader,
      applySessionOverride,
      clearSessionOverride,
      OVERRIDABLE_FIELDS,
    }
    return module.exports
  },
})
