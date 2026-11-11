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
 * 范围：全局设置（CLI 连接、全局角色库、默认模型、额度/并发策略、
 * 全局调度规则、最近错误）只读；会话 Remote（get/set/clearSessionOverride）
 * 已恢复 strict codec，供后续会话面板写操作使用（本版不接 UI）。
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

    /**
     * 真实 zod：宿主 web 模块表的平台 seed 词（`staticModules`）包含 `zod`
     * （dsh-web-frontend/dist/assets/index-*.js 的 `YZ()`：`zod: JS`），
     * 官方 `@deepseek-ai/dsh-api-remotes/lib/client.js:7` 同样直接
     * `require("zod")`。拿不到时只挂无参 `list`（严格降级，不伪造 strict）。
     */
    let zodModule = null
    try {
      zodModule = require('zod')
    } catch {
      zodModule = null
    }
    const z = zodModule?.z ?? zodModule?.default?.z ?? zodModule?.default ?? null

    const NS = 'settings.meetingstone'
    const inject = ['slots', 'locale', 'remote']

    /**
     * 浏览器 half 无法读 `package.json`（宿主只加载 factory 脚本），故版本常量
     * 与 package.json / src/index.js 的 PLUGIN_VERSION 保持一致，供统一注册日志
     * 使用。升级版本时三处同步。
     */
    const PLUGIN_VERSION = '0.1.0-alpha'

    /** 右侧栏 tab 的 kind（`sidebarRight.openTab(kind)` 用它打开）。 */
    const TAB_KIND = 'meetingstone-roles'

    /** 右侧栏 tab 的 id（keyed seat 的 key）。 */
    const TAB_ID = 'meetingstone-roles'
    /** 标题右侧入口（conversation.session.header.actions）的 id。 */
    const HEADER_ACTION_ID = 'meetingstone-role'

    // Remote namespace / method 必须与 Host src/gui/host.js 的 GUI_REMOTE_SERVICE 对齐。
    const REMOTE_PACKAGE = 'dsh-meetingstone'
    const REMOTE_SERVICE = 'meetingstone'
    // Cordis 里命名空间服务的准确键名（见文件头 api-gateway 2074-2076）。
    const REMOTE_INJECT = `remote.${REMOTE_SERVICE}`

    /**
     * strict 契约常量：必须与 Host `src/gui/typert-spec.js` 的
     * `SESSION_REMOTE_TYPES` 逐字一致（tests/gui.test.mjs 做双向断言）。
     */
    const SESSION_TYPES = {
      sessionId: 'dsh-meetingstone/types#SessionId',
      roleId: 'dsh-meetingstone/types#RoleId',
      field: 'dsh-meetingstone/types#OverrideField',
      value: 'dsh-meetingstone/types#JsonValue',
      sessionConfigView: 'dsh-meetingstone/types#SessionConfigView',
      overrideResult: 'dsh-meetingstone/types#SessionOverrideResult',
    }

    /** 构造 client 侧 strict codec；zod 不可用时返回 null（调用方跳过该方法）。 */
    const strictCodec = (typeSymbol, build) =>
      z ? { mode: 'strict', typeSymbol, create: build } : null

    const sessionIdCodec = () =>
      strictCodec(SESSION_TYPES.sessionId, () => z.string().min(1).max(128))
    const roleIdCodec = () =>
      strictCodec(SESSION_TYPES.roleId, () => z.string().min(1).max(128))
    const fieldCodec = () =>
      strictCodec(SESSION_TYPES.field, () => z.string().min(1).max(128))
    const jsonValueCodec = () => strictCodec(SESSION_TYPES.value, () => z.unknown())

    /**
     * 三个带参会话方法的 client descriptor。参数 codec 全部 strict（真实 zod），
     * 与 Host 使用同一 typeSymbol；`result` 用 src-json 原样透传
     * （Gateway 客户端只强制输入 codec，见 dsh-api-gateway/lib/client.browser.js:2101-2109）。
     *
     * 不能退回 `src-json` 参数：`ctx.remote.$mount` 的 `requireStrictInputs`
     * 会直接拒绝并报 `has no strict codec`——0.2.0 的回退原因。
     */
    const SESSION_DESCRIPTORS = z
      ? [
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/getSessionConfig`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'getSessionConfig',
            parameters: [
              {
                name: 'sessionId',
                wire: 'sessionId',
                source: 'json',
                codec: sessionIdCodec(),
              },
            ],
            invocation: { kind: 'direct' },
            result: { mode: 'src-json' },
          },
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/setSessionOverride`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'setSessionOverride',
            parameters: [
              { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec() },
              { name: 'roleId', wire: 'roleId', source: 'json', codec: roleIdCodec() },
              { name: 'field', wire: 'field', source: 'json', codec: fieldCodec() },
              { name: 'value', wire: 'value', source: 'json', codec: jsonValueCodec() },
            ],
            invocation: { kind: 'direct' },
            result: { mode: 'src-json' },
          },
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/clearSessionOverride`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'clearSessionOverride',
            parameters: [
              { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec() },
              { name: 'roleId', wire: 'roleId', source: 'json', codec: roleIdCodec() },
              {
                name: 'field',
                wire: 'field',
                source: 'json',
                acceptsUndefined: true,
                codec: fieldCodec(),
              },
            ],
            invocation: { kind: 'direct' },
            result: { mode: 'src-json' },
          },
        ]
      : []

    /**
     * 手写 Typert Remote contribution。
     *
     * 官方包由 `@deepseek-ai/dsh-typert-generator` 生成 `typert.remote-client.js`
     * （形如 dsh-host-plugin-inventory/lib/typert.remote-client.js）。本仓库没有生成器，
     * 但官方明确允许手写 wire schema（dsh-typert-loader/lib/index.js:27-29），
     * 且 registry 只要求非空 typeSymbol + 真实 create()（dsh-typert-registry:584-628）。
     *
     * 字段不是随便写的：`ctx.remote.$mount` 会先经 `typert.remotes.register()`
     * 校验 descriptor（dsh-typert-registry/lib/index.js:143-155,584-627）：
     *   - `id` / `service` / `namespace` / `method` 必须是非空 segment；
     *   - 参数 codec 必须 `mode:"strict"`（Gateway 客户端硬校验）；
     *   - `result` codec 可以是 `{mode:"src-json"}`（结果原样透传）。
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
        ...SESSION_DESCRIPTORS,
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
          // 宿主自报分类；老版本 host 没有该字段时按外部 CLI 处理（探测只覆盖外部）。
          category: asString(item.category) || 'external',
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
    // CLI 分类标签（宿主/外部）：弱化显示，不抢名称与状态。
    const category = {
      fontSize: 11,
      lineHeight: '16px',
      color: C.tertiary,
      border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
      borderRadius: 4,
      padding: '0 4px',
      flexShrink: 0,
    }
    // 左右对齐行：标签在左，值靠右；用于默认协作配置。
    const alignRow = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 13,
      lineHeight: '20px',
      color: C.primary,
    }
    const alignValue = { marginLeft: 'auto', textAlign: 'right', color: C.secondary, wordBreak: 'break-word' }
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
      channelInstances: '通道实例',
      configFile: '配置文件',
      openConfig: '打开配置文件',
      diagLog: '诊断日志位于 .meetingstone/runs',
      errorWarning: '最近一次错误',
      errorDetails: '查看详情',
      errorHideDetails: '收起详情',
      // CLI 分类
      categoryHost: '宿主',
      categoryExternal: '外部',
      hostName: 'DeepSeek Harness',
      hostRunning: '运行中',
      // 顶部集合石入口 + 右侧栏只读角色面板
      headerTitle: '集合石角色',
      headerDesc: '查看当前会话角色（只读）',
      tabTitle: '集合石角色',
      paneTitle: '当前会话角色（只读）',
      paneReadonlyNote: '当前版本只读（展示全局角色库）；会话级覆盖编辑待宿主生成式 Remote 支持',
      openPanel: '打开集合石角色面板',
      noRoles: '当前没有可用角色',
      aliasLabel: '别名',
      channelLabel: '通道',
      remoteUnavailableHint: '远程不可用',
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
      channelInstances: 'Channel instances',
      configFile: 'Config file',
      openConfig: 'Open config file',
      diagLog: 'Diagnostic logs are under .meetingstone/runs',
      errorWarning: 'Most recent error',
      errorDetails: 'View details',
      errorHideDetails: 'Hide details',
      // CLI 分类
      categoryHost: 'Host',
      categoryExternal: 'External',
      hostName: 'DeepSeek Harness',
      hostRunning: 'Running',
      // 顶部集合石入口 + 右侧栏只读角色面板
      headerTitle: 'MeetingStone Roles',
      headerDesc: 'View session roles (read-only)',
      tabTitle: 'MeetingStone Roles',
      paneTitle: 'Session roles (read-only)',
      paneReadonlyNote:
        'Read-only in this version (global role library); session-level overrides await host-generated Remote support',
      openPanel: 'Open MeetingStone role panel',
      noRoles: 'No roles available',
      aliasLabel: 'Aliases',
      channelLabel: 'Channel',
      remoteUnavailableHint: 'Remote unavailable',
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

    /**
     * CLI 连接：紧凑一行一个（名称 + 版本 + 状态），并区分宿主 / 外部 CLI。
     * 宿主行是当前 DSH（页面能渲染即说明宿主在运行）；外部行只投影真实探测结果，
     * 拿不到就明说，不猜。
     */
    function CliList({ t, global, remoteOk }) {
      const hostRow = jsxs(
        'div',
        {
          style: row,
          children: [
            jsx('span', { style: category, children: t('categoryHost') }),
            jsx('span', { children: t('hostName') }),
            jsx('span', { style: meta, children: '—' }),
            jsx('span', { style: grow }),
            remoteOk === false
              ? jsx(Tag, { tone: 'danger', children: t('remoteUnavailableHint') })
              : jsx(Tag, { tone: 'info', children: t('hostRunning') }),
          ],
        },
        'host',
      )

      /** @type {any[]} */
      const children = [hostRow]
      if (!global.cli) {
        const message = global.cliError === 'CLI_PROBE_TIMEOUT' ? t('cliTimeout') : t('noCli')
        children.push(jsx('p', { style: note, children: message }, 'cli-note'))
      } else if (global.cli.length === 0) {
        children.push(jsx('span', { style: dim, children: t('none') }, 'cli-none'))
      } else {
        for (const item of global.cli) {
          const label = item.label || item.cli || t('unknown')
          const version = item.installed ? item.version : ''
          children.push(
            jsxs(
              'div',
              {
                style: row,
                children: [
                  jsx('span', { style: category, children: t('categoryExternal') }),
                  jsx('span', { children: label }),
                  version ? jsx('span', { style: code, children: `v${version.replace(/^v/, '')}` }) : null,
                  jsx('span', { style: grow }),
                  jsx(Tag, {
                    tone: item.installed ? 'info' : 'neutral',
                    children: item.installed ? t('installed') : t('notInstalled'),
                  }),
                ],
              },
              item.cli || label,
            ),
          )
        }
      }
      return jsxs('div', { style: list, children })
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
     * 不依赖 React 状态机。advancedOpen 默认 false（高级区默认收起）。
     * @param {(key: string) => string} t
     * @param {any} snapshot
     * @param {{
     *   advancedOpen?: boolean,
     *   errorOpen?: boolean,
     *   openRoles?: () => void,
     *   onToggleAdvanced?: () => void,
     *   onToggleError?: () => void,
     * }} opts
     */
    function renderSection(t, snapshot, opts = {}) {
      const global = snapshot.global
      const advancedOpen = opts.advancedOpen === true
      const errorOpen = opts.errorOpen === true
      const openRoles = typeof opts.openRoles === 'function' ? opts.openRoles : () => {}
      const onToggleAdvanced =
        typeof opts.onToggleAdvanced === 'function' ? opts.onToggleAdvanced : () => {}
      const onToggleError = typeof opts.onToggleError === 'function' ? opts.onToggleError : () => {}

      const roleCount = snapshot.roles.length
      const defaultRole = global.defaultRoleId
        ? snapshot.roles.find((role) => role.roleId === global.defaultRoleId)
        : undefined
      const defaultRoleLabel = defaultRole
        ? `${defaultRole.name || defaultRole.roleId}（${defaultRole.roleId}）`
        : t('notSet')
      const limits = global.limits

      // 错误：首屏一行摘要（不换行）；详情默认折叠，点击展开。无错误不占位。
      const lastError = snapshot.lastError
      const errorCard = !lastError
        ? null
        : jsxs('div', {
            role: 'alert',
            style: { ...card, borderColor: 'var(--dsw-alias-state-error-primary)' },
            children: [
              jsxs('div', {
                style: alignRow,
                children: [
                  jsx(Tag, { tone: 'danger', children: t('errorWarning') }),
                  jsx('span', {
                    style: { ...grow, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                    children: `[${lastError.code}] ${lastError.message || t('unknown')}`,
                  }),
                  jsx('button', {
                    type: 'button',
                    style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 },
                    'aria-expanded': errorOpen,
                    onClick: onToggleError,
                    children: errorOpen ? t('errorHideDetails') : t('errorDetails'),
                  }),
                ],
              }),
              errorOpen
                ? jsxs('div', {
                    style: { ...note, display: 'flex', flexDirection: 'column', gap: 4 },
                    children: [
                      jsx('div', { children: lastError.message || t('unknown') }),
                      jsx('div', { style: meta, children: `${lastError.code}${lastError.source ? ` · ${lastError.source}` : ''}` }),
                      lastError.at ? jsx('div', { style: meta, children: lastError.at }) : null,
                    ],
                  })
                : null,
            ],
          })

      // 高级区（默认收起）：隔离 / CLI 完整路径 / 通道实例 / 配置文件 / 日志目录。
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
              jsx('div', { style: subheading, children: t('channelInstances') }),
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
          // 区 1：CLI 连接（紧凑一行一个：宿主 / 外部 CLI + 版本 + 状态）。
          jsx('h3', { style: heading, children: t('cli') }),
          jsx('div', {
            style: card,
            children: jsx(CliList, { t, global, remoteOk: !snapshot.unavailable }),
          }),
          // 区 2：默认协作配置（角色数量 + 默认角色 + 管理入口合并为一行）。
          jsx('h3', { style: heading, children: t('collab') }),
          jsx('div', {
            style: card,
            children: jsxs('div', {
              style: list,
              children: [
                jsxs('div', {
                  style: { ...alignRow, flexWrap: 'wrap' },
                  children: [
                    jsx('span', { children: t('roleCount') }),
                    jsx('span', { style: dim, children: String(roleCount) }),
                    jsx('span', { style: dim, children: '·' }),
                    jsx('span', { children: t('defaultRole') }),
                    jsx('span', { style: dim, children: defaultRoleLabel }),
                    jsx('span', { style: grow }),
                    jsx('button', {
                      type: 'button',
                      style: { ...dim, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 },
                      onClick: openRoles,
                      children: t('manageRoles'),
                    }),
                  ],
                }),
                jsxs('div', {
                  style: alignRow,
                  children: [
                    jsx('span', { children: t('parallelLimit') }),
                    jsx('span', { style: alignValue, children: String(limits.maxParallelWritesTotal) }),
                  ],
                }),
                jsxs('div', {
                  style: alignRow,
                  children: [
                    jsx('span', { children: t('serializeWrites') }),
                    jsx('span', { style: alignValue, children: limits.serializeWrites ? t('on') : t('off') }),
                  ],
                }),
                jsxs('div', {
                  style: alignRow,
                  children: [
                    jsx('span', { children: t('dispatchNotes') }),
                    jsx('span', { style: alignValue, children: global.dispatchNotes || t('none') }),
                  ],
                }),
              ],
            }),
          }),
          // 区 3：高级设置（默认收起）。
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
      const [errorOpen, setErrorOpen] = react.useState(false)
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
            errorOpen,
            openRoles,
            onToggleAdvanced: () => setAdvancedOpen(!advancedOpen),
            onToggleError: () => setErrorOpen(!errorOpen),
          }),
        ],
      })
    }

    /** 打开右侧栏角色面板：官方入口是 ctx.sidebarRight.openTab(kind, { params })。 */
    function openRolePanelOf(slotCtx) {
      try {
        const right = typeof slotCtx.get === 'function' ? slotCtx.get('sidebarRight') : undefined
        right?.openTab?.(TAB_KIND, { params: {} })
      } catch {
        /* 宿主未提供 openTab 时静默 */
      }
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
     * @param {{ code?: string, message?: string }} [mountFailure]
     */
    function makeLoader(serviceOrGet, mountFailure) {
      return async () => {
        // $mount 已失败：命名空间服务不可用，不再尝试调用（避免读到残留对象）。
        if (mountFailure) {
          return unavailableSnapshot(
            mountFailure.code ?? 'REMOTE_MOUNT_FAILED',
            mountFailure.message ?? 'remote.meetingstone 挂载失败',
          )
        }
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
      if (
        !slotCtx?.slots ||
        typeof slotCtx.slots.inject !== 'function' ||
        typeof slotCtx.slots.register !== 'function'
      ) {
        throw new Error('CAPABILITY_MISSING: slots.inject/register')
      }
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
                  openRolePanelOf(slotCtx)
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

    /**
     * 右侧栏只读面板。会话级覆盖编辑（原 get/set/clearSessionOverride）
     * **暂不接入**：手写带参 Remote 被宿主 Gateway strict codec 拒绝（真机证据见
     * 文件头与 docs/gui-0.2.0.md §6）。这里只消费无参 `list()` 快照。
     */
    function channelTextOf(role, t) {
      const parts = [role.channelId, role.provider, role.model].filter(Boolean)
      return parts.length > 0 ? parts.join(' · ') : t('notSet')
    }

    /** 单个角色的只读卡片：名称 / 别名 / 可用性 / 通道。 */
    function RoleReadonlyCard({ t, role }) {
      const badge = availabilityBadge(t, role.availability)
      const aliases = asArray(role.aliases).filter(Boolean)
      return jsxs('div', {
        style: { ...card, gap: 4 },
        children: [
          jsxs('div', {
            style: { ...row, alignItems: 'flex-start' },
            children: [
              jsx('strong', { children: role.name || role.roleId || t('unknown') }),
              jsx('span', { style: grow }),
              jsx(Tag, { tone: badge.tone, children: badge.label }),
            ],
          }),
          jsxs('div', {
            style: meta,
            children: [`${t('aliasLabel')}: `, aliases.length > 0 ? aliases.join(', ') : t('none')],
          }),
          jsxs('div', {
            style: meta,
            children: [`${t('channelLabel')}: `, channelTextOf(role, t)],
          }),
        ],
      })
    }

    /** 纯函数渲染只读面板，便于 stub harness 断言结构。 */
    function renderRolePane(t, snapshot) {
      const roles = asArray(snapshot?.roles)
      const unavailable = snapshot?.unavailable
      return jsxs('div', {
        style: root,
        children: [
          jsx('h3', { style: heading, children: t('paneTitle') }),
          jsx('p', { style: note, role: 'status', children: t('paneReadonlyNote') }),
          unavailable
            ? jsx('p', {
                style: { ...note, color: 'var(--dsw-alias-state-error-primary)' },
                role: 'status',
                children: `${t('unavailable')} · ${unavailable.message || unavailable.code}`,
              })
            : null,
          roles.length === 0
            ? jsx('p', { style: note, children: t('noRoles') })
            : jsxs('div', {
                style: list,
                children: roles.map((role) => jsx(RoleReadonlyCard, { t, role }, role.roleId || role.name)),
              }),
        ],
      })
    }

    /**
     * 标题右侧入口：图标按钮（宿主 Icon，回退文字）；点击打开右侧栏 tab。
     * `$mount` 失败时入口仍然存在：标题/点击提示「远程不可用」，不擅自消失。
     */
    function HeaderEntry({ t, openRolePanel, remoteReady }) {
      const label = t('headerTitle')
      const remoteOk = remoteReady !== false
      const desc = remoteOk ? t('headerDesc') : t('remoteUnavailableHint')
      const [notice, setNotice] = react.useState(null)
      const icon =
        typeof primitives.Icon === 'function'
          ? jsx(primitives.Icon, { name: 'users', 'aria-label': label, title: desc })
          : jsx('span', { children: label })
      return jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
        children: [
          jsx('button', {
            type: 'button',
            className: 'dsh-meetingstone-header-entry',
            'aria-label': label,
            title: desc,
            onClick: () => {
              if (!remoteOk) {
                // 入口保留，点击给出可读提示（不弹宿主 modal、不写凭证）。
                setNotice(t('remoteUnavailableHint'))
                return
              }
              try {
                if (openRolePanel) openRolePanel()
              } catch {
                /* 宿主未提供 sidebarRightTabs.open 时静默 */
              }
            },
            children: icon,
          }),
          notice
            ? jsx('span', {
                role: 'status',
                style: { ...meta, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap' },
                children: notice,
              })
            : null,
        ],
      })
    }

    /** 右侧栏 tab 标题。 */
    function SidebarRoleTitle({ t }) {
      return jsx('span', { children: t('tabTitle') })
    }

    /** 右侧栏只读面板：拉取 `list()` 快照 → 渲染角色名/别名/可用性/通道。 */
    function SidebarRolePane({ t, list: load }) {
      const [state, setState] = react.useState({ status: 'loading' })
      react.useEffect(() => {
        let current = true
        Promise.resolve()
          .then(() => (typeof load === 'function' ? load() : null))
          .then(
            (snapshot) => {
              if (current) setState({ status: 'ready', snapshot })
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
      }, [load])

      if (state.status === 'loading') {
        return jsx('div', { style: note, children: t('loading') })
      }
      if (state.status === 'error') {
        return jsxs('div', {
          role: 'alert',
          children: [
            jsx('p', { style: note, children: t('loadFailed') }),
            jsx('p', { style: note, children: state.message }),
          ],
        })
      }
      return renderRolePane(t, state.snapshot)
    }

    /**
     * 注册 title 右侧入口 `conversation.session.header.actions`（kind:list, scope:session）。
     * 注册形状对齐官方：{ name, id, order, locale, inject(sessionId) }。
     *
     * 入口注册**独立于** Remote 是否可挂载：`$mount` 失败时仍然注册，只是把
     * `remoteReady:false` 传进组件，点击显示「远程不可用」。
     * @param {any} slotCtx
     * @param {{ getService: () => any | null, mountError: string | null }} deps
     * @param {(key: string) => string} t
     */
    function registerHeaderAction(slotCtx, deps, t) {
      if (
        !slotCtx?.slots ||
        typeof slotCtx.slots.inject !== 'function' ||
        typeof slotCtx.slots.register !== 'function'
      ) {
        throw new Error('CAPABILITY_MISSING: slots.inject/register')
      }
      const openPanel = () => {
        try {
          openRolePanelOf(slotCtx)
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
            inject: (/** @type {string} */ sessionId) => ({
              sessionId,
              openRolePanel: openPanel,
              // 只有 $mount 明确失败才提示不可用；命名空间可能稍后就绪，
              // 面板 loader 自己会回退到 unavailable 快照。
              remoteReady: !deps.mountError,
              t,
            }),
          },
          HeaderEntry,
        ),
      )
    }

    /**
     * 两步式注册右侧栏 tab：先 `sidebarRightTabs.register` 注册 tab，再注册两个
     * keyed seat（内容 + 标题，scope session）。面板只读，数据来自无参 `list()`。
     * @param {any} slotCtx
     * @param {{ getService: () => any | null, mountError: string | null }} deps
     * @param {(key: string) => string} t
     */
    function registerSidebarTab(slotCtx, deps, t) {
      if (
        !slotCtx?.slots ||
        typeof slotCtx.slots.inject !== 'function' ||
        typeof slotCtx.slots.register !== 'function'
      ) {
        throw new Error('CAPABILITY_MISSING: slots.inject/register')
      }
      // 1) tab 本体（能力检测后调用；没有该服务时仍注册 seat，不拖垮其他模块）
      const tabs = sidebarRightTabsOf(slotCtx)
      if (tabs && typeof tabs.register === 'function') {
        tabs.register({
          id: TAB_ID,
          kind: 'meetingstone-roles',
          priority: 50,
          title: () => t('tabTitle'),
        })
      }
      const loader = makeLoader(
        deps.getService,
        deps.mountError ? { code: 'REMOTE_MOUNT_FAILED', message: deps.mountError } : undefined,
      )
      // 2) keyed seats（scope session）
      slotCtx.slots.inject('sidebar.right.pane.tab', () =>
        slotCtx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            inject: (/** @type {string} */ sessionId) => ({ sessionId, list: loader, t }),
          },
          SidebarRolePane,
        ),
      )
      slotCtx.slots.inject('sidebar.right.pane.tab.title', () =>
        slotCtx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID,
            locale: NS,
            inject: () => ({ t }),
          },
          SidebarRoleTitle,
        ),
      )
    }

    /**
     * 挂载 GUI。注册与 `remote.meetingstone` 的就绪**解耦**：
     *
     * 0.1.0-alpha 真机事故：把 slot 注册放进 `ctx.inject(['remote.meetingstone'], cb)`，
     * 该服务由 $mount 在子 fiber provide，父 fiber 的注入回调并不保证被唤醒；
     * 结果是设置页与对话顶部入口**都不出现**（用户看到的就是这个）。
     * 现在：先注册 header / section / sidebar，服务读取走 `ctx.get()` 惰性获取；
     * 取不到时显示 unavailable 快照，而不是让整个 UI 消失。
     *
     * 注册顺序固定为 **header → section → sidebar**，每段独立 guard。任何一段失败
     * 只写一条统一格式日志（模块 / 阶段 / 插件版本 / 堆栈），不影响其他段，也不
     * 拖垮宿主启动。日志不记录任何凭证（只记 error message 与 stack）。
     */
    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meetingstone: section dictionaries')

      /** 统一 GUI 注册日志：module / phase / version / detail（error+stack）。 */
      const log = (/** @type {string} */ level, /** @type {string} */ module, /** @type {string} */ phase, /** @type {string} */ detail = '') => {
        const line = `[meetingstone] gui module=${module} phase=${phase} version=${PLUGIN_VERSION}${
          detail ? ` ${detail}` : ''
        }`
        try {
          const fn = ctx.logger && typeof ctx.logger[level] === 'function' ? ctx.logger[level] : null
          if (fn) fn.call(ctx.logger, line)
          else if (level === 'error') console.error(line)
          else if (level === 'warn') console.warn(line)
          else console.log(line)
        } catch {
          /* logger 不可用 */
        }
      }

      const guard = (/** @type {string} */ module, /** @type {string} */ phase, /** @type {() => void} */ fn) => {
        try {
          fn()
          log('info', module, phase, 'status=ok')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const stack =
            error instanceof Error && error.stack ? String(error.stack).replace(/\s+/g, ' ').slice(0, 600) : ''
          guiErrors.push(`${module}: ${message}`)
          log('error', module, phase, `error=${message}${stack ? ` stack=${stack}` : ''}`)
        }
      }

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

      // 1) Remote contribution：先做能力检测；失败只记 mountError，下面照常注册。
      let mountError = null
      let unmount = null
      if (!z) {
        log('warn', 'remote', 'strict', 'error=ZOD_UNAVAILABLE')
      }
      if (typeof ctx.remote?.$mount !== 'function') {
        mountError = 'CAPABILITY_MISSING: ctx.remote.$mount'
        log('warn', 'remote', 'mount', `error=${mountError}`)
      } else {
        try {
          unmount = await ctx.remote.$mount(REMOTE_CONTRIBUTION)
          log('info', 'remote', 'mount', 'status=ok')
        } catch (error) {
          mountError = error instanceof Error ? error.message : String(error)
          const stack =
            error instanceof Error && error.stack ? String(error.stack).replace(/\s+/g, ' ').slice(0, 600) : ''
          log('error', 'remote', 'mount', `error=${mountError}${stack ? ` stack=${stack}` : ''}`)
        }
      }
      // $mount 返回卸载函数；绑定到本插件 effect，卸载/重载时回收命名空间服务。
      if (typeof unmount === 'function') {
        ctx.effect(() => () => unmount(), 'meetingstone: remote contribution')
      }

      const deps = { getService, mountError }
      const mountFailure = mountError ? { code: 'REMOTE_MOUNT_FAILED', message: mountError } : undefined

      // 2) 注册顺序：header → section → sidebar。header 永不因 mount 失败而缺失。
      guard('header', 'register', () => registerHeaderAction(ctx, deps, t))
      guard('section', 'register', () => registerSection(ctx, makeLoader(getService, mountFailure), t))
      guard('sidebar', 'register', () => registerSidebarTab(ctx, deps, t))
    }

    exports.apply = apply
    exports.inject = inject
    // stub harness 用的纯函数；生产路径不依赖该导出。
    exports.__test = {
      normalizeSnapshot,
      normalizeGlobal,
      unavailableSnapshot,
      renderSection,
      renderRolePane,
      RoleReadonlyCard,
      CliList,
      CliPaths,
      ChannelModels,
      REMOTE_CONTRIBUTION,
      SESSION_DESCRIPTORS,
      SESSION_TYPES,
      REMOTE_INJECT,
      TAB_ID,
      HEADER_ACTION_ID,
      PLUGIN_VERSION,
      makeLoader,
    }
    return module.exports
  },
})
