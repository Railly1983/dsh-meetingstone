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
 *      · 只读 Tag 的官方外观（P0-U0 取证：`._tag_*[data-tone=...]` CSS）
 *      · `inject: ["remote","remote.pluginInventory"]` + `ctx.remote.pluginInventory.list()`
 *      · ⚠️ 官方内部用 `@deepseek-ai/dsh-client-ui-primitives`，但该包不在 app.asar 的
 *        node_modules，且官方 `practices.md:35` 禁止第三方插件 require；本文件因此
 *        **不 require primitives**，改为本地最小 Tag（span + `--dsw-alias-*` token）
 *        与 16px 内联 SVG（图标不引入新库）。
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


    /** 顶层 require 失败也不能让入口激活失败（宿主按 entry 判死）。 */
    function safeRequire(name, fallback) {
      try {
        return require(name)
      } catch (error) {
        try {
          console.error('[meetingstone] client require failed:', name, error)
        } catch {}
        return fallback
      }
    }

    let jsxRuntime = safeRequire('react/jsx-runtime', { jsx: () => null, jsxs: () => null })
    let react = safeRequire('react', {
      createElement: () => null,
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useCallback: (fn) => fn,
      useRef: () => ({ current: null }),
    })
    let jsx = jsxRuntime.jsx
    let jsxs = jsxRuntime.jsxs

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
      cliName: 'dsh-meetingstone/types#CliName',
      booleanValue: 'dsh-meetingstone/types#BooleanValue',
      jsonResult: 'dsh-meetingstone/types#JsonResult',
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
    const cliNameCodec = () =>
      strictCodec(SESSION_TYPES.cliName, () => z.enum(['codex', 'codebuddy', 'claude']))
    const booleanCodec = () => strictCodec(SESSION_TYPES.booleanValue, () => z.boolean())

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
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/setCliEnabled`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'setCliEnabled',
            parameters: [
              { name: 'cli', wire: 'cli', source: 'json', codec: cliNameCodec() },
              { name: 'enabled', wire: 'enabled', source: 'json', codec: booleanCodec() },
            ],
            invocation: { kind: 'direct' },
            result: { mode: 'src-json' },
          },
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/refreshCli`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'refreshCli',
            parameters: [
              { name: 'cli', wire: 'cli', source: 'json', codec: cliNameCodec() },
              { name: 'force', wire: 'force', source: 'json', codec: booleanCodec() },
            ],
            invocation: { kind: 'direct' },
            result: { mode: 'src-json' },
          },
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/updateGlobalRole`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'updateGlobalRole',
            parameters: [
              { name: 'roleId', wire: 'roleId', source: 'json', codec: roleIdCodec() },
              { name: 'patch', wire: 'patch', source: 'json', codec: jsonValueCodec() },
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

    /** 外部 CLI 的固定顺序（与 Host `CLI_NAMES` 一致；详情页三行只显示这三个）。 */
    const CLI_NAMES = ['codex', 'codebuddy', 'claude']
    const CLI_LABELS = {
      codex: 'Codex',
      codebuddy: 'CodeBuddy',
      claude: 'Claude Code',
    }

    /**
     * CLI「偏好 + preflight」状态 → 只读视图。
     * 只认稳定枚举；拿不到证据时 `ready='unknown'`、`enabled=false`，不猜。
     */
    function normalizeCliState(item, cli) {
      const source = asObject(item)
      const name = asString(source.cli) || cli
      const ready = source.ready === 'ready' || source.ready === 'blocked' ? source.ready : 'unknown'
      return {
        cli: name,
        label: asString(source.label) || CLI_LABELS[name] || name,
        category: 'external',
        userPreference:
          source.userPreference === 'enabled' || source.userPreference === 'disabled'
            ? source.userPreference
            : 'unset',
        enabled: source.enabled === true,
        ready,
        blockedReason: ready === 'ready' ? null : asString(source.blockedReason) || 'evidence-missing',
        manualSteps: asArray(source.manualSteps).map(String).slice(0, 6),
        retryable: source.retryable === true,
        autoFix: false,
        installed: source.installed === true,
        version: asString(source.version),
        path: asString(source.path),
        source: asString(source.source),
        login: source.login === true || source.login === false ? source.login : 'unknown',
        hostIntegration:
          source.hostIntegration === true || source.hostIntegration === false
            ? source.hostIntegration
            : 'unknown',
        firstDetection: source.firstDetection === true,
        notes: asArray(source.notes).map(String).slice(0, 8),
        checkedAt: typeof source.checkedAt === 'string' ? source.checkedAt : null,
      }
    }

    /** CLI 数组 → 固定三行；缺失项按 unknown/关闭呈现（不伪造已检测）。 */
    function normalizeCli(value) {
      if (!Array.isArray(value)) return null
      const byCli = new Map()
      for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const cli = asString(item.cli)
        if (!CLI_NAMES.includes(cli)) continue
        byCli.set(cli, normalizeCliState(item, cli))
      }
      return CLI_NAMES.map(
        (cli) =>
          byCli.get(cli) ?? {
            cli,
            label: CLI_LABELS[cli],
            category: 'external',
            userPreference: 'unset',
            enabled: false,
            ready: 'unknown',
            blockedReason: 'evidence-missing',
            manualSteps: [],
            retryable: true,
            autoFix: false,
            installed: false,
            version: '',
            path: '',
            source: '',
            login: 'unknown',
            hostIntegration: 'unknown',
            firstDetection: false,
            notes: [],
            checkedAt: null,
          },
      )
    }

    /** 通道实例 → 只读选项（频道/模型/强度选项的唯一来源）。 */
    function normalizeChannelOption(channel) {
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

    /** 来源层只认三层继承的固定枚举；其余一律 unknown（不猜）。 */
    const SOURCE_LAYERS = new Set(['global', 'project', 'session'])

    /** 三色/就绪/额度只认稳定枚举（Host `deriveRoleView` 的产物）。 */
    function normalizeRoleState(value) {
      const source = asObject(value)
      const preference = source.userPreference
      const readiness = source.readiness
      const quota = source.quota
      const color = source.color
      return {
        userPreference:
          preference === 'enabled' || preference === 'disabled' ? preference : 'unset',
        readiness:
          readiness === 'ready' || readiness === 'blocked' ? readiness : 'unknown',
        readinessReason: asString(source.readinessReason) || 'PROVIDER_EVIDENCE_MISSING',
        quota:
          quota === 'available' || quota === 'exhausted' || quota === 'not_applicable'
            ? quota
            : 'unknown',
        color: color === 'green' || color === 'yellow' ? color : 'gray',
        availability: asString(source.availability) || 'unknown',
      }
    }

    /**
     * 会话生效视图 `{ effective, overrides, sources, channels, roleStates }` → 只读投影。
     *
     * Remote 返回值是外部数据：逐字段收窄。`sources.roles[roleId].fields` 给出
     * 每个字段的来源层；`roleStates` 给出三色（缺失时按灰/未知，不伪造 ready）。
     * @param {unknown} value
     */
    function normalizeSessionConfigView(value) {
      const source = asObject(value)
      const effective = asObject(source.effective)
      const overrides = asObject(source.overrides)
      const sources = asObject(source.sources)
      const roleSources = asObject(sources.roles)
      const stateById = new Map()
      for (const item of asArray(source.roleStates)) {
        const state = normalizeRoleState(item)
        const roleId = asString(asObject(item).roleId)
        if (roleId) stateById.set(roleId, state)
      }
      const fieldKeys = ['name', 'aliases', 'description', 'prompt', 'enabled']
      const channelKeys = ['channelId', 'kind', 'provider', 'cli', 'model', 'reasoning']

      /** @type {any[]} */
      const roles = asArray(effective.roles)
        .filter((role) => role && typeof role === 'object')
        .map((role) => {
          const roleId = asString(role.roleId)
          const roleSource = asObject(roleSources[roleId])
          const layer = SOURCE_LAYERS.has(asString(roleSource.layer))
            ? asString(roleSource.layer)
            : 'unknown'
          const channel = asObject(role.channel)
          const overridePatch = asObject(overrides[roleId])
          const rawFields = asObject(roleSource.fields)
          /** @type {Record<string, string>} */
          const fieldSources = {}
          for (const key of fieldKeys) {
            const value = asString(rawFields[key])
            fieldSources[key] = SOURCE_LAYERS.has(value) ? value : 'default'
          }
          for (const key of channelKeys) {
            const value = asString(rawFields[`channel.${key}`])
            fieldSources[`channel.${key}`] = SOURCE_LAYERS.has(value) ? value : 'default'
          }
          const fallback = normalizeRoleState({
            userPreference: role.enabled === false ? 'disabled' : 'unset',
            readiness: 'unknown',
            quota: 'unknown',
            color: 'gray',
            availability: 'unknown',
          })
          return {
            roleId,
            name: asString(role.name),
            aliases: asArray(role.aliases).map(String),
            description: asString(role.description),
            prompt: asString(role.prompt),
            enabled: role.enabled !== false,
            channel: {
              channelId: asString(channel.channelId),
              kind: asString(channel.kind),
              provider: asString(channel.provider),
              cli: asString(channel.cli),
              model: asString(channel.model),
              reasoning: asString(channel.reasoning),
            },
            channelId: asString(channel.channelId),
            provider: asString(channel.provider),
            model: asString(channel.model),
            reasoning: asString(channel.reasoning),
            sourceLayer: layer,
            fieldSources,
            overrideFields: Object.keys(overridePatch).sort(),
            state: stateById.get(roleId) ?? fallback,
          }
        })
      return {
        roles,
        defaultRoleId: asString(effective.defaultRoleId),
        defaultRoleSource: SOURCE_LAYERS.has(asString(sources.defaultRoleId))
          ? asString(sources.defaultRoleId)
          : 'default',
        // 详情页下拉只列真实通道实例；空数组表示「待配置」，不补造模型表。
        channels: asArray(source.channels).map(normalizeChannelOption),
        warnings: asArray(source.warnings)
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            code: asString(item.code) || 'SESSION_CONFIG_WARNING',
            message: asString(item.message),
          })),
      }
    }

    /**
     * 侧栏只读 loader：调用 strict `getSessionConfig(sessionId)`。
     * **不抛**：成功 `{ ok:true, view }`，失败 `{ ok:false, error:{ code, message } }`，
     * 让面板能显示一行错误摘要而不是空白/崩溃。能力检测后才调用。
     * @param {any | (() => any | null)} serviceOrGet
     * @param {string | null} [mountFailure]
     */
    function makeSessionConfigLoader(serviceOrGet, mountFailure) {
      return async (sessionId) => {
        if (mountFailure) {
          return { ok: false, error: { code: 'REMOTE_MOUNT_FAILED', message: mountFailure } }
        }
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { ok: false, error: { code: 'SESSION_ID_MISSING', message: '缺少会话 id' } }
        }
        const service = typeof serviceOrGet === 'function' ? serviceOrGet() : serviceOrGet
        if (!service || typeof service.getSessionConfig !== 'function') {
          return {
            ok: false,
            error: {
              code: 'REMOTE_UNAVAILABLE',
              message: 'remote.meetingstone.getSessionConfig 尚未就绪',
            },
          }
        }
        try {
          const result = await service.getSessionConfig(sessionId)
          if (!result || result.ok !== true) {
            const failure = asObject(result && result.error)
            return {
              ok: false,
              error: {
                code: asString(failure.code) || 'REMOTE_CALL_FAILED',
                message: asString(failure.message),
              },
            }
          }
          return { ok: true, view: normalizeSessionConfigView(result.value) }
        } catch (error) {
          return {
            ok: false,
            error: {
              code:
                error && typeof error === 'object' && typeof error.code === 'string'
                  ? error.code
                  : 'REMOTE_CALL_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
    }

    /**
     * 统一 Remote 调用：能力检测 + `{ok,value}` 解包 + 不抛错。
     * 写操作失败必须原样返回错误（调用方不做乐观更新）。
     * @param {any | (() => any | null)} serviceOrGet
     * @param {string | null | undefined} mountFailure
     */
    function makeRemoteCall(serviceOrGet, mountFailure) {
      return async (method, args = []) => {
        if (mountFailure) {
          return { ok: false, error: { code: 'REMOTE_MOUNT_FAILED', message: mountFailure } }
        }
        const service = typeof serviceOrGet === 'function' ? serviceOrGet() : serviceOrGet
        if (!service || typeof service[method] !== 'function') {
          return {
            ok: false,
            error: { code: 'REMOTE_UNAVAILABLE', message: `remote.meetingstone.${method} 尚未就绪` },
          }
        }
        try {
          const envelope = await service[method](...args)
          if (!envelope || envelope.ok !== true) {
            const failure = asObject(envelope && envelope.error)
            return {
              ok: false,
              error: {
                code: asString(failure.code) || 'REMOTE_CALL_FAILED',
                message: asString(failure.message),
              },
            }
          }
          const payload = envelope.value
          // Host 业务失败也放在 `value.ok:false` 里（Gateway 传输本身成功）：
          // 写操作必须把它当失败返回，调用方才能不做乐观更新。
          if (payload && typeof payload === 'object' && payload.ok === false) {
            return {
              ok: false,
              error: {
                code: asString(payload.code) || 'REMOTE_CALL_FAILED',
                message: asString(payload.message) || '操作失败',
                data: payload,
              },
            }
          }
          return { ok: true, value: payload }
        } catch (error) {
          return {
            ok: false,
            error: {
              code:
                error && typeof error === 'object' && typeof error.code === 'string'
                  ? error.code
                  : 'REMOTE_CALL_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
    }

    /** 会话写操作（只写当前会话覆盖；不碰全局/项目）。 */
    function makeSessionActions(serviceOrGet, mountFailure) {
      const call = makeRemoteCall(serviceOrGet, mountFailure)
      return {
        setOverride: (sessionId, roleId, field, value) =>
          call('setSessionOverride', [sessionId, roleId, field, value]),
        clearOverride: (sessionId, roleId, field) =>
          call('clearSessionOverride', [sessionId, roleId, field]),
      }
    }

    /** 配置写/检测操作（CLI 开关 + 全局角色；全局写入由调用方二次确认）。 */
    function makeConfigActions(serviceOrGet, mountFailure) {
      const call = makeRemoteCall(serviceOrGet, mountFailure)
      return {
        setCliEnabled: (cli, enabled) => call('setCliEnabled', [cli, enabled]),
        refreshCli: (cli, force) => call('refreshCli', [cli, Boolean(force)]),
        updateGlobalRole: (roleId, patch) => call('updateGlobalRole', [roleId, patch]),
      }
    }

    // 直接消费宿主主题 token，不自带色板/框架；间距、字号沿用官方 settings-plugins
    // 的 CSS module（gap 12/10px、13px/20px、max-width 760px）。
    const C = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
    }

    /**
     * 本地最小 Tag：外观逐条抄宿主官方 `._tag_*[data-tone=...]` CSS
     * （docs/gui-api-verification.md §8 / P0-U0 取证），只用 `--dsw-alias-*` token。
     * 不 require primitives（该包不在 asar node_modules，且官方禁止第三方插件 require）。
     */
    const TAG_BASE = {
      display: 'inline-flex',
      alignItems: 'center',
      borderRadius: 999,
      padding: '1px 8px',
      fontSize: 11,
      lineHeight: '17px',
      fontWeight: 500,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    }
    const TAG_TONES = {
      outline: {
        border: '0.5px solid var(--dsw-alias-border-l4)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      solid: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)' },
      neutral: {
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      quiet: { color: 'var(--dsw-alias-label-tertiary)' },
      success: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      info: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-business-primary)',
      },
      warning: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      danger: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
    }

    /** @param {{ tone?: string, children?: any }} props */
    function Tag(props) {
      const tone = typeof props?.tone === 'string' && TAG_TONES[props.tone] ? props.tone : 'outline'
      return jsx('span', {
        'data-tone': tone,
        style: { ...TAG_BASE, ...TAG_TONES[tone] },
        children: props?.children,
      })
    }

    /**
     * 原生 Two-state Switch（**不自绘三态控件**）：`button[role=switch]` +
     * `aria-checked`，轨道颜色只表达「三色语义」（灰/黄/绿），状态本身仍是开/关。
     * 不依赖 primitives（官方包不可 require），不使用 DOM/CSS 注入。
     * @param {{
     *   checked: boolean,
     *   label: string,
     *   title?: string,
     *   disabled?: boolean,
     *   color?: 'gray' | 'yellow' | 'green',
     *   onChange?: (next: boolean) => void,
     * }} props
     */
    function Switch(props) {
      const checked = props?.checked === true
      const color = props?.color === 'green' || props?.color === 'yellow' ? props.color : 'gray'
      const offTrack = 'var(--dsw-alias-border-l4)'
      const onTrack =
        color === 'green'
          ? 'var(--dsw-alias-state-success-primary)'
          : color === 'yellow'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      const disabled = props?.disabled === true
      return jsxs('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': asString(props?.label),
        title: asString(props?.title),
        disabled,
        onClick: () => {
          if (disabled) return
          if (typeof props?.onChange === 'function') props.onChange(!checked)
        },
        style: {
          position: 'relative',
          boxSizing: 'border-box',
          width: 32,
          height: 18,
          padding: 0,
          border: 'none',
          borderRadius: 999,
          background: checked ? onTrack : offTrack,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          flexShrink: 0,
          transition: 'background 120ms ease',
        },
        children: [
          jsx('span', {
            'aria-hidden': 'true',
            style: {
              position: 'absolute',
              top: 2,
              left: checked ? 16 : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: 'var(--dsw-alias-bg-layer-3)',
              transition: 'left 120ms ease',
            },
          }),
        ],
      })
    }

    /**
     * 顶部入口图标：16px 内联 SVG（users 风格，regular stroke 1.5）。
     * 不依赖宿主 `Icon`（P0-U0 核验：无通用 Icon 导出、无 users 图标名）。
     */
    function IconUsers({ size = 16 } = {}) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }),
          jsx('circle', { cx: 9, cy: 7, r: 4 }),
          jsx('path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }),
          jsx('path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }),
        ],
      })
    }

    /**
     * 统一 GUI 日志（模块 / 阶段 / 插件版本）；apply() 时绑定 ctx.logger。
     * 渲染期崩溃也走这里，便于在宿主 boundary 吞错前留下可定位记录。
     */
    let guiLog = () => {}

    /**
     * 渲染期 guard：组件自己的渲染异常写统一日志并渲染回退节点，
     * 不让宿主 boundary 只剩一个空的 `data-slot-error`。不记录任何凭证。
     * @param {string} module
     * @param {string} phase
     * @param {() => any} render
     * @param {() => any} [fallback]
     */
    function safeRender(module, phase, render, fallback) {
      try {
        return render()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const stack =
          error instanceof Error && error.stack
            ? String(error.stack).replace(/\s+/g, ' ').slice(0, 600)
            : ''
        guiErrors.push(`${module}: ${message}`)
        guiLog('error', module, phase, `error=${message}${stack ? ` stack=${stack}` : ''}`)
        return typeof fallback === 'function' ? fallback() : null
      }
    }

    /** 渲染失败回退节点（一行可读提示，不空白）。 */
    function renderFailureNote(t) {
      return jsx('p', {
        role: 'alert',
        style: { ...note, color: 'var(--dsw-alias-state-error-primary)' },
        children: t('renderFailed'),
      })
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
      headerTitle: '角色',
      headerDesc: '查看当前会话角色（只读）',
      tabTitle: '集合石角色',
      paneTitle: '当前会话角色',
      paneReadonlyNote:
        '开关只写当前会话；灰=关闭或依赖阻断，黄=额度耗尽，绿=正常/未知。',
      openPanel: '打开集合石角色面板',
      noRoles: '当前没有可用角色',
      aliasLabel: '别名',
      channelLabel: '通道',
      roleIdLabel: '角色 ID',
      sourceLabel: '来源',
      sourceGlobal: '全局',
      sourceProject: '项目',
      sourceSession: '会话',
      sourceDefault: '默认',
      sourceUnknown: '未知',
      overrideYes: '有覆盖',
      overrideNo: '无覆盖',
      overrideFieldsLabel: '覆盖字段',
      renderFailed: '面板渲染失败，详情见宿主日志',
      remoteUnavailableHint: '远程不可用',
      // U2：设置页两区 + 角色三色二态 + 二级详情
      cliSection: '外部 CLI 连接',
      rolesSection: '默认角色配置',
      templateName: '取经五人组',
      templateDesc: '唐僧、悟空、八戒、沙僧、小白五人各司其职；模型与通道按角色单独配置。',
      cliSwitchLabel: '启用',
      cliOff: '关闭',
      cliOn: '开启',
      cliOffFailed: '关闭失败',
      cliOnFailed: '检测未通过，保持关闭',
      cliRetry: '重新检测',
      cliDetecting: '检测中…',
      manualSteps: '人工步骤',
      noCliStates: '未获取到 CLI 状态（不影响角色配置）',
      // 角色列表
      roleListTitle: '本对话角色',
      roleListNote: '开关只写当前会话；灰=关闭或依赖阻断，黄=额度耗尽，绿=正常/未知。',
      roleOpenDetail: '查看角色详情',
      roleEnabled: '已启用',
      roleDisabled: '已关闭',
      roleBlocked: '依赖阻断',
      roleQuota: '额度耗尽',
      roleUnknown: '状态未知',
      roleSwitchLabel: '启用角色',
      roleSwitchFailed: '写入失败，未改变当前状态',
      noRolesDetail: '没有可编辑的角色',
      // 详情
      detailTitle: '角色详情',
      detailBack: '返回角色列表',
      scopeSession: '本会话',
      scopeGlobal: '全局',
      scopeGlobalNote: '全局修改会写入 profile，影响所有会话；保存前需二次确认。',
      scopeGlobalBlocked: '全局层不支持恢复继承（会被项目/会话覆盖）',
      fieldName: '名称',
      fieldAliases: '简称',
      fieldDescription: '描述',
      fieldChannel: 'CLI / 通道',
      fieldModel: '模型',
      fieldReasoning: '思考强度',
      fieldPrompt: '角色 Prompt',
      fieldUnset: '未设置',
      channelUnset: '未指定通道（继承）',
      unsupported: '不支持',
      pendingConfig: '待配置',
      restoreInherit: '恢复继承',
      saveDetail: '保存修改',
      savingDetail: '保存中…',
      detailSaved: '已保存',
      detailNoChanges: '没有需要保存的差异',
      confirmGlobal: '确认写入全局配置？',
      confirm: '确认',
      cancel: '取消',
      noModelOptions: '当前通道没有配置模型',
      noReasoningOptions: '当前通道没有配置思考强度',
      sourceColumn: '来源',
      detailInvalidName: '名称不能为空',
      detailInvalidPrompt: 'Prompt 不能为空；如需恢复继承请用「恢复继承」',
      detailInvalidAliases: '简称格式：逗号分隔的字符串',
      detailReadOnly: '当前角色来自会话新增，全局层不可编辑',
      warningPrefix: '读取告警',
      loadError: '读取失败',
      required: '必填',
      unchanged: '未修改',
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
      headerTitle: 'Roles',
      headerDesc: 'View session roles (read-only)',
      tabTitle: 'MeetingStone Roles',
      paneTitle: 'Session roles',
      paneReadonlyNote:
        'The switch only writes the current session; gray=off or blocked, yellow=quota exhausted, green=ready/unknown.',
      openPanel: 'Open MeetingStone role panel',
      noRoles: 'No roles available',
      aliasLabel: 'Aliases',
      channelLabel: 'Channel',
      roleIdLabel: 'Role ID',
      sourceLabel: 'Source',
      sourceGlobal: 'Global',
      sourceProject: 'Project',
      sourceSession: 'Session',
      sourceDefault: 'Default',
      sourceUnknown: 'Unknown',
      overrideYes: 'Overridden',
      overrideNo: 'No override',
      overrideFieldsLabel: 'Override fields',
      renderFailed: 'Failed to render this panel; see host logs',
      remoteUnavailableHint: 'Remote unavailable',
      // U2: settings sections + tri-color role switches + detail view
      cliSection: 'External CLI connections',
      rolesSection: 'Default role configuration',
      templateName: 'Journey to the West five',
      templateDesc: 'Tangtang, Wukong, Bajie, Sashi and Xiaobai share duties; model and channel are configured per role.',
      cliSwitchLabel: 'Enable',
      cliOff: 'Off',
      cliOn: 'On',
      cliOffFailed: 'Failed to disable',
      cliOnFailed: 'Preflight failed; kept off',
      cliRetry: 'Re-check',
      cliDetecting: 'Checking…',
      manualSteps: 'Manual steps',
      noCliStates: 'CLI states unavailable (role configuration is unaffected)',
      roleListTitle: 'Session roles',
      roleListNote: 'The switch only writes the current session; gray=off or blocked, yellow=quota exhausted, green=ready/unknown.',
      roleOpenDetail: 'Open role detail',
      roleEnabled: 'Enabled',
      roleDisabled: 'Off',
      roleBlocked: 'Blocked',
      roleQuota: 'Quota exhausted',
      roleUnknown: 'Unknown',
      roleSwitchLabel: 'Enable role',
      roleSwitchFailed: 'Write failed; state unchanged',
      noRolesDetail: 'No editable roles',
      detailTitle: 'Role detail',
      detailBack: 'Back to role list',
      scopeSession: 'This session',
      scopeGlobal: 'Global',
      scopeGlobalNote: 'Global changes are written to the profile and affect every session; a second confirmation is required.',
      scopeGlobalBlocked: 'Restore inheritance is not available at the global layer',
      fieldName: 'Name',
      fieldAliases: 'Aliases',
      fieldDescription: 'Description',
      fieldChannel: 'CLI / channel',
      fieldModel: 'Model',
      fieldReasoning: 'Reasoning',
      fieldPrompt: 'Role prompt',
      fieldUnset: 'Not set',
      channelUnset: 'No channel (inherit)',
      unsupported: 'Unsupported',
      pendingConfig: 'Pending configuration',
      restoreInherit: 'Restore inheritance',
      saveDetail: 'Save changes',
      savingDetail: 'Saving…',
      detailSaved: 'Saved',
      detailNoChanges: 'No differences to save',
      confirmGlobal: 'Write to global configuration?',
      confirm: 'Confirm',
      cancel: 'Cancel',
      noModelOptions: 'No model configured for this channel',
      noReasoningOptions: 'No reasoning configured for this channel',
      sourceColumn: 'Source',
      detailInvalidName: 'Name cannot be empty',
      detailInvalidPrompt: 'Prompt cannot be empty; use Restore inheritance instead',
      detailInvalidAliases: 'Aliases must be comma-separated strings',
      detailReadOnly: 'This role is defined in the session; the global layer is read-only',
      warningPrefix: 'Warning',
      loadError: 'Load failed',
      required: 'Required',
      unchanged: 'Unchanged',
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

    /** 文本链接按钮（无边框、token 色）；设置页/详情页复用。 */
    const linkButton = {
      background: 'none',
      border: 'none',
      padding: 0,
      color: 'var(--dsw-alias-state-business-primary)',
      fontFamily: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      flexShrink: 0,
    }

    /**
     * CLI 状态 → 固定三行（Codex / CodeBuddy / Claude）。
     * 缺失项按 unknown/关闭呈现，不伪造已检测；只投影状态，不显示版本/路径/额度。
     * @param {any[] | null | undefined} cliStates
     */
    function cliRowsOf(cliStates) {
      const list = Array.isArray(cliStates) ? cliStates : []
      const byCli = new Map()
      for (const item of list) {
        const cli = asString(item?.cli)
        if (CLI_NAMES.includes(cli)) byCli.set(cli, item)
      }
      return CLI_NAMES.map(
        (cli) =>
          byCli.get(cli) ?? {
            cli,
            label: CLI_LABELS[cli],
            userPreference: 'unset',
            enabled: false,
            ready: 'unknown',
            blockedReason: 'evidence-missing',
            manualSteps: [],
            retryable: true,
          },
      )
    }

    /**
     * 一行外部 CLI：名称 + 原生 Switch。**不显示**版本/路径/额度/通道/徽章。
     * 只有该行刚发生过开/关失败时，才追加「一行摘要 + 人工步骤 + 重新检测」。
     */
    function CliSwitchRow({ t, row, pending, failure, onToggle, onRetry }) {
      const reason = row.ready === 'ready' ? '' : asString(row.blockedReason)
      const title = reason ? `${row.label || row.cli} · ${reason}` : row.label || row.cli
      const stepText = asArray(failure?.manualSteps).map(String).join('；')
      /** @type {any[]} */
      const children = [
        jsx('span', { style: grow, children: row.label || row.cli }),
        jsx(Switch, {
          // 有失败记录时强制显示为关：失败不做乐观假开启。
          checked: failure ? false : row.enabled === true,
          label: `${t('cliSwitchLabel')} ${row.label || row.cli}`,
          title,
          disabled: pending === true,
          color: failure ? 'gray' : row.enabled === true ? 'green' : 'gray',
          onChange: (next) => onToggle(row.cli, next),
        }),
      ]
      if (failure) {
        children.push(
          jsxs(
            'div',
            {
              style: { display: 'flex', flexDirection: 'column', gap: 4, width: '100%', paddingLeft: 0 },
              children: [
                jsx('p', {
                  role: 'status',
                  style: {
                    ...note,
                    color: 'var(--dsw-alias-state-error-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                  title: `${asString(failure.code)} ${asString(failure.message)}`,
                  children: asString(failure.message) || t('cliOnFailed'),
                }),
                stepText
                  ? jsxs('div', { style: meta, children: [`${t('manualSteps')}：`, stepText] })
                  : null,
                failure.retryable === false
                  ? null
                  : jsx('button', {
                      type: 'button',
                      style: linkButton,
                      disabled: pending === true,
                      onClick: () => onRetry(row.cli),
                      children: pending === true ? t('cliDetecting') : t('cliRetry'),
                    }),
              ],
            },
            `cli-failure-${row.cli}`,
          ),
        )
      }
      return jsxs('div', { style: { ...row, flexWrap: 'wrap' }, children }, row.cli)
    }

    /**
     * 设置页：**只保留两区**。
     *
     * 1) 外部 CLI 连接：Codex / CodeBuddy / Claude 三行，每行只有名称 + Switch；
     * 2) 默认角色配置：模板名 + 一句说明 + 角色数量 + 「管理角色」入口。
     *
     * 并行上限、同项目串行、全局调度、高级设置、通道实例、配置文件路径、DSH 宿主行
     * 全部删除；错误只在首屏一行摘要，详情折叠，无错误不占位。
     *
     * @param {(key: string) => string} t
     * @param {any} snapshot
     * @param {{
     *   cliStates?: any[] | null,
     *   cliPending?: Record<string, boolean>,
     *   cliFailures?: Record<string, any>,
     *   errorOpen?: boolean,
     *   openRoles?: () => void,
     *   onToggleCli?: (cli: string, next: boolean) => void,
     *   onRetryCli?: (cli: string) => void,
     *   onToggleError?: () => void,
     * }} opts
     */
    function renderSection(t, snapshot, opts = {}) {
      const global = asObject(snapshot?.global)
      const rows = cliRowsOf(
        opts.cliStates !== undefined ? opts.cliStates : global.cli,
      )
      const pending = asObject(opts.cliPending)
      const failures = asObject(opts.cliFailures)
      const errorOpen = opts.errorOpen === true
      const openRoles = typeof opts.openRoles === 'function' ? opts.openRoles : () => {}
      const onToggleCli = typeof opts.onToggleCli === 'function' ? opts.onToggleCli : () => {}
      const onRetryCli = typeof opts.onRetryCli === 'function' ? opts.onRetryCli : () => {}
      const onToggleError = typeof opts.onToggleError === 'function' ? opts.onToggleError : () => {}
      const lastError = snapshot?.lastError

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
                    style: {
                      ...grow,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                    title: `[${asString(lastError.code)}] ${asString(lastError.message)}`,
                    children: `[${asString(lastError.code)}] ${asString(lastError.message)}`,
                  }),
                  jsx('button', {
                    type: 'button',
                    style: linkButton,
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
                      jsx('div', { children: asString(lastError.message) || t('unknown') }),
                      jsx('div', {
                        style: meta,
                        children: `${asString(lastError.code)}${lastError.source ? ` · ${lastError.source}` : ''}`,
                      }),
                      lastError.at ? jsx('div', { style: meta, children: lastError.at }) : null,
                    ],
                  })
                : null,
            ],
          })

      const cliCard = jsxs('div', {
        style: card,
        children: [
          // 拿不到状态时只解释一次；三行仍以 unknown/关呈现（不伪造已检测）。
          (opts.cliStates === undefined || opts.cliStates === null) &&
          (global.cli === null || global.cli === undefined)
            ? jsx('p', { style: note, children: t('noCliStates') })
            : null,
          jsx('div', {
            style: list,
            children: rows.map((row) =>
              jsx(
                CliSwitchRow,
                {
                  t,
                  row,
                  pending: pending[row.cli] === true,
                  failure: failures[row.cli] ?? null,
                  onToggle: onToggleCli,
                  onRetry: onRetryCli,
                },
                `cli-${row.cli}`,
              ),
            ),
          }),
        ],
      })

      const roleCount = asArray(snapshot?.roles).length
      const templateCard = jsxs('div', {
        style: card,
        children: [
          jsx('div', { style: { ...heading, fontSize: 13 }, children: t('templateName') }),
          jsx('p', { style: note, children: t('templateDesc') }),
          jsxs('div', {
            style: alignRow,
            children: [
              jsx('span', { children: t('roleCount') }),
              jsx('span', { style: dim, children: String(roleCount) }),
              jsx('span', { style: grow }),
              jsx('button', {
                type: 'button',
                style: linkButton,
                onClick: openRoles,
                children: t('manageRoles'),
              }),
            ],
          }),
        ],
      })

      return jsxs('div', {
        style: root,
        children: [
          errorCard,
          jsx('h3', { style: heading, children: t('cliSection') }),
          cliCard,
          jsx('h3', { style: heading, children: t('rolesSection') }),
          templateCard,
        ],
      })
    }

    /** 用一行 Remote 返回值替换本地 CLI 行（按 cli 对齐；不改变其他行）。 */
    function replaceCliRow(states, next) {
      const cli = asString(next?.cli)
      if (!cli) return states
      const list = Array.isArray(states) ? states.slice() : cliRowsOf(null)
      const index = list.findIndex((item) => item?.cli === cli)
      if (index >= 0) list[index] = { ...list[index], ...next, cli }
      else list.push({ ...next, cli })
      return list
    }

    /**
     * 设置页组件：两区 + 错误摘条件显示。
     * CLI 开关失败不做乐观更新：失败时开关保持关闭，并显示一行摘要/人工步骤/重新检测。
     */
    function Section({ t, list: load, openRoles, setCliEnabled, refreshCli }) {
      const [state, setState] = react.useState({ status: 'loading' })
      const [errorOpen, setErrorOpen] = react.useState(false)
      const [cliStates, setCliStates] = react.useState(null)
      const [cliPending, setCliPending] = react.useState({})
      const [cliFailures, setCliFailures] = react.useState({})

      react.useEffect(() => {
        let current = true
        Promise.resolve()
          .then(() => load())
          .then(
            (snapshot) => {
              if (!current) return
              setState({ status: 'ready', snapshot })
              setCliStates(Array.isArray(snapshot?.global?.cli) ? snapshot.global.cli : null)
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

      /** 清掉某个 CLI 的失败记录（不改开关）。 */
      function clearFailure(cli) {
        setCliFailures((previous) => {
          if (!previous || !Object.hasOwn(previous, cli)) return previous
          const next = { ...previous }
          delete next[cli]
          return next
        })
      }

      /** 写开关：先置 pending；成功后才替换本地行；失败保持关闭。 */
      async function toggleCli(cli, next) {
        if (typeof setCliEnabled !== 'function') {
          setCliFailures((previous) => ({
            ...previous,
            [cli]: {
              code: 'REMOTE_UNAVAILABLE',
              message: t('remoteUnavailableHint'),
              manualSteps: [],
              retryable: true,
            },
          }))
          return
        }
        setCliPending((previous) => ({ ...previous, [cli]: true }))
        clearFailure(cli)
        const result = await setCliEnabled(cli, next)
        setCliPending((previous) => ({ ...previous, [cli]: false }))
        if (result?.ok === true) {
          const payload = asObject(result.value)
          const nextState = payload.state ? normalizeCliState(payload.state, cli) : null
          if (nextState) {
            setCliStates((previous) => replaceCliRow(previous, nextState))
          } else if (next === false) {
            setCliStates((previous) =>
              replaceCliRow(previous, { cli, enabled: false, userPreference: 'disabled' }),
            )
          }
          return
        }
        const error = asObject(result?.error)
        const data = asObject(error.data)
        setCliFailures((previous) => ({
          ...previous,
          [cli]: {
            code: asString(error.code) || 'CLI_PREFERENCE_PREFLIGHT_FAILED',
            message: asString(error.message) || t('cliOnFailed'),
            manualSteps: asArray(data.manualSteps).map(String),
            retryable: data.retryable !== false,
          },
        }))
        // 明确保持关闭：不做乐观假开启。
        setCliStates((previous) =>
          replaceCliRow(previous, {
            cli,
            enabled: false,
            userPreference: next === false ? 'disabled' : 'unset',
            ready: 'blocked',
          }),
        )
      }

      /** 重新检测：只读 preflight（force 绕过缓存），不写配置。 */
      async function retryCli(cli) {
        if (typeof refreshCli !== 'function') return
        setCliPending((previous) => ({ ...previous, [cli]: true }))
        const result = await refreshCli(cli, true)
        setCliPending((previous) => ({ ...previous, [cli]: false }))
        if (result?.ok === true) {
          const payload = asObject(result.value)
          const nextState = payload.cli ? normalizeCliState(payload.cli, cli) : null
          if (nextState) setCliStates((previous) => replaceCliRow(previous, nextState))
          clearFailure(cli)
          return
        }
        const error = asObject(result?.error)
        setCliFailures((previous) => ({
          ...previous,
          [cli]: {
            code: asString(error.code) || 'CLI_PREFLIGHT_FAILED',
            message: asString(error.message) || t('cliOnFailed'),
            manualSteps: [],
            retryable: true,
          },
        }))
      }

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
      return safeRender(
        'section',
        'render',
        () =>
          jsxs('div', {
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
                cliStates,
                cliPending,
                cliFailures,
                errorOpen,
                openRoles,
                onToggleCli: toggleCli,
                onRetryCli: retryCli,
                onToggleError: () => setErrorOpen(!errorOpen),
              }),
            ],
          }),
        () => renderFailureNote(t),
      )
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
    function registerSection(slotCtx, loader, t, configActions = {}) {
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
              // 区 1 开关：开启前 Host 强制 preflight；失败不写配置。
              setCliEnabled: (cli, enabled) =>
                typeof configActions.setCliEnabled === 'function'
                  ? configActions.setCliEnabled(cli, enabled)
                  : { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '配置远程未装配' } },
              refreshCli: (cli, force) =>
                typeof configActions.refreshCli === 'function'
                  ? configActions.refreshCli(cli, force)
                  : { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '配置远程未装配' } },
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

    /** 来源层 → i18n key + 宿主 Tag tone（固定枚举，不猜）。 */
    function sourceMeta(layer) {
      if (layer === 'global') return { key: 'sourceGlobal', tone: 'neutral' }
      if (layer === 'project') return { key: 'sourceProject', tone: 'info' }
      if (layer === 'session') return { key: 'sourceSession', tone: 'warning' }
      if (layer === 'default') return { key: 'sourceDefault', tone: 'quiet' }
      return { key: 'sourceUnknown', tone: 'quiet' }
    }

    /** 字段来源（缺失 → default；不把未知来源猜成 global）。 */
    function fieldSourceOf(view, roleId, field) {
      const role = asArray(view?.roles).find((item) => item?.roleId === roleId)
      const source = asString(role?.fieldSources?.[field])
      return source || 'default'
    }

    /** 三色 → Tag tone（只用宿主已有 tone，不新增色板）。 */
    function roleColorTone(color) {
      if (color === 'green') return 'success'
      if (color === 'yellow') return 'warning'
      return 'neutral'
    }

    /**
     * 阻断/额度原因的**一行**说明（只用于 Tooltip 与列表下方说明，不展开细节）。
     * @param {(key: string) => string} t
     * @param {any} role
     */
    function roleReasonOf(t, role) {
      const state = asObject(role?.state)
      if (role?.enabled === false) return t('roleDisabled')
      if (state.quota === 'exhausted') return t('roleQuota')
      if (state.readiness === 'blocked') {
        const reason = asString(state.readinessReason)
        return reason ? `${t('roleBlocked')} · ${reason}` : t('roleBlocked')
      }
      if (state.readiness === 'unknown') return t('roleUnknown')
      return ''
    }

    /** 详情页输入控件样式（原生 input/select/textarea + token；不注入 CSS）。 */
    const inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '5px 8px',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'var(--dsw-alias-bg-layer-3)',
      color: C.primary,
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
    }
    const textareaStyle = { ...inputStyle, minHeight: 64, resize: 'vertical' }
    const fieldGrid = {
      display: 'grid',
      gridTemplateColumns: '128px minmax(0, 1fr)',
      gap: '6px 10px',
      alignItems: 'start',
      padding: '6px 0',
      borderTop: '0.5px solid var(--dsw-alias-border-l4)',
    }
    const fieldLabel = { display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4 }
    const scopeButton = {
      ...inputStyle,
      width: 'auto',
      padding: '2px 10px',
      cursor: 'pointer',
      fontSize: 12,
    }
    /** 说明文字样式（复用设置页的 note；避免两处字号漂移）。 */
    const noteStyle = note

    /**
     * 详情页字段行：字段名 + 来源 Tag + 控件 + 恢复继承。
     * `canRestore` 只在字段来源 = session（会话覆盖存在）时为 true。
     */
    function detailField(t, opts) {
      const source = sourceMeta(opts.source)
      return jsxs(
        'div',
        {
          style: fieldGrid,
          children: [
            jsxs('div', {
              style: fieldLabel,
              children: [
                jsx('span', { style: { fontSize: 12, lineHeight: '18px', color: C.secondary }, children: opts.label }),
                jsx(Tag, { tone: source.tone, children: t(source.key) }),
              ],
            }),
            jsx('div', { style: { minWidth: 0 }, children: opts.control }),
            opts.canRestore
              ? jsx('div', {
                  style: { gridColumn: '2', marginTop: -2 },
                  children: jsx('button', {
                    type: 'button',
                    style: { ...linkButton, fontSize: 11 },
                    disabled: opts.disabled === true,
                    onClick: opts.onRestore,
                    children: t('restoreInherit'),
                  }),
                })
              : null,
            opts.note ? jsx('div', { style: { gridColumn: '2', ...meta }, children: opts.note }) : null,
          ],
        },
        opts.key,
      )
    }

    /** 单行 role switch（列表用）；颜色表达三色，状态仍是开/关。 */
    function roleSwitchOf(t, role, pending, onToggle) {
      const reason = roleReasonOf(t, role)
      return jsx(Switch, {
        checked: role.enabled === true,
        label: `${t('roleSwitchLabel')}: ${role.name || role.roleId}`,
        title: reason || (role.enabled === true ? t('roleEnabled') : t('roleDisabled')),
        disabled: pending === true,
        color: asObject(role.state).color,
        onChange: (next) => onToggle(role.roleId, next),
      })
    }

    /**
     * 角色列表（右侧栏）：每行只有名称 + 三色二态 Switch；点击名称进详情。
     * **不显示**模型/别名/通道细节；阻断/额度原因以 Tooltip + 一行说明给出。
     * @param {(key: string) => string} t
     * @param {any} view
     * @param {{ onSelect?: Function, onToggleRole?: Function, pendingRoleIds?: string[], warning?: string }} [opts]
     */
    function renderRoleList(t, view, opts = {}) {
      const roles = asArray(view?.roles)
      const pending = new Set(asArray(opts.pendingRoleIds).map(String))
      const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : () => {}
      const onToggleRole = typeof opts.onToggleRole === 'function' ? opts.onToggleRole : () => {}
      const note = asString(opts.warning)
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          note
            ? jsx('p', {
                role: 'status',
                style: { ...noteStyle, color: 'var(--dsw-alias-state-error-primary)' },
                children: note,
              })
            : null,
          roles.length === 0
            ? jsx('p', { style: noteStyle, children: t('noRoles') })
            : jsx('div', {
                style: list,
                children: roles.map((role) => {
                  const reason = roleReasonOf(t, role)
                  return jsxs(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '6px 0',
                        borderTop: '0.5px solid var(--dsw-alias-border-l4)',
                      },
                      children: [
                        jsxs('div', {
                          style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
                          children: [
                            jsx('button', {
                              type: 'button',
                              style: {
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                textAlign: 'left',
                                fontFamily: 'inherit',
                                fontSize: 13,
                                lineHeight: '20px',
                                fontWeight: 600,
                                color: C.primary,
                                cursor: 'pointer',
                                wordBreak: 'break-word',
                              },
                              'aria-label': `${t('roleOpenDetail')}: ${role.name || role.roleId}`,
                              onClick: () => onSelect(role.roleId),
                              children: role.name || role.roleId || t('unknown'),
                            }),
                            reason
                              ? jsx('span', {
                                  style: { ...meta, color: C.tertiary },
                                  children: reason,
                                })
                              : null,
                          ],
                        }),
                        roleSwitchOf(t, role, pending.has(role.roleId), onToggleRole),
                      ],
                    },
                    role.roleId || role.name,
                  )
                }),
              }),
        ],
      })
    }

    /** 详情 draft：只包含可编辑字段；初始化自生效角色。 */
    function draftOfRole(role) {
      const channel = asObject(role?.channel)
      return {
        name: asString(role?.name),
        aliases: asArray(role?.aliases).map(String).join(', '),
        description: asString(role?.description),
        prompt: asString(role?.prompt),
        channelId: asString(channel.channelId),
        model: asString(channel.model),
        reasoning: asString(channel.reasoning),
      }
    }

    /** 逗号（中/英）分隔 → 去重简称数组。 */
    function parseAliases(text) {
      const seen = new Set()
      const out = []
      for (const part of String(text ?? '').split(/[,，]/)) {
        const value = part.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        out.push(value)
      }
      return out
    }

    /**
     * 详情页的「模型 / 思考强度」选项：只来自真实通道实例。
     * 选中了 channelId → 只列该实例声明的模型/强度；
     * 未选 channelId → 列同 kind+provider 的实例值（去重）；都没有 → 空（显示待配置）。
     * @param {any} view
     * @param {any} role
     * @param {any} draft
     */
    function detailOptionsOf(view, role, draft) {
      const channels = asArray(view?.channels)
      const instance = channels.find(
        (channel) => asString(channel.channelId) && channel.channelId === asString(draft?.channelId),
      )
      const channel = asObject(role?.channel)
      let peers = []
      if (instance) peers = [instance]
      else if (channel.kind || channel.provider) {
        peers = channels.filter(
          (item) =>
            (!channel.kind || item.kind === channel.kind) &&
            (!channel.provider || item.provider === channel.provider),
        )
      }
      const unique = (values) => {
        const set = new Set()
        for (const value of values) {
          const text = asString(value)
          if (text) set.add(text)
        }
        return [...set]
      }
      const models = unique([
        ...peers.map((item) => item.model),
        asString(draft?.model),
      ])
      const reasonings = unique([
        ...peers.map((item) => item.reasoning),
        asString(draft?.reasoning),
      ])
      return {
        channels,
        instance: instance ?? null,
        models,
        reasonings,
      }
    }

    /**
     * 会话 scope 的「只写差异」变更列表。
     * - 名称/Prompt 不能写成空字符串：留空时改为「恢复继承」。
     * - 切换通道实例时把 kind/provider/model/reasoning 一起对齐（避免派单 CHANNEL_MISMATCH）。
     * @returns {{ changes: Array<{field: string, value?: any, restore?: true}>, error: string | null }}
     */
    function buildSessionChanges(t, role, draft, channels) {
      const changes = []
      const current = asObject(role?.channel)
      const name = asString(draft?.name).trim()
      if (!name) return { changes, error: t('detailInvalidName') }
      if (name !== asString(role?.name)) changes.push({ field: 'name', value: name })

      const aliases = parseAliases(draft?.aliases)
      const currentAliases = asArray(role?.aliases).map(String)
      if (aliases.join('\u0000') !== currentAliases.join('\u0000')) {
        changes.push({ field: 'aliases', value: aliases })
      }

      const description = asString(draft?.description)
      if (description !== asString(role?.description)) {
        changes.push({ field: 'description', value: description })
      }

      const prompt = asString(draft?.prompt)
      if (prompt !== asString(role?.prompt)) {
        if (!prompt.trim()) changes.push({ field: 'prompt', restore: true })
        else changes.push({ field: 'prompt', value: prompt })
      }

      const channelId = asString(draft?.channelId)
      if (channelId !== asString(current.channelId)) {
        if (!channelId) {
          for (const key of ['channelId', 'kind', 'provider', 'model', 'reasoning']) {
            changes.push({ field: `channel.${key}`, restore: true })
          }
        } else {
          const instance = asArray(channels).find((item) => asString(item.channelId) === channelId)
          if (!instance || (!asString(instance.provider) && !asString(instance.kind))) {
            return { changes, error: t('pendingConfig') }
          }
          changes.push({ field: 'channel.channelId', value: channelId })
          if (instance.kind) changes.push({ field: 'channel.kind', value: instance.kind })
          if (instance.provider) changes.push({ field: 'channel.provider', value: instance.provider })
          for (const key of ['model', 'reasoning']) {
            const value = asString(instance[key])
            if (value) changes.push({ field: `channel.${key}`, value })
            else if (asString(current[key])) changes.push({ field: `channel.${key}`, restore: true })
          }
        }
      } else {
        for (const key of ['model', 'reasoning']) {
          const value = asString(draft?.[key])
          if (value === asString(current[key])) continue
          if (!value) changes.push({ field: `channel.${key}`, restore: true })
          else changes.push({ field: `channel.${key}`, value })
        }
      }
      return { changes, error: null }
    }

    /**
     * 全局 scope 的 patch（一次写入，交给 S2 global writer）。空字符串不写入：
     * 全局层没有「删除字段」语义，Prompt/名称留空视为无效输入。
     * @returns {{ patch: Record<string, any>, error: string | null }}
     */
    function buildGlobalPatch(t, role, draft, channels) {
      /** @type {Record<string, any>} */
      const patch = {}
      const name = asString(draft?.name).trim()
      if (!name) return { patch, error: t('detailInvalidName') }
      if (name !== asString(role?.name)) patch.name = name

      const aliases = parseAliases(draft?.aliases)
      if (aliases.join('\u0000') !== asArray(role?.aliases).map(String).join('\u0000')) {
        patch.aliases = aliases
      }
      const description = asString(draft?.description)
      if (description !== asString(role?.description)) patch.description = description

      const prompt = asString(draft?.prompt)
      if (prompt !== asString(role?.prompt)) {
        if (!prompt.trim()) return { patch, error: t('detailInvalidPrompt') }
        patch.prompt = prompt
      }

      const current = asObject(role?.channel)
      const channelId = asString(draft?.channelId)
      /** @type {Record<string, string>} */
      const channelPatch = {}
      if (channelId !== asString(current.channelId)) {
        if (!channelId) return { patch, error: t('scopeGlobalBlocked') }
        const instance = asArray(channels).find((item) => asString(item.channelId) === channelId)
        if (!instance || (!asString(instance.provider) && !asString(instance.kind))) {
          return { patch, error: t('pendingConfig') }
        }
        channelPatch.channelId = channelId
        if (instance.kind) channelPatch.kind = instance.kind
        if (instance.provider) channelPatch.provider = instance.provider
        if (instance.model) channelPatch.model = instance.model
        if (instance.reasoning) channelPatch.reasoning = instance.reasoning
      } else {
        for (const key of ['model', 'reasoning']) {
          const value = asString(draft?.[key])
          if (!value) continue
          if (value !== asString(current[key])) channelPatch[key] = value
        }
      }
      if (Object.keys(channelPatch).length > 0) patch.channel = channelPatch
      return { patch, error: null }
    }

    /** 会话保存：逐字段写覆盖（服务端只存差异），失败立即停止；不乐观更新。 */
    async function saveSessionChanges({ roleId, changes, setOverride, clearOverride, reload }) {
      let applied = 0
      for (const change of changes) {
        const result = change.restore
          ? await clearOverride(roleId, change.field)
          : await setOverride(roleId, change.field, change.value)
        if (!result || result.ok !== true) {
          return { ok: false, applied, error: result?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
        }
        applied += 1
      }
      const loaded = await reload()
      if (!loaded || loaded.ok !== true) {
        return { ok: false, applied, error: loaded?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
      }
      return { ok: true, applied, view: loaded.view }
    }

    /** 全局保存：一次 patch 写入（调用方必须先做二次确认）。 */
    async function saveGlobalPatch({ roleId, patch, updateGlobalRole, reload }) {
      const result = await updateGlobalRole(roleId, patch)
      if (!result || result.ok !== true) {
        return { ok: false, error: result?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
      }
      const loaded = await reload()
      if (!loaded || loaded.ok !== true) {
        return { ok: false, error: loaded?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
      }
      return { ok: true, view: loaded.view, value: result.value }
    }

    /**
     * 角色开关：只写**当前会话**覆盖（`enabled`），成功后 reload。
     * 失败原样返回，不做乐观假开启。
     */
    async function toggleSessionRole({ roleId, next, setOverride, reload }) {
      if (typeof setOverride !== 'function') {
        return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '会话写入未装配' } }
      }
      const result = await setOverride(roleId, 'enabled', next === true)
      if (!result || result.ok !== true) {
        return { ok: false, error: result?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
      }
      const loaded = await reload()
      if (!loaded || loaded.ok !== true) {
        return { ok: false, error: loaded?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' }, value: result.value }
      }
      return { ok: true, view: loaded.view, value: result.value }
    }

    /** 详情页错误行（一行摘要；完整 message 放 title）。 */
    function detailErrorLine(t, error) {
      if (!error) return null
      const message = asString(error.message) || t('loadFailed')
      return jsx('p', {
        role: 'alert',
        style: {
          ...noteStyle,
          color: 'var(--dsw-alias-state-error-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
        title: `${asString(error.code)} ${message}`,
        children: `${asString(error.code)} ${message}`,
      })
    }

    /**
     * 二级详情（会话/全局两 scope 复用）。
     * @param {(key: string) => string} t
     * @param {any} view
     * @param {string} roleId
     * @param {{
     *   scope?: 'session' | 'global',
     *   draft?: any,
     *   onDraft?: (field: string, value: string) => void,
     *   onBack?: Function,
     *   onScope?: (scope: 'session' | 'global') => void,
     *   onSave?: Function,
     *   onRestore?: (field: string) => void,
     *   onCancelConfirm?: Function,
     *   saving?: boolean,
     *   confirming?: boolean,
     *   error?: any,
     * }} [opts]
     */
    function renderRoleDetail(t, view, roleId, opts = {}) {
      const role = asArray(view?.roles).find((item) => item.roleId === roleId)
      if (!role) {
        return jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 8 },
          children: [
            jsx('p', { style: noteStyle, children: t('noRolesDetail') }),
            jsx('button', { type: 'button', style: linkButton, onClick: opts.onBack, children: t('detailBack') }),
          ],
        })
      }
      const scope = opts.scope === 'global' ? 'global' : 'session'
      const draft = opts.draft ?? draftOfRole(role)
      const options = detailOptionsOf(view, role, draft)
      const disabled = opts.saving === true
      const onDraft = typeof opts.onDraft === 'function' ? opts.onDraft : () => {}
      const onRestore = typeof opts.onRestore === 'function' ? opts.onRestore : () => {}
      const canRestore = (field) => scope === 'session' && fieldSourceOf(view, roleId, field) === 'session'
      const text = (field, value, extra = {}) =>
        jsx('input', {
          type: 'text',
          style: inputStyle,
          value: asString(value),
          disabled,
          onChange: (event) => onDraft(field, event?.target?.value ?? ''),
          ...extra,
        })
      const channelControl = jsxs('select', {
        style: inputStyle,
        value: asString(draft.channelId),
        disabled,
        onChange: (event) => onDraft('channelId', event?.target?.value ?? ''),
        children: [
          jsx('option', { value: '', children: t('channelUnset') }),
          ...options.channels.map((channel) =>
            jsx(
              'option',
              {
                value: asString(channel.channelId),
                children:
                  [asString(channel.channelId), asString(channel.kind), asString(channel.provider)]
                    .filter(Boolean)
                    .join(' · ') || asString(channel.channelId),
              },
              `channel-${channel.channelId}`,
            ),
          ),
        ],
      })
      const modelControl =
        options.models.length === 0
          ? jsx('span', { style: noteStyle, children: `${t('unsupported')} · ${t('noModelOptions')}` })
          : jsxs('select', {
              style: inputStyle,
              value: asString(draft.model),
              disabled,
              onChange: (event) => onDraft('model', event?.target?.value ?? ''),
              children: options.models.map((value) => jsx('option', { value, children: value }, `model-${value}`)),
            })
      const reasoningControl =
        options.reasonings.length === 0
          ? jsx('span', { style: noteStyle, children: `${t('unsupported')} · ${t('noReasoningOptions')}` })
          : jsxs('select', {
              style: inputStyle,
              value: asString(draft.reasoning),
              disabled,
              onChange: (event) => onDraft('reasoning', event?.target?.value ?? ''),
              children: options.reasonings.map((value) => jsx('option', { value, children: value }, `reasoning-${value}`)),
            })

      const fields = [
        detailField(t, {
          key: 'name',
          label: t('fieldName'),
          source: fieldSourceOf(view, roleId, 'name'),
          canRestore: canRestore('name'),
          onRestore: () => onRestore('name'),
          disabled,
          control: text('name', draft.name),
        }),
        detailField(t, {
          key: 'aliases',
          label: t('fieldAliases'),
          source: fieldSourceOf(view, roleId, 'aliases'),
          canRestore: canRestore('aliases'),
          onRestore: () => onRestore('aliases'),
          disabled,
          control: text('aliases', draft.aliases, { placeholder: t('detailInvalidAliases') }),
        }),
        detailField(t, {
          key: 'description',
          label: t('fieldDescription'),
          source: fieldSourceOf(view, roleId, 'description'),
          canRestore: canRestore('description'),
          onRestore: () => onRestore('description'),
          disabled,
          control: text('description', draft.description),
        }),
        detailField(t, {
          key: 'channel.channelId',
          label: t('fieldChannel'),
          source: fieldSourceOf(view, roleId, 'channel.channelId'),
          canRestore: canRestore('channel.channelId'),
          onRestore: () => onRestore('channel.channelId'),
          disabled,
          control: channelControl,
        }),
        detailField(t, {
          key: 'channel.model',
          label: t('fieldModel'),
          source: fieldSourceOf(view, roleId, 'channel.model'),
          canRestore: canRestore('channel.model'),
          onRestore: () => onRestore('channel.model'),
          disabled,
          control: modelControl,
        }),
        detailField(t, {
          key: 'channel.reasoning',
          label: t('fieldReasoning'),
          source: fieldSourceOf(view, roleId, 'channel.reasoning'),
          canRestore: canRestore('channel.reasoning'),
          onRestore: () => onRestore('channel.reasoning'),
          disabled,
          control: reasoningControl,
        }),
        detailField(t, {
          key: 'prompt',
          label: t('fieldPrompt'),
          source: fieldSourceOf(view, roleId, 'prompt'),
          canRestore: canRestore('prompt'),
          onRestore: () => onRestore('prompt'),
          disabled,
          control: jsx('textarea', {
            style: textareaStyle,
            value: asString(draft.prompt),
            disabled,
            onChange: (event) => onDraft('prompt', event?.target?.value ?? ''),
          }),
        }),
      ]

      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8 },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
            children: [
              jsx('button', {
                type: 'button',
                style: { ...linkButton, color: C.secondary },
                onClick: opts.onBack,
                children: `← ${t('detailBack')}`,
              }),
              jsx('strong', { style: { fontSize: 13, lineHeight: '20px' }, children: role.name || role.roleId }),
              jsx(Tag, { tone: roleColorTone(asObject(role.state).color), children: t('detailTitle') }),
            ],
          }),
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
            children: [
              jsx('button', {
                type: 'button',
                style: {
                  ...scopeButton,
                  background:
                    scope === 'session'
                      ? 'var(--dsw-alias-bg-module-platform)'
                      : 'var(--dsw-alias-bg-layer-3)',
                },
                'aria-pressed': scope === 'session',
                onClick: () => opts.onScope?.('session'),
                children: t('scopeSession'),
              }),
              jsx('button', {
                type: 'button',
                style: {
                  ...scopeButton,
                  background:
                    scope === 'global'
                      ? 'var(--dsw-alias-bg-module-platform)'
                      : 'var(--dsw-alias-bg-layer-3)',
                },
                'aria-pressed': scope === 'global',
                onClick: () => opts.onScope?.('global'),
                children: t('scopeGlobal'),
              }),
            ],
          }),
          scope === 'global'
            ? jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 2 },
                children: [
                  jsx('p', {
                    style: { ...noteStyle, color: 'var(--dsw-alias-state-warn-primary)' },
                    children: t('scopeGlobalNote'),
                  }),
                  jsx('p', { style: meta, children: t('scopeGlobalBlocked') }),
                ],
              })
            : null,
          detailErrorLine(t, opts.error),
          jsx('div', { style: { display: 'flex', flexDirection: 'column' }, children: fields }),
          opts.confirming
            ? jsxs('div', {
                style: { ...card, gap: 4, borderColor: 'var(--dsw-alias-state-warn-primary)' },
                children: [
                  jsx('div', { style: noteStyle, children: t('confirmGlobal') }),
                  jsxs('div', {
                    style: { display: 'flex', gap: 8 },
                    children: [
                      jsx('button', {
                        type: 'button',
                        style: { ...scopeButton, color: 'var(--dsw-alias-state-warn-primary)' },
                        onClick: opts.onSave,
                        children: t('confirm'),
                      }),
                      jsx('button', {
                        type: 'button',
                        style: scopeButton,
                        onClick: opts.onCancelConfirm,
                        children: t('cancel'),
                      }),
                    ],
                  }),
                ],
              })
            : jsx('div', {
                style: { display: 'flex', alignItems: 'center', gap: 8 },
                children: jsx('button', {
                  type: 'button',
                  style: scopeButton,
                  disabled,
                  onClick: opts.onSave,
                  children: disabled ? t('savingDetail') : t('saveDetail'),
                }),
              }),
        ],
      })
    }

    /**
     * 右侧栏角色面板：列表 ↔ 详情（同栏切换，不新造弹窗体系）。
     * 列表开关只写当前会话；详情支持会话/全局两 scope。
     */
    function renderRolePane(t, view, opts = {}) {
      const selectedRoleId = asString(opts.selectedRoleId)
      return jsxs('div', {
        style: root,
        children: [
          jsx('h3', { style: heading, children: t('paneTitle') }),
          jsx('p', { style: noteStyle, children: t('roleListNote') }),
          detailErrorLine(t, opts.error),
          selectedRoleId
            ? renderRoleDetail(t, view, selectedRoleId, opts)
            : renderRoleList(t, view, opts),
        ],
      })
    }

    /** 面板加载中：标题 + 说明 + 加载提示（不空白）。 */
    function renderPaneLoading(t) {
      return jsxs('div', {
        style: root,
        children: [
          jsx('h3', { style: heading, children: t('paneTitle') }),
          jsx('p', { style: noteStyle, role: 'status', 'aria-live': 'polite', children: t('loading') }),
        ],
      })
    }

    /** 面板失败：标题 + 只读说明 + **一行**错误摘要（title 里保留全文）。 */
    function renderPaneError(t, error) {
      const code = asString(error?.code) || 'REMOTE_CALL_FAILED'
      const message = asString(error?.message) || t('loadFailed')
      return jsxs('div', {
        style: root,
        role: 'alert',
        children: [
          jsx('h3', { style: heading, children: t('paneTitle') }),
          jsx('p', { style: noteStyle, children: t('roleListNote') }),
          jsx('p', {
            style: {
              ...noteStyle,
              color: 'var(--dsw-alias-state-error-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
            title: `[${code}] ${message}`,
            children: `[${code}] ${message}`,
          }),
        ],
      })
    }

    /**
     * 顶部入口按钮样式：自绘（不 require primitives），token 与官方 sm toolbar
     * Button 一致（28px / 12px 字号 / radius-sm），但把原生 button 的默认粗边框
     * 换成 0.5px 宿主 border token。hover/focus 也用宿主 token 显式实现。
     */
    const HEADER_BUTTON_BASE = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 28,
      padding: '0 10px',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-button-tool-bar-fill)',
      color: 'var(--dsw-alias-label-secondary)',
      fontFamily: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      flexShrink: 0,
    }

    /**
     * 标题右侧入口：内联 SVG + 文案「角色」；点击打开右侧栏 tab。
     * `$mount` 失败时入口仍然存在：标题/点击提示「远程不可用」，不擅自消失。
     * 可访问名在外层 button（aria-label/title）；SVG 自身 aria-hidden。
     */
    function HeaderEntry({ t, openRolePanel, remoteReady }) {
      const [notice, setNotice] = react.useState(null)
      const [hovered, setHovered] = react.useState(false)
      const [focused, setFocused] = react.useState(false)
      return safeRender(
        'header',
        'render',
        () => {
          const label = t('headerTitle')
          const remoteOk = remoteReady !== false
          const desc = remoteOk ? t('headerDesc') : t('remoteUnavailableHint')
          const buttonStyle = {
            ...HEADER_BUTTON_BASE,
            background: hovered
              ? 'var(--dsw-alias-button-tool-bar-hover)'
              : 'var(--dsw-alias-button-tool-bar-fill)',
            outline: focused
              ? 'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))'
              : 'none',
            outlineOffset: 1,
          }
          return jsxs('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
            children: [
              jsxs('button', {
                type: 'button',
                className: 'dsh-meetingstone-header-entry',
                'aria-label': label,
                title: desc,
                style: buttonStyle,
                onMouseEnter: () => setHovered(true),
                onMouseLeave: () => setHovered(false),
                onFocus: () => setFocused(true),
                onBlur: () => setFocused(false),
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
                children: [jsx(IconUsers, { size: 16 }), jsx('span', { children: label })],
              }),
              notice
                ? jsx('span', {
                    role: 'status',
                    style: {
                      ...meta,
                      color: 'var(--dsw-alias-state-error-primary)',
                      whiteSpace: 'nowrap',
                    },
                    children: notice,
                  })
                : null,
            ],
          })
        },
        () => renderFailureNote(t),
      )
    }

    /** 右侧栏 tab 标题。 */
    function SidebarRoleTitle({ t }) {
      return jsx('span', { children: t('tabTitle') })
    }

    /**
     * 右侧栏角色面板：列表 ↔ 详情（同栏切换，不新造弹窗体系）。
     *
     * - 列表开关只写**当前会话**覆盖（`setSessionOverride(...,'enabled',…)`），
     *   成功后 reload；失败不乐观更新。
     * - 详情支持「本会话 / 全局」两 scope：会话只写差异；全局走 S2 global writer，
     *   保存前必须二次确认。
     * - Remote 失败只显示一行错误摘要，不抛、不空白。
     */
    function SidebarRolePane({
      t,
      loadSession,
      setOverride,
      clearOverride,
      updateGlobalRole,
    }) {
      const [state, setState] = react.useState({ status: 'loading' })
      const [selectedRoleId, setSelectedRoleId] = react.useState('')
      const [scope, setScope] = react.useState('session')
      const [draft, setDraft] = react.useState(null)
      const [pendingRoleIds, setPendingRoleIds] = react.useState([])
      const [saving, setSaving] = react.useState(false)
      const [confirming, setConfirming] = react.useState(false)
      const [actionError, setActionError] = react.useState(null)

      react.useEffect(() => {
        let current = true
        Promise.resolve()
          .then(() =>
            typeof loadSession === 'function'
              ? loadSession()
              : { ok: false, error: { code: 'CAPABILITY_MISSING', message: 'loadSession 不可用' } },
          )
          .then(
            (result) => {
              if (!current) return
              if (result && result.ok === true) setState({ status: 'ready', view: result.view })
              else {
                setState({
                  status: 'error',
                  error: (result && result.error) || { code: 'REMOTE_CALL_FAILED', message: '' },
                })
              }
            },
            (error) => {
              if (current) {
                setState({
                  status: 'error',
                  error: {
                    code: 'REMOTE_CALL_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                  },
                })
              }
            },
          )
        return () => {
          current = false
        }
      }, [loadSession])

      /** 重新读取会话视图（写操作后刷新；失败不覆盖当前列表）。 */
      async function reload() {
        const result = await loadSession()
        if (result && result.ok === true) {
          setState({ status: 'ready', view: result.view })
        }
        return result
      }

      /** 详情 draft 回到当前生效值。 */
      function resetDraft(view, roleId) {
        const role = asArray(view?.roles).find((item) => item.roleId === roleId)
        setDraft(role ? draftOfRole(role) : null)
      }

      function selectRole(roleId) {
        setSelectedRoleId(roleId)
        setScope('session')
        setConfirming(false)
        setActionError(null)
        resetDraft(state.view, roleId)
      }

      function backToList() {
        setSelectedRoleId('')
        setDraft(null)
        setConfirming(false)
        setActionError(null)
      }

      function changeScope(next) {
        setScope(next === 'global' ? 'global' : 'session')
        setConfirming(false)
        setActionError(null)
      }

      /** 改 draft；切换通道实例时把模型/强度带成该实例的值。 */
      function updateDraft(field, value) {
        setDraft((previous) => {
          const next = { ...(previous ?? {}), [field]: value }
          if (field === 'channelId') {
            const instance = asArray(state.view?.channels).find(
              (channel) => asString(channel.channelId) === asString(value),
            )
            next.model = instance ? asString(instance.model) : ''
            next.reasoning = instance ? asString(instance.reasoning) : ''
          }
          return next
        })
        setConfirming(false)
        setActionError(null)
      }

      /** 开关角色：只写当前会话；失败不做乐观假开启。 */
      async function toggleRole(roleId, next) {
        setPendingRoleIds((previous) => [...previous, roleId])
        setActionError(null)
        const result = await toggleSessionRole({
          roleId,
          next,
          setOverride,
          reload,
        })
        setPendingRoleIds((previous) => previous.filter((id) => id !== roleId))
        if (result.ok !== true) {
          setActionError(result.error)
          return
        }
        if (selectedRoleId === roleId) resetDraft(result.view, roleId)
      }

      /** 恢复单字段继承（仅会话 scope 有意义）。 */
      async function restoreField(field) {
        if (!selectedRoleId || typeof clearOverride !== 'function') return
        setSaving(true)
        setActionError(null)
        const result = await clearOverride(selectedRoleId, field)
        if (result && result.ok === true) {
          const loaded = await reload()
          if (loaded && loaded.ok === true) resetDraft(loaded.view, selectedRoleId)
        } else {
          setActionError((result && result.error) || { code: 'REMOTE_CALL_FAILED', message: '' })
        }
        setSaving(false)
      }

      /** 保存（会话=逐字段差异；全局=一次 patch + 二次确认）。 */
      async function saveDetail() {
        const role = asArray(state.view?.roles).find((item) => item.roleId === selectedRoleId)
        if (!role || !draft) return

        if (scope === 'global') {
          if (!confirming) {
            setConfirming(true)
            return
          }
          const built = buildGlobalPatch(t, role, draft, state.view?.channels)
          if (built.error) {
            setConfirming(false)
            setActionError({ code: 'DETAIL_INVALID', message: built.error })
            return
          }
          if (Object.keys(built.patch).length === 0) {
            setConfirming(false)
            setActionError({ code: 'DETAIL_NO_CHANGES', message: t('detailNoChanges') })
            return
          }
          setSaving(true)
          const result = await saveGlobalPatch({
            roleId: selectedRoleId,
            patch: built.patch,
            updateGlobalRole,
            reload,
          })
          setSaving(false)
          setConfirming(false)
          if (result.ok !== true) {
            setActionError(result.error)
            return
          }
          resetDraft(result.view, selectedRoleId)
          return
        }

        const built = buildSessionChanges(t, role, draft, state.view?.channels)
        if (built.error) {
          setActionError({ code: 'DETAIL_INVALID', message: built.error })
          return
        }
        if (built.changes.length === 0) {
          setActionError({ code: 'DETAIL_NO_CHANGES', message: t('detailNoChanges') })
          return
        }
        setSaving(true)
        const result = await saveSessionChanges({
          roleId: selectedRoleId,
          changes: built.changes,
          setOverride,
          clearOverride,
          reload,
        })
        setSaving(false)
        if (result.ok !== true) {
          setActionError(result.error)
          return
        }
        resetDraft(result.view, selectedRoleId)
      }

      if (state.status === 'loading') return renderPaneLoading(t)
      if (state.status === 'error') return renderPaneError(t, state.error)
      const warnings = asArray(state.view?.warnings).map((item) => asString(item.message)).filter(Boolean)
      return safeRender(
        'sidebar',
        'render',
        () =>
          renderRolePane(t, state.view, {
            selectedRoleId,
            scope,
            draft,
            saving,
            confirming,
            error: actionError,
            pendingRoleIds,
            warning: warnings.length > 0 ? `${t('warningPrefix')}: ${warnings.join(' | ')}` : '',
            onSelect: selectRole,
            onBack: backToList,
            onScope: changeScope,
            onDraft: updateDraft,
            onSave: saveDetail,
            onRestore: restoreField,
            onCancelConfirm: () => setConfirming(false),
            onToggleRole: toggleRole,
          }),
        () => renderPaneError(t, { code: 'RENDER_FAILED', message: t('renderFailed') }),
      )
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
     * keyed seat（内容 + 标题，scope session）。面板只读，数据来自 strict
     * `getSessionConfig(sessionId)`（不是无参 list：来源/覆盖必须按会话解析）。
     * `priority` 是官方档位字符串 `extension|builtin|fallback`，不是数字。
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
          kind: TAB_KIND,
          priority: 'extension',
          title: () => t('tabTitle'),
        })
      }
      const loadSession = makeSessionConfigLoader(deps.getService, deps.mountError)
      const sessionActions =
        deps.sessionActions ?? makeSessionActions(deps.getService, deps.mountError)
      const configActions = deps.configActions ?? makeConfigActions(deps.getService, deps.mountError)
      // 2) keyed seats（scope session）
      slotCtx.slots.inject('sidebar.right.pane.tab', () =>
        slotCtx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            inject: (/** @type {string} */ sessionId) => ({
              sessionId,
              loadSession: () => loadSession(sessionId),
              setOverride: (roleId, field, value) =>
                sessionActions.setOverride(sessionId, roleId, field, value),
              clearOverride: (roleId, field) => sessionActions.clearOverride(sessionId, roleId, field),
              updateGlobalRole: (roleId, patch) => configActions.updateGlobalRole(roleId, patch),
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
      try {
        await applyGuarded(ctx)
      } catch (error) {
        try {
          console.error('[meetingstone] GUI apply failed (swallowed to protect boot):', error)
        } catch {}
      }
    }

    async function applyGuarded(ctx) {
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
      // 渲染期 guard 与注册 guard 共用同一格式（同一 ctx.logger）。
      guiLog = log

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

      const deps = {
        getService,
        mountError,
        sessionActions: makeSessionActions(getService, mountError),
        configActions: makeConfigActions(getService, mountError),
      }
      const mountFailure = mountError ? { code: 'REMOTE_MOUNT_FAILED', message: mountError } : undefined

      // 2) 注册顺序：header → section → sidebar。header 永不因 mount 失败而缺失。
      guard('header', 'register', () => registerHeaderAction(ctx, deps, t))
      guard('section', 'register', () =>
        registerSection(ctx, makeLoader(getService, mountFailure), t, deps.configActions),
      )
      guard('sidebar', 'register', () => registerSidebarTab(ctx, deps, t))
    }

    exports.apply = apply
    exports.inject = inject
    // stub harness 用的纯函数；生产路径不依赖该导出。
    exports.__test = {
      normalizeSnapshot,
      normalizeGlobal,
      normalizeCli,
      normalizeCliState,
      unavailableSnapshot,
      normalizeSessionConfigView,
      renderSection,
      renderRolePane,
      renderRoleList,
      renderRoleDetail,
      renderPaneError,
      renderPaneLoading,
      draftOfRole,
      detailOptionsOf,
      buildSessionChanges,
      buildGlobalPatch,
      saveSessionChanges,
      saveGlobalPatch,
      toggleSessionRole,
      fieldSourceOf,
      roleReasonOf,
      cliRowsOf,
      CliSwitchRow,
      Tag,
      Switch,
      IconUsers,
      safeRender,
      makeRemoteCall,
      makeSessionActions,
      makeConfigActions,
      REMOTE_CONTRIBUTION,
      SESSION_DESCRIPTORS,
      SESSION_TYPES,
      REMOTE_INJECT,
      TAB_ID,
      TAB_KIND,
      HEADER_ACTION_ID,
      PLUGIN_VERSION,
      makeLoader,
      makeSessionConfigLoader,
    }
    return module.exports
  },
})
