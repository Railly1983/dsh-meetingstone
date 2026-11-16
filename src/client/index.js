/**
 * 集合石 · 设置页 section（浏览器 half，接真实 Host 数据；支持角色增删改与 CLI 开关写入）。
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
 * 范围（B3）：只保留设置页全局配置（CLI 连接、全局角色库、能力目录、最近错误）；
 * 会话级角色配置/remote、对话页头入口、右侧栏角色面板均已下线。
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
    const PLUGIN_VERSION = '0.1.2'

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
      roleId: 'dsh-meetingstone/types#RoleId',
      value: 'dsh-meetingstone/types#JsonValue',
      cliName: 'dsh-meetingstone/types#CliName',
      booleanValue: 'dsh-meetingstone/types#BooleanValue',
      jsonResult: 'dsh-meetingstone/types#JsonResult',
    }

    /** 构造 client 侧 strict codec；zod 不可用时返回 null（调用方跳过该方法）。 */
    const strictCodec = (typeSymbol, build) =>
      z ? { mode: 'strict', typeSymbol, create: build } : null

    const roleIdCodec = () =>
      strictCodec(SESSION_TYPES.roleId, () => z.string().min(1).max(128))
    const jsonValueCodec = () => strictCodec(SESSION_TYPES.value, () => z.unknown())
    const cliNameCodec = () =>
      strictCodec(SESSION_TYPES.cliName, () => z.enum(['dsh', 'codex', 'codebuddy', 'claude']))
    const booleanCodec = () => strictCodec(SESSION_TYPES.booleanValue, () => z.boolean())

    /**
     * 5 个配置方法的 client descriptor（B3：会话级 remote 已整体下线）。
     * 参数 codec 全部 strict（真实 zod），与 Host 同一 typeSymbol；result 用 src-json 透传。
     */
    const REMOTE_DESCRIPTORS = z
      ? [
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
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/createGlobalRole`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'createGlobalRole',
            parameters: [{ name: 'role', wire: 'role', source: 'json', codec: jsonValueCodec() }],
            invocation: { kind: 'direct' },
            result: { mode: 'src-json' },
          },
          {
            id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/deleteGlobalRole`,
            service: REMOTE_SERVICE,
            namespace: REMOTE_SERVICE,
            method: 'deleteGlobalRole',
            parameters: [{ name: 'roleId', wire: 'roleId', source: 'json', codec: roleIdCodec() }],
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
        ...REMOTE_DESCRIPTORS,
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

    /** B2c：固定 4 个 CLI（与 Host 能力目录 `CLI_IDS` 一致）。 */
    const CLI_IDS = ['dsh', 'claude', 'codex', 'codebuddy']

    /** CLI id → 内部 channel.kind（B2 契约：保存仍写内部 channel）。 */
    const CHANNEL_KIND_BY_CLI = {
      dsh: 'in-process',
      claude: 'claude-code',
      codex: 'codex',
      codebuddy: 'acp-cli',
    }

    /** 内部 channel.kind → CLI id（旧配置兼容展示）。 */
    const CLI_BY_CHANNEL_KIND = {
      'in-process': 'dsh',
      'claude-code': 'claude',
      codex: 'codex',
      'acp-cli': 'codebuddy',
    }

    /** 能力来源 → i18n key（discovered/config/static/unknown，不猜）。 */
    function capabilitySourceKey(source) {
      if (source === 'discovered') return 'sourceDiscovered'
      if (source === 'config') return 'sourceConfig'
      if (source === 'static') return 'sourceStatic'
      return 'sourceUnknown'
    }

    /** 来源优先级：discovered > config > static > unknown。 */
    const CAPABILITY_SOURCE_RANK = { discovered: 3, config: 2, static: 1, unknown: 0 }

    /** 取两个来源中更高的一个（空值忽略）。 */
    function higherCapabilitySource(current, next) {
      if (!next) return current
      const left = CAPABILITY_SOURCE_RANK[current] ?? 0
      const right = CAPABILITY_SOURCE_RANK[next] ?? 0
      return right > left ? next : current
    }

    /**
     * 能力条目收窄（B2b）：`{id,label,provider,models[{id,label,provider,source}],
     * strengths[{id,label,source}],sources,refreshedAt,errors}`；结构不对的项丢弃。
     */
    function normalizeCapabilityEntry(item) {
      const source = asObject(item)
      const id = asString(source.id)
      const models = asArray(source.models)
        .filter((model) => model && typeof model === 'object')
        .map((model) => ({
          id: asString(model.id),
          label: asString(model.label) || asString(model.id),
          provider: asString(model.provider),
          source: asString(model.source) || 'unknown',
          // 上下文窗口（最大输入 token 数）。
          // 2026-11-13：只有 probe 能给出可信值时才有这个字段；
          // 拿不到就是 null，UI 显示「未知」。**不猜**。
          contextWindow: Number.isFinite(model.contextWindow) ? Number(model.contextWindow) : null,
          contextWindowSource: asString(model.contextWindowSource) || '',
          // 2026-11-16 缺陷修复：账号可用性（true/false；缺省 = 未验证）。
          // 只有明确 false 才提示「账号不可用」；未验证（undefined）当作可选，
          // 避免探测抖动让用户以为模型坏了。
          ...(typeof model.available === 'boolean' ? { available: model.available } : {}),
        }))
        .filter((model) => model.id)
      const strengths = asArray(source.strengths)
        .filter((strength) => strength && typeof strength === 'object')
        .map((strength) => ({
          id: asString(strength.id),
          label: asString(strength.label) || asString(strength.id),
          source: asString(strength.source) || 'unknown',
        }))
        .filter((strength) => strength.id)
      const sources = asObject(source.sources)
      return {
        id,
        label: asString(source.label) || id,
        provider: asString(source.provider),
        models,
        strengths,
        sources: {
          models: asString(sources.models) || 'unknown',
          strengths: asString(sources.strengths) || 'unknown',
        },
        refreshedAt: Number.isFinite(source.refreshedAt) ? source.refreshedAt : null,
        errors: asArray(source.errors).map(String).slice(0, 5),
      }
    }

    /** CLI 能力目录收窄：接受数组或 `{clis:[]}` 两种形状（B2b 契约）；只保留 4 个已知 CLI。 */
    function normalizeCapabilities(value) {
      const list = Array.isArray(value) ? value : asArray(asObject(value).clis)
      const byId = new Map()
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const entry = normalizeCapabilityEntry(item)
        if (!CLI_IDS.includes(entry.id) || byId.has(entry.id)) continue
        byId.set(entry.id, entry)
      }
      return CLI_IDS.filter((id) => byId.has(id)).map((id) => byId.get(id))
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
        // B2b/B2c：4 CLI × 模型 × 强度的能力目录（唯一能力来源；缺失时 UI 显示 4 CLI + 未知）。
        capabilities: normalizeCapabilities(source.capabilities),
        capabilitiesRefreshedAt: Number.isFinite(source.capabilitiesRefreshedAt)
          ? source.capabilitiesRefreshedAt
          : null,
        capabilitiesErrors: asArray(source.capabilitiesErrors).map(String).slice(0, 10),
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
          .map((role) => {
            const kind = asString(role.kind)
            const channelId = asString(role.channelId)
            return {
              roleId: asString(role.roleId),
              name: asString(role.name),
              aliases: asArray(role.aliases).map(String),
              // B1：设置页内联全局角色管理要能直接编辑这些字段（Host roleView 已投影）。
              // B2：description+prompt 合并为单一 setting；旧字段保留为兼容镜像。
              setting:
                asString(role.setting) || asString(role.prompt) || asString(role.description),
              description: asString(role.description),
              prompt: asString(role.prompt),
              enabled: role.enabled !== false,
              availability: asString(role.availability) || 'unknown',
              channelId,
              kind,
              provider: asString(role.provider),
              model: asString(role.model),
              reasoning: asString(role.reasoning),
              sourceLayer: SOURCE_LAYERS.has(asString(role.sourceLayer))
                ? asString(role.sourceLayer)
                : 'default',
              fieldSources: normalizeFieldSources(role.fieldSources),
              state: normalizeRoleState(role),
              // draftOfRole() 读嵌套 channel；这里保留扁平字段同时给出嵌套形状。
              channel: {
                channelId,
                kind,
                provider: asString(role.provider),
                model: asString(role.model),
                reasoning: asString(role.reasoning),
              },
            }
          }),
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
    // B3（2026-11-12）：角色配置只有全局一层，项目/会话来源已下线。
    // 只保留 global 与 default 两种，避免 UI 显示「项目」来源这种不存在的层。
    const SOURCE_LAYERS = new Set(['global', 'default'])

    /** 角色字段来源键（与 Host `roleView().fieldSources` 一致）。 */
    const ROLE_SOURCE_FIELDS = [
      'name',
      'aliases',
      'setting',
      'enabled',
      'channel.channelId',
      'channel.kind',
      'channel.provider',
      'channel.cli',
      'channel.model',
      'channel.reasoning',
    ]

    /** 字段来源映射收窄：缺失/未知 → default（不把未知来源猜成 global）。 */
    function normalizeFieldSources(value) {
      const source = asObject(value)
      /** @type {Record<string, string>} */
      const out = {}
      for (const key of ROLE_SOURCE_FIELDS) {
        const layer = source[key]
        out[key] = SOURCE_LAYERS.has(layer) ? layer : 'default'
      }
      return out
    }

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
        // quota 只保留诊断值（V1 裁决 2026-11-12：不再有 exhausted，它不参与颜色）
        quota:
          quota === 'available' || quota === 'not_applicable' ? quota : 'unknown',
        // 两色（V1 裁决）：只认 green / gray，其它一律按 gray
        color: color === 'green' ? 'green' : 'gray',
        availability: asString(source.availability) || 'unknown',
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

    /**
     * 把上下文窗口数字格式化成紧凑形式。
     *
     * 2026-11-13：模型下拉要显示「这个模型能吃多少上下文」。
     * 1,000,000 → `1M`；192,000 → `192K`；300,000 → `300K`。
     * 非数字/非正数 → 空串（调用方据此不显示，绝不编造）。
     *
     * @param {any} value
     * @returns {string}
     */
    function formatContextWindow(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return ''
      if (n >= 1_000_000) {
        const m = n / 1_000_000
        return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
      }
      if (n >= 1000) {
        const k = n / 1000
        return `${Number.isInteger(k) ? k : k.toFixed(1)}K`
      }
      return String(n)
    }

    /**
     * 把 remote 错误码翻译成**用户能看懂的话**。
     *
     * 2026-11-12 用户真机反馈「刷新能力一点就红字报错」，暴露两个问题：
     * 1. 底层是 ReferenceError（已修）；
     * 2. 就算是我们自己的 RemoteError，用户也只看到一行 code/message，
     *    不知道该怎么办。
     *
     * 这里把已知错误码翻成「发生了什么 + 怎么办」，未知码原样透出（不编造）。
     *
     * @param {string} code
     * @param {string} message
     */
    function explainRemoteError(code, message) {
      if (code === 'MEETINGSTONE_GUI_CAPABILITIES_UNAVAILABLE') {
        return '能力目录未就绪：插件初始化时没拿到模型清单。点「刷新能力」重试；仍失败请重启 DSH。'
      }
      if (code === 'MEETINGSTONE_GUI_REMOTE_UNAVAILABLE') {
        return '配置服务未装配：插件的 GUI 写入通道没准备好。重启 DSH 后重试。'
      }
      if (code === 'REMOTE_UNAVAILABLE') {
        return '设置页还没连上宿主（remote.meetingstone 未就绪）。稍等片刻或重新打开设置页。'
      }
      if (code === 'gateway/internal') {
        // 宿主把未捕获异常统一包成这个码。原文里通常带真实原因。
        return `宿主内部错误：${message || '无详情'}`
      }
      // 未知码：原样透出，不编造解释
      return message || code
    }

    /** 配置写/检测操作（CLI 开关 + 全局角色；全局写入由调用方二次确认）。 */
    function makeConfigActions(serviceOrGet, mountFailure) {
      const call = makeRemoteCall(serviceOrGet, mountFailure)
      return {
        setCliEnabled: (cli, enabled) => call('setCliEnabled', [cli, enabled]),
        refreshCli: (cli, force) => call('refreshCli', [cli, Boolean(force)]),
        updateGlobalRole: (roleId, patch) => call('updateGlobalRole', [roleId, patch]),
        createGlobalRole: (role) => call('createGlobalRole', [role]),
        deleteGlobalRole: (roleId) => call('deleteGlobalRole', [roleId]),
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
     *   color?: 'gray' | 'green',
     *   onChange?: (next: boolean) => void,
     * }} props
     */
    function Switch(props) {
      const checked = props?.checked === true
      // V1 两色（2026-11-12 裁决）：只认 green / gray
      const color = props?.color === 'green' ? 'green' : 'gray'
      const offTrack = 'var(--dsw-alias-border-l4)'
      const onTrack =
        color === 'green'
          ? 'var(--dsw-alias-state-success-primary)'
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
      available: '可用',
      disabled: '已停用',
      providerUnavailable: '执行组合不可用',
      ambiguous: '别名冲突',
      unknown: '未知',
      // V1 三区精简
      manageRoles: '管理角色',
      globalRolesTitle: '全局角色管理',
      globalRolesNote:
        '此面板直接编辑**全局**角色（写入 profile），保存后对所有会话生效；B3 起不再有会话级临时覆盖。',
      globalRolesEmpty: '全局配置里还没有角色',
      globalRoleBadge: '全局',
      managerClose: '收起',
      managerOpenLabel: '打开全局角色管理',
      capabilitySource: '能力来源',
      sourceModels: '模型',
      sourceStrengths: '强度',
      sourceDiscovered: '动态',
      sourceConfig: '配置',
      sourceStatic: '静态',
      sourceUnknown: '未知',
      // 2026-11-12 用户真机反馈「模型下拉只有我之前用的选项，没有实时获取的」。
      // 事实：codebuddy / claude **没有**可程序化枚举模型的接口
      //（codebuddy --help 需后端环境、settings.json 无模型表；
      //  claude 只有 --model <alias>，别名不可枚举）。
      // 「配置/静态」就是它们的真实上限，不是 bug。这里把话说清楚，
      // 避免用户以为「刷新一下就能出实时列表」。
      capabilitySourceNote:
        '「动态」= 从 CLI/宿主实时探测；「配置」= 来自本机 profile 的声明；' +
        '「静态」= 插件内置的已知清单。CodeBuddy 与 Claude Code 目前没有可枚举模型的接口，' +
        '它们的模型只能来自配置或内置清单。',
      backToSettings: '返回',
      refreshCapabilities: '刷新能力',
      refreshing: '刷新中…',
      capabilityUnknown: '能力目录不可用（未知）',
      comboChannelUnsupported:
        '该角色仍引用旧执行组合，无法在全局层直接切换到没有对应实例的 CLI；请选择其它 CLI，或由维护者清理 profile。',
      // 2026-11-16 缺陷修复：codex 的 model/list 只是「版本认识哪些模型」，
      // 不含账号授权。实测有模型会返回 model_not_found，在选项里明确标出来。
      // 2026-11-16：额度耗尽 ≠ 模型不可用。这是账号状态，额度恢复即恢复正常。
      modelRateLimited: '额度已用尽',
      addRole: '新增角色',
      createRoleTitle: '新建全局角色',
      createRoleHint: '角色 ID 自动生成（role-<名称>，冲突自动加序号）；保存后写入 profile，对所有会话生效。',
      createRole: '创建角色',
      deleteRole: '删除角色',
      confirmDeleteRole:
        '确认删除该全局角色？只删除 profile 中的定义。删除后当前会话若仍引用它，会回退到默认路由。',
      confirmDelete: '确认删除',
      roleCount: '角色数量',
      errorWarning: '最近一次错误',
      errorDetails: '查看详情',
      errorHideDetails: '收起详情',
      // CLI 分类
      // 顶部集合石入口 + 右侧栏只读角色面板
      sourceGlobal: '全局',
      sourceProject: '项目',
      sourceDefault: '默认',
      sourceUnknown: '未知',
      renderFailed: '面板渲染失败，详情见宿主日志',
      remoteUnavailableHint: '远程不可用',
      // U2：设置页两区 + 角色两色二态 + 二级详情
      cliSection: '外部 CLI 连接',
      rolesSection: '全局角色库',
      // 卡片只描述「当前全局角色库」。插件自带 3 个默认角色，但仅在用户
      // 还没有任何角色时生效，绝不覆盖用户已有配置（见 src/roles/defaults.js）。
      templateName: '我的角色',
      templateDesc: '角色与 CLI、模型、思考强度按角色单独配置；未配置时使用内置默认角色。',
      cliSwitchLabel: '启用',
      cliOnFailed: '检测未通过，保持关闭',
      cliRetry: '重新检测',
      cliDetecting: '检测中…',
      manualSteps: '人工步骤',
      noCliStates: '未获取到 CLI 状态（不影响角色配置）',
      // 角色列表
      roleOpenDetail: '查看角色详情',
      roleEnabled: '已启用',
      // V1 裁决（2026-11-12）：颜色只表示启用与依赖就绪，不表示实时额度。
      roleColorNote: '颜色仅表示启用与依赖就绪状态，不表示实时额度。',
      roleDisabled: '已关闭',
      roleBlocked: '依赖阻断',
      roleUnknown: '状态未知',
      roleSwitchLabel: '启用角色',
      noRolesDetail: '没有可编辑的角色',
      // 详情
      detailTitle: '角色详情',
      detailBack: '返回角色列表',
      scopeSession: '本会话',
      scopeGlobal: '全局',
      scopeGlobalNote: '全局修改会写入 profile，影响所有会话；保存前需二次确认。',
      scopeGlobalBlocked: '全局层不支持恢复继承（全局层没有可回退的上层）',
      fieldName: '名称',
      fieldAliases: '简称',
      fieldSetting: '角色设定',
      fieldCli: 'CLI',
      fieldModel: '模型',
      fieldReasoning: '思考强度',
      fieldUnset: '未设置',
      unsupported: '不支持',
      pendingConfig: '待配置',
      restoreInherit: '恢复继承',
      saveDetail: '保存修改',
      savingDetail: '保存中…',
      detailNoChanges: '没有需要保存的差异',
      confirmGlobal: '确认写入全局配置？',
      confirm: '确认',
      cancel: '取消',
      noModelOptions: '当前 CLI 没有可选模型',
      noReasoningOptions: '当前 CLI/模型不支持思考强度',
      detailInvalidName: '名称不能为空',
      detailInvalidAliases: '简称格式：逗号分隔的字符串',
    }
    const en = {
      nav: 'MeetingStone',
      loading: 'Loading…',
      loadFailed: 'Failed to read host data',
      unavailable: 'Remote data unavailable',
      available: 'Available',
      disabled: 'Disabled',
      providerUnavailable: 'Execution combo unavailable',
      ambiguous: 'Alias conflict',
      unknown: 'Unknown',
      // V1 三区精简
      manageRoles: 'Manage roles',
      globalRolesTitle: 'Global roles',
      globalRolesNote:
        'This panel edits **global** roles (written to the profile) and affects every session; per-session overrides were removed in B3.',
      globalRolesEmpty: 'No roles in the global configuration yet',
      globalRoleBadge: 'Global',
      managerClose: 'Collapse',
      managerOpenLabel: 'Open global role management',
      capabilitySource: 'Capability source',
      sourceModels: 'Models',
      sourceStrengths: 'Strengths',
      sourceDiscovered: 'dynamic',
      sourceConfig: 'config',
      sourceStatic: 'static',
      sourceUnknown: 'unknown',
      backToSettings: 'Back',
      refreshCapabilities: 'Refresh capabilities',
      refreshing: 'Refreshing…',
      capabilityUnknown: 'Capability catalog unavailable (unknown)',
      comboChannelUnsupported:
        'This role still references an old execution combo, so switching to a CLI without a matching instance is not possible at the global layer; pick another CLI or ask the maintainer to clean the profile.',
      modelRateLimited: 'rate limit reached',
      addRole: 'Add role',
      createRoleTitle: 'New global role',
      createRoleHint:
        'Role ID is generated automatically (role-<name>, with a numeric suffix on conflict); saving writes the profile and affects every session.',
      createRole: 'Create role',
      deleteRole: 'Delete role',
      confirmDeleteRole:
        'Delete this global role? Only the definition in the profile is removed. Sessions referencing it fall back to the default route.',
      confirmDelete: 'Delete',
      roleCount: 'Role count',
      errorWarning: 'Most recent error',
      errorDetails: 'View details',
      errorHideDetails: 'Hide details',
      // CLI 分类
      // 顶部集合石入口 + 右侧栏只读角色面板
      sourceGlobal: 'Global',
      sourceProject: 'Project',
      sourceDefault: 'Default',
      sourceUnknown: 'Unknown',
      renderFailed: 'Failed to render this panel; see host logs',
      remoteUnavailableHint: 'Remote unavailable',
      // U2: settings sections + two-tone role switches + detail view
      cliSection: 'External CLI connections',
      rolesSection: 'Global roles',
      // Describes the current global role library. Three default roles apply only
      // when the user has none; existing configuration is never overwritten.
      templateName: 'My roles',
      templateDesc: 'Each role sets its own CLI, model and reasoning effort; built-in defaults apply until you configure your own.',
      cliSwitchLabel: 'Enable',
      cliOnFailed: 'Preflight failed; kept off',
      cliRetry: 'Re-check',
      cliDetecting: 'Checking…',
      manualSteps: 'Manual steps',
      noCliStates: 'CLI states unavailable (role configuration is unaffected)',
      roleOpenDetail: 'Open role detail',
      roleEnabled: 'Enabled',
      roleColorNote:
        'Colors only indicate enablement and dependency readiness, not real-time quota.',
      roleDisabled: 'Off',
      roleBlocked: 'Blocked',
      roleUnknown: 'Unknown',
      roleSwitchLabel: 'Enable role',
      noRolesDetail: 'No editable roles',
      detailTitle: 'Role detail',
      detailBack: 'Back to role list',
      scopeSession: 'This session',
      scopeGlobal: 'Global',
      scopeGlobalNote: 'Global changes are written to the profile and affect every session; a second confirmation is required.',
      scopeGlobalBlocked: 'Restore inheritance is not available at the global layer (it has no parent layer)',
      fieldName: 'Name',
      fieldAliases: 'Aliases',
      fieldSetting: 'Role setting',
      fieldCli: 'CLI',
      fieldModel: 'Model',
      fieldReasoning: 'Reasoning',
      fieldUnset: 'Not set',
      unsupported: 'Unsupported',
      pendingConfig: 'Pending configuration',
      restoreInherit: 'Restore inheritance',
      saveDetail: 'Save changes',
      savingDetail: 'Saving…',
      detailNoChanges: 'No differences to save',
      confirmGlobal: 'Write to global configuration?',
      confirm: 'Confirm',
      cancel: 'Cancel',
      noModelOptions: 'No model available for this CLI',
      noReasoningOptions: 'This CLI/model does not support reasoning effort',
      detailInvalidName: 'Name cannot be empty',
      detailInvalidAliases: 'Aliases must be comma-separated strings',
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
     *   managerOpen?: boolean,
     *   onToggleManager?: () => void,
     *   manager?: object,
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
      const managerOpen = opts.managerOpen === true
      const onToggleManager =
        typeof opts.onToggleManager === 'function' ? opts.onToggleManager : () => {}
      const managerOpts = asObject(opts.manager)
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
                'aria-expanded': managerOpen,
                'aria-label': managerOpen ? t('managerClose') : t('managerOpenLabel'),
                onClick: onToggleManager,
                children: managerOpen ? t('managerClose') : t('manageRoles'),
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
          // B1：全局角色管理内联在本页展开，不打开右侧栏会话面板、不跳转。
          managerOpen ? renderGlobalRoleManager(t, snapshot, managerOpts) : null,
        ],
      })
    }

    /**
     * 设置页「全局角色管理」（B1）：**内联**在设置页展开，不离开当前页。
     *
     * 数据源是无参 `list()` 快照里的**全局** roles（Host `roleView` 已投影
     * description/prompt/fieldSources）；写路径复用既有 `updateGlobalRole`
     * （S2 global writer，字段合并），保存前二次确认。
     *
     * B3（2026-11-12）：会话级角色覆盖已整体下线 —— 本面板是**唯一**的角色管理入口，
     * 不再有「会话覆盖在别处调整」这种情况。
     *
     * @param {(key: string) => string} t
     * @param {any} snapshot `normalizeSnapshot()` 的产物
     * @param {{
     *   selectedRoleId?: string,
     *   draft?: any,
     *   creating?: boolean,
     *   onSelect?: Function,
     *   onCreate?: Function,
     *   onBack?: Function,
     *   onDraft?: Function,
     *   onSave?: Function,
     *   onCancelConfirm?: Function,
     *   onRequestDelete?: Function,
     *   onConfirmDelete?: Function,
     *   onCancelDelete?: Function,
     *   onClose?: Function,
     *   saving?: boolean,
     *   confirming?: boolean,
     *   deleteConfirming?: boolean,
     *   error?: any,
     * }} [opts]
     */
    function renderGlobalRoleManager(t, snapshot, opts = {}) {
      const roles = asArray(snapshot?.roles)
      const globalChannels = asArray(snapshot?.global?.channels)
      // 详情下拉只列真实通道实例：优先用 global.channels（含 model/reasoning），
      // 退回归一化后的 snapshot.channels（只有 channelId/kind）。
      const view = {
        ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
        roles,
        channels: globalChannels.length > 0 ? globalChannels : asArray(snapshot?.channels),
      }
      const selectedRoleId = asString(opts.selectedRoleId)
      const creating = opts.creating === true
      const deleteConfirming = opts.deleteConfirming === true
      const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : () => {}
      const onCreate = typeof opts.onCreate === 'function' ? opts.onCreate : () => {}
      const onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {}
      const onRequestDelete =
        typeof opts.onRequestDelete === 'function' ? opts.onRequestDelete : () => {}
      const onConfirmDelete =
        typeof opts.onConfirmDelete === 'function' ? opts.onConfirmDelete : () => {}
      const onCancelDelete =
        typeof opts.onCancelDelete === 'function' ? opts.onCancelDelete : () => {}
      const onBackToSettings =
        typeof opts.onBackToSettings === 'function' ? opts.onBackToSettings : onClose
      const pendingRoleIds = new Set(asArray(opts.pendingRoleIds).map(String))
      const onToggleRole = typeof opts.onToggleRole === 'function' ? opts.onToggleRole : () => {}
      const header = jsxs('div', {
        style: alignRow,
        children: [
          jsx('h3', { style: { ...heading, fontSize: 13 }, children: t('globalRolesTitle') }),
          jsx('span', { style: grow }),
          jsx(Tag, { tone: 'info', children: t('globalRoleBadge') }),
          // B3：设置页角色区「返回」——回到集合石设置主区（不引入新路由）。
          jsx('button', {
            type: 'button',
            style: linkButton,
            onClick: onBackToSettings,
            children: `← ${t('backToSettings')}`,
          }),
        ],
      })
      const note = jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2 },
        children: [
          jsx('p', { style: noteStyle, children: t('globalRolesNote') }),
          // 两色语义的说明（2026-11-12 裁决）。
          // **注意**：这个字典项早就加了，但一直没渲染出来 —— 2026-11-12 的
          // 交互层核对脚本发现「只有字典、无调用点」。现在补上真正的渲染。
          jsx('p', { style: noteStyle, children: t('roleColorNote') }),
        ],
      })

      // 详情：新建（虚拟角色 + 空 draft，不落盘）或编辑现有角色。
      if (creating || selectedRoleId) {
        const virtualRole = {
          roleId: selectedRoleId || '__new_role__',
          name: '',
          aliases: [],
          setting: '',
          channel: {},
          enabled: true,
          fieldSources: {},
          state: {},
        }
        const detailView = creating ? { ...view, roles: [...roles, virtualRole] } : view
        const detailRoleId = creating ? virtualRole.roleId : selectedRoleId
        return jsxs('div', {
          style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 },
          children: [
            header,
            note,
            creating ? jsx('p', { style: noteStyle, children: t('createRoleHint') }) : null,
            renderRoleDetail(t, detailView, detailRoleId, {
              scope: 'global',
              draft: opts.draft ?? (creating ? emptyRoleDraft() : undefined),
              saving: opts.saving === true,
              confirming: opts.confirming === true,
              error: opts.error,
              showScope: false,
              title: creating ? t('createRoleTitle') : undefined,
              saveLabel: creating ? t('createRole') : undefined,
              onBack: opts.onBack,
              onDraft: opts.onDraft,
              onSave: opts.onSave,
              onCancelConfirm: opts.onCancelConfirm,
              refreshing: opts.refreshing === true,
              onRefreshCapabilities: opts.onRefreshCapabilities,
            }),
            creating
              ? null
              : deleteConfirming
                ? jsxs('div', {
                    style: { ...card, gap: 4, borderColor: 'var(--dsw-alias-state-error-primary)' },
                    children: [
                      jsx('div', { style: noteStyle, children: t('confirmDeleteRole') }),
                      jsxs('div', {
                        style: { display: 'flex', gap: 8 },
                        children: [
                          jsx('button', {
                            type: 'button',
                            style: { ...scopeButton, color: 'var(--dsw-alias-state-error-primary)' },
                            disabled: opts.saving === true,
                            onClick: onConfirmDelete,
                            children: t('confirmDelete'),
                          }),
                          jsx('button', {
                            type: 'button',
                            style: scopeButton,
                            onClick: onCancelDelete,
                            children: t('cancel'),
                          }),
                        ],
                      }),
                    ],
                  })
                : jsx('div', {
                    style: { display: 'flex', justifyContent: 'flex-end' },
                    children: jsx('button', {
                      type: 'button',
                      style: { ...linkButton, color: 'var(--dsw-alias-state-error-primary)' },
                      onClick: onRequestDelete,
                      children: t('deleteRole'),
                    }),
                  }),
          ],
        })
      }

      // 列表：每行名称 + 启停状态；底部「新增角色 / 收起」。
      return jsxs('div', {
        style: { ...card, display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          header,
          note,
          roles.length === 0
            ? jsx('p', { style: noteStyle, children: t('globalRolesEmpty') })
            : jsx('div', {
                style: list,
                children: roles.map((role) =>
                  jsxs(
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
                            flex: 1,
                            minWidth: 0,
                          },
                          'aria-label': `${t('roleOpenDetail')}: ${role.name || role.roleId}`,
                          onClick: () => onSelect(role.roleId),
                          children: role.name || role.roleId || t('unknown'),
                        }),
                        jsx(Switch, {
                          checked: role.enabled === true,
                          label: `${t('roleSwitchLabel')}: ${role.name || role.roleId}`,
                          title: role.enabled === true ? t('roleEnabled') : t('roleDisabled'),
                          disabled: pendingRoleIds.has(role.roleId),
                          color: asObject(role.state).color,
                          onChange: (next) => onToggleRole(role.roleId, next),
                        }),
                      ],
                    },
                    role.roleId || role.name,
                  ),
                ),
              }),
          jsx('div', {
            style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
            children: [
              jsx('button', {
                type: 'button',
                style: scopeButton,
                onClick: onCreate,
                children: t('addRole'),
              }),
              jsx('button', {
                type: 'button',
                style: linkButton,
                onClick: onClose,
                children: t('managerClose'),
              }),
            ],
          }),
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
    function Section({ t, list: load, updateGlobalRole, createGlobalRole, deleteGlobalRole, setCliEnabled, refreshCli }) {
      const [state, setState] = react.useState({ status: 'loading' })
      const [errorOpen, setErrorOpen] = react.useState(false)
      const [cliStates, setCliStates] = react.useState(null)
      const [cliPending, setCliPending] = react.useState({})
      const [cliFailures, setCliFailures] = react.useState({})
      // B1：设置页内联全局角色管理（不打开右侧栏会话面板）。
      const [managerOpen, setManagerOpen] = react.useState(false)
      // B1b：list / edit / create 三态 + 删除二次确认。
      const [managerMode, setManagerMode] = react.useState('list')
      const [managerRoleId, setManagerRoleId] = react.useState('')
      const [managerDraft, setManagerDraft] = react.useState(null)
      const [managerSaving, setManagerSaving] = react.useState(false)
      const [managerConfirming, setManagerConfirming] = react.useState(false)
      const [managerDeleteConfirming, setManagerDeleteConfirming] = react.useState(false)
      const [managerError, setManagerError] = react.useState(null)
      // B2c：角色启用开关 pending + 能力刷新中。
      const [managerPendingRoleIds, setManagerPendingRoleIds] = react.useState([])
      const [managerRefreshing, setManagerRefreshing] = react.useState(false)

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

      /**
       * 重新检测：只读 preflight（force 绕过缓存），不写配置。
       *
       * 2026-11-16：同 refreshManagerCapabilities —— 用 try/finally 保证
       * pending 状态一定复位，否则 Remote 抛异常会让按钮永久「检测中…」。
       */
      async function retryCli(cli) {
        if (typeof refreshCli !== 'function') return
        setCliPending((previous) => ({ ...previous, [cli]: true }))
        try {
          const result = await refreshCli(cli, true)
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
        } catch (error) {
          setCliFailures((previous) => ({
            ...previous,
            [cli]: {
              code: 'CLI_PREFLIGHT_FAILED',
              message: error instanceof Error ? error.message : String(error),
              manualSteps: [],
              retryable: true,
            },
          }))
        } finally {
          setCliPending((previous) => ({ ...previous, [cli]: false }))
        }
      }

      // ── B1：设置页内联全局角色管理（不打开右侧栏、不离开设置页） ─────────────
      /** 重新拉无参 list() 快照（全局管理保存后刷新）。 */
      async function reloadSnapshot() {
        const snapshot = await load()
        setState({ status: 'ready', snapshot })
        return { ok: true, view: snapshot }
      }

      function closeManager() {
        setManagerOpen(false)
        setManagerMode('list')
        setManagerRoleId('')
        setManagerDraft(null)
        setManagerConfirming(false)
        setManagerDeleteConfirming(false)
        setManagerError(null)
      }

      function toggleManager() {
        if (managerOpen) {
          closeManager()
          return
        }
        setManagerOpen(true)
        setManagerMode('list')
        setManagerRoleId('')
        setManagerDraft(null)
        setManagerConfirming(false)
        setManagerDeleteConfirming(false)
        setManagerError(null)
      }

      function selectManagerRole(roleId) {
        const role = asArray(state.snapshot?.roles).find((item) => item.roleId === roleId)
        setManagerMode('edit')
        setManagerRoleId(roleId)
        setManagerDraft(role ? draftOfRole(role) : null)
        setManagerConfirming(false)
        setManagerDeleteConfirming(false)
        setManagerError(null)
      }

      function backToManagerList() {
        setManagerMode('list')
        setManagerRoleId('')
        setManagerDraft(null)
        setManagerConfirming(false)
        setManagerDeleteConfirming(false)
        setManagerError(null)
      }

      /** B1b：进入新建态（空 draft，roleId 保存时由系统生成）。 */
      function createManagerRole() {
        setManagerMode('create')
        setManagerRoleId('')
        setManagerDraft(emptyRoleDraft())
        setManagerConfirming(false)
        setManagerDeleteConfirming(false)
        setManagerError(null)
      }

      function updateManagerDraft(field, value) {
        setManagerDraft((previous) => {
          const next = { ...(previous ?? {}), [field]: value }
          if (field === 'cli') {
            // B2 联动：切 CLI 清空模型/强度，避免残留非法组合。
            next.model = ''
            next.reasoning = ''
          }
          return next
        })
        setManagerConfirming(false)
        setManagerDeleteConfirming(false)
        setManagerError(null)
      }

      /**
       * 保存全局角色：编辑=一次 patch；新建=一次 create；都先二次确认。
       * 失败不刷新列表、不乐观更新（错误落详情一行摘要）。
       */
      async function saveManagerRole() {
        if (!managerConfirming) {
          setManagerConfirming(true)
          return
        }
        const channels = state.snapshot?.global?.channels
        if (managerMode === 'create') {
          if (typeof createGlobalRole !== 'function') {
            setManagerError({ code: 'REMOTE_UNAVAILABLE', message: t('remoteUnavailableHint') })
            return
          }
          const built = buildCreateRolePayload(
            t,
            managerDraft,
            capabilitiesOf(state.snapshot),
            channels,
            asArray(state.snapshot?.roles).map((item) => item.roleId),
          )
          if (built.error) {
            setManagerConfirming(false)
            setManagerError({ code: 'DETAIL_INVALID', message: built.error })
            return
          }
          setManagerSaving(true)
          const result = await saveCreateGlobalRole({
            role: built.payload,
            createGlobalRole,
            reload: reloadSnapshot,
          })
          setManagerSaving(false)
          setManagerConfirming(false)
          if (result.ok !== true) {
            setManagerError(result.error)
            return
          }
          const nextRole = asArray(result.view?.roles).find((item) => item.roleId === result.roleId)
          setManagerMode('edit')
          setManagerRoleId(result.roleId)
          setManagerDraft(nextRole ? draftOfRole(nextRole) : null)
          return
        }

        const role = asArray(state.snapshot?.roles).find((item) => item.roleId === managerRoleId)
        if (!role || !managerDraft) return
        if (typeof updateGlobalRole !== 'function') {
          setManagerError({ code: 'REMOTE_UNAVAILABLE', message: t('remoteUnavailableHint') })
          return
        }
        const built = buildGlobalPatch(t, role, managerDraft, capabilitiesOf(state.snapshot), channels)
        if (built.error) {
          setManagerConfirming(false)
          setManagerError({ code: 'DETAIL_INVALID', message: built.error })
          return
        }
        if (Object.keys(built.patch).length === 0) {
          setManagerConfirming(false)
          setManagerError({ code: 'DETAIL_NO_CHANGES', message: t('detailNoChanges') })
          return
        }
        setManagerSaving(true)
        const result = await saveGlobalPatch({
          roleId: managerRoleId,
          patch: built.patch,
          updateGlobalRole,
          reload: reloadSnapshot,
        })
        setManagerSaving(false)
        setManagerConfirming(false)
        if (result.ok !== true) {
          setManagerError(result.error)
          return
        }
        const nextRole = asArray(result.view?.roles).find((item) => item.roleId === managerRoleId)
        setManagerDraft(nextRole ? draftOfRole(nextRole) : null)
      }

      /** 删除第一步：进入二次确认（不写盘）。 */
      function requestDeleteManagerRole() {
        setManagerDeleteConfirming(true)
        setManagerConfirming(false)
        setManagerError(null)
      }

      function cancelDeleteManagerRole() {
        setManagerDeleteConfirming(false)
      }

      /** 删除第二步：确认后一次 delete；失败保持当前详情，不刷新列表。 */
      async function confirmDeleteManagerRole() {
        if (!managerRoleId) return
        if (typeof deleteGlobalRole !== 'function') {
          setManagerError({ code: 'REMOTE_UNAVAILABLE', message: t('remoteUnavailableHint') })
          return
        }
        setManagerSaving(true)
        const result = await saveDeleteGlobalRole({
          roleId: managerRoleId,
          deleteGlobalRole,
          reload: reloadSnapshot,
        })
        setManagerSaving(false)
        setManagerDeleteConfirming(false)
        if (result.ok !== true) {
          setManagerError(result.error)
          return
        }
        backToManagerList()
      }

      /** B2c：全局角色启用开关（写 profile enabled；失败不回滚假象，重新拉快照）。 */
      async function toggleManagerRole(roleId, next) {
        if (typeof updateGlobalRole !== 'function') {
          setManagerError({ code: 'REMOTE_UNAVAILABLE', message: t('remoteUnavailableHint') })
          return
        }
        setManagerPendingRoleIds((previous) => [...previous, roleId])
        setManagerError(null)
        const result = await updateGlobalRole(roleId, { enabled: next === true })
        setManagerPendingRoleIds((previous) => previous.filter((id) => id !== roleId))
        if (!result || result.ok !== true) {
          setManagerError(result?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' })
          return
        }
        const loaded = await reloadSnapshot()
        if (loaded && loaded.ok === true) {
          const role = asArray(loaded.view?.roles).find((item) => item.roleId === roleId)
          setManagerDraft(role ? draftOfRole(role) : null)
        }
      }

      /**
       * B2c：刷新当前 CLI 的能力目录（模型/强度），只更新本地快照，不写配置。
       *
       * 2026-11-16 真机缺陷：原来 `setManagerRefreshing(true)` 之后直接
       * `await refreshCli(...)` —— 只要它**抛异常**（Remote 层超时/崩溃/gateway/internal），
       * `setManagerRefreshing(false)` 就永远不执行，按钮永久停在「刷新中…」。
       * 现在用 try/finally 保证状态一定复位。
       */
      async function refreshManagerCapabilities(cli) {
        if (typeof refreshCli !== 'function' || !cli) return
        setManagerRefreshing(true)
        try {
          const result = await refreshCli(cli, true)
          if (!result || result.ok !== true) {
            setManagerError(result?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' })
            return
          }
          const payload = asObject(result.value)
          const capabilities = normalizeCapabilities(payload.capabilities)
          if (capabilities.length > 0) {
            setState((previous) =>
              previous.status === 'ready'
                ? {
                    ...previous,
                    snapshot: {
                      ...previous.snapshot,
                      global: {
                        ...(previous.snapshot.global ?? {}),
                        capabilities,
                        capabilitiesRefreshedAt: Date.now(),
                      },
                    },
                  }
                : previous,
            )
          }
          setManagerError(null)
        } catch (error) {
          // Remote 抛错也要回到可操作状态，并把原因显示出来（不吞）
          setManagerError({
            code: 'REFRESH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          setManagerRefreshing(false)
        }
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
                managerOpen,
                onToggleManager: toggleManager,
                manager: {
                  selectedRoleId: managerRoleId,
                  draft: managerDraft,
                  creating: managerMode === 'create',
                  saving: managerSaving,
                  confirming: managerConfirming,
                  deleteConfirming: managerDeleteConfirming,
                  error: managerError,
                  onSelect: selectManagerRole,
                  onCreate: createManagerRole,
                  onBack: backToManagerList,
                  onDraft: updateManagerDraft,
                  onSave: saveManagerRole,
                  onCancelConfirm: () => setManagerConfirming(false),
                  onRequestDelete: requestDeleteManagerRole,
                  onConfirmDelete: confirmDeleteManagerRole,
                  onCancelDelete: cancelDeleteManagerRole,
                  onToggleRole: toggleManagerRole,
                  onBackToSettings: closeManager,
                  pendingRoleIds: managerPendingRoleIds,
                  onRefreshCapabilities: () => refreshManagerCapabilities(managerDraft?.cli),
                  refreshing: managerRefreshing,
                  onClose: closeManager,
                },
                onToggleCli: toggleCli,
                onRetryCli: retryCli,
                onToggleError: () => setErrorOpen(!errorOpen),
              }),
            ],
          }),
        () => renderFailureNote(t),
      )
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
              // 区 2「管理角色」：设置页**内联**全局角色管理（B1）。
              // 写路径复用 S2 global writer（字段合并 + 二次确认），不新建写 API；
              // 会话级角色覆盖已下线（B3），本面板是唯一的角色管理入口。
              updateGlobalRole: (roleId, patch) =>
                typeof configActions.updateGlobalRole === 'function'
                  ? configActions.updateGlobalRole(roleId, patch)
                  : { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '配置远程未装配' } },
              // B1b：新增/删除全局角色；同一 global writer 路径，失败原样返回错误码。
              createGlobalRole: (role) =>
                typeof configActions.createGlobalRole === 'function'
                  ? configActions.createGlobalRole(role)
                  : { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '配置远程未装配' } },
              deleteGlobalRole: (roleId) =>
                typeof configActions.deleteGlobalRole === 'function'
                  ? configActions.deleteGlobalRole(roleId)
                  : { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '配置远程未装配' } },
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

    /** 两色 → Tag tone（只用宿主已有 tone，不新增色板）。V1 裁决：已无黄色。 */
    function roleColorTone(color) {
      if (color === 'green') return 'success'
      return 'neutral'
    }

    /**
     * 阻断原因的**一行**说明（只用于 Tooltip 与列表下方说明，不展开细节）。
     *
     * 2026-11-12 裁决：删掉 `quota === 'exhausted'` → 「额度耗尽」分支。
     * 额度不是可观测事实，不该出现在状态说明里；`failureClass=quota`
     * 仍留在 run 记录与派单诊断中。
     *
     * @param {(key: string) => string} t
     * @param {any} role
     */
    function roleReasonOf(t, role) {
      const state = asObject(role?.state)
      if (role?.enabled === false) return t('roleDisabled')
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
     * 现行配置为全局一层；`canRestore` 保留 session 来源判断以兼容旧快照，
     * 但会话级角色覆盖已下线（B3），正常路径下不会为 true。
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

    /** 详情 draft：只包含可编辑字段；初始化自生效角色。
     *  B2（PDF 第 2 条）：单一「角色设定」+ CLI → 模型 → 思考强度；不再有「通道」。
     */
    function draftOfRole(role) {
      const channel = asObject(role?.channel)
      const setting =
        asString(role?.setting) || asString(role?.prompt) || asString(role?.description)
      const kind = asString(channel.kind) || asString(role?.kind)
      return {
        name: asString(role?.name),
        aliases: asArray(role?.aliases).map(String).join(', '),
        setting,
        // B2c：CLI 用 4 个固定 id（旧 channel.kind 映射；未知 kind 不猜，留空由用户重选）
        cli: CLI_BY_CHANNEL_KIND[kind] ?? '',
        model: asString(channel.model) || asString(role?.model),
        reasoning: asString(channel.reasoning) || asString(role?.reasoning),
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

    /** 新建角色的空 draft（B1b）。 */
    function emptyRoleDraft() {
      return { name: '', aliases: '', setting: '', cli: '', model: '', reasoning: '' }
    }

    /**
     * 生成合法 roleId：`role-<slug>`；冲突自动加序号；无可用 ASCII 时 `role-custom`。
     * 纯函数：结果只由 name 与已有 id 决定（无随机数，便于单测与可复现）。
     */
    function generateRoleId(name, existingRoleIds = []) {
      const slug = String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
      const base = slug ? `role-${slug}` : 'role-custom'
      const taken = new Set(asArray(existingRoleIds).map(String))
      if (!taken.has(base)) return base
      let index = 2
      while (taken.has(`${base}-${index}`)) index += 1
      return `${base}-${index}`
    }

    /**
     * 新建全局角色 payload（B1b）：roleId 系统生成 + 名称/简称/设定 + B2 的
     * CLI→模型→强度组合解析；组合不唯一/不支持时返回与编辑保存一致的错误（不伪造 channel）。
     *
     * 2026-11-16（用户裁决）：不校验「profile 里有没有对应实例」——能力目录才是事实来源。
     */
    function buildCreateRolePayload(t, draft, capabilities, channels, existingRoleIds) {
      const name = asString(draft?.name).trim()
      if (!name) return { payload: null, error: t('detailInvalidName') }
      const built = channelForCombo(t, draft, capabilities, channels)
      if (built.error || !built.channel) return { payload: null, error: built.error ?? t('pendingConfig') }
      return {
        payload: {
          roleId: generateRoleId(name, existingRoleIds),
          name,
          aliases: parseAliases(draft?.aliases),
          setting: asString(draft?.setting),
          channel: built.channel,
          enabled: true,
        },
        error: null,
      }
    }

    /** 新建全局角色写入（一次 create；调用方先做二次确认）。 */
    async function saveCreateGlobalRole({ role, createGlobalRole, reload }) {
      const result = await createGlobalRole(role)
      if (!result || result.ok !== true) {
        return { ok: false, error: result?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
      }
      const loaded = await reload()
      if (!loaded || loaded.ok !== true) {
        return { ok: false, error: loaded?.error ?? { code: 'REMOTE_CALL_FAILED', message: '' } }
      }
      return { ok: true, view: loaded.view, value: result.value, roleId: asString(role?.roleId) }
    }

    /** 删除全局角色（一次 delete；调用方先做二次确认）。 */
    async function saveDeleteGlobalRole({ roleId, deleteGlobalRole, reload }) {
      const result = await deleteGlobalRole(roleId)
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
     * B2c：4 CLI 能力目录（唯一能力来源）。优先 `view.capabilities`（侧栏合并）或
     * `view.global.capabilities`（设置页快照）；旧快照缺失时按 channels 兼容推导，
     * 但**永远**补齐 4 个固定 CLI（空目录 = 未知），不再把 ch-* 当 CLI 展示。
     * @param {any} view
     */
    function capabilitiesOf(view) {
      const direct = normalizeCapabilities(view?.capabilities)
      const fromGlobal = normalizeCapabilities(view?.global?.capabilities)
      const list = direct.length > 0 ? direct : fromGlobal.length > 0 ? fromGlobal : []
      /** @type {Map<string, any>} */
      const byId = new Map(list.map((entry) => [entry.id, entry]))
      // 固定 4 个 CLI：缺失项先补空槽位（source=unknown）。
      for (const id of CLI_IDS) {
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            label: id,
            provider: '',
            models: [],
            strengths: [],
            sources: { models: 'unknown', strengths: 'unknown' },
            refreshedAt: null,
            errors: [],
          })
        }
      }
      // B3（Lead 批准的 B 方案）：把 global.channels 的真实声明并入能力目录。
      // 优先级 discovered > config > static > unknown —— config 是本机真实配置，高于静态表。
      const detailed = asArray(view?.global?.channels)
      const channels = detailed.length > 0 ? detailed : asArray(view?.channels)
      for (const channel of channels) {
        const id = CLI_BY_CHANNEL_KIND[asString(channel?.kind)]
        if (!id) continue
        const entry = byId.get(id)
        const model = asString(channel?.model)
        const reasoning = asString(channel?.reasoning)
        const provider = asString(channel?.provider)
        if (!entry.provider && provider) entry.provider = provider
        if (model) {
          const existing = entry.models.find((item) => item.id === model)
          if (!existing) {
            entry.models.push({ id: model, label: model, provider, source: 'config' })
          } else if (existing.source !== 'discovered') {
            existing.source = 'config'
            if (provider) existing.provider = provider
          }
          entry.sources.models = higherCapabilitySource(entry.sources.models, 'config')
        }
        if (reasoning) {
          const existing = entry.strengths.find((item) => item.id === reasoning)
          if (!existing) entry.strengths.push({ id: reasoning, label: reasoning, source: 'config' })
          else if (existing.source !== 'discovered') existing.source = 'config'
          entry.sources.strengths = higherCapabilitySource(entry.sources.strengths, 'config')
        }
      }
      return CLI_IDS.map((id) => byId.get(id))
    }

    /** 当前 CLI 条目（null = 未知 CLI）。 */
    function cliEntryOf(view, cli) {
      return capabilitiesOf(view).find((item) => item.id === cli) ?? null
    }

    /**
     * 在已配置的通道实例里找「能真正派单」的那一条。
     *
     * 为什么必须精确匹配（2026-11-16 真机缺陷）：
     * - 派单侧 `adapter.start()` 会校验「角色声明的 model/reasoning 必须与所引用实例一致」，
     *   不一致直接抛 `MODEL_UNSUPPORTED`。所以只要实例的 model/reasoning 和角色声明分叉，
     *   这个角色就永远派不出去。
     * - 早期这里是**宽松匹配**（实例没声明 model 就算匹配），结果会写出一个
     *   「保存成功、派单必失败」的角色。
     *
     * 另外：`model` 与 `reasoning` **同时为空**时不替用户挑实例 —— 否则「只改设定」
     * 会把默认角色（`channel: { kind: 'in-process' }`，不声明通道）静默绑到
     * channels 里的第一条，既违背默认角色「不绑定通道」的设计，也等于偷偷改了执行路径。
     *
     * @param {{ kind: string, provider: string, model: string, reasoning: string }} combo
     * @param {any[]} channels
     * @returns {any | null}
     */
    function matchChannelInstance(combo, channels) {
      const { kind, provider, model, reasoning } = combo
      if (!model && !reasoning) return null
      const candidates = asArray(channels).filter(
        (item) =>
          asString(item?.kind) === kind &&
          asString(item?.provider) === provider &&
          (!model || asString(item?.model) === model) &&
          (!reasoning || asString(item?.reasoning) === reasoning) &&
          asString(item?.channelId),
      )
      return candidates.length > 0 ? candidates[0] : null
    }

    /**
     * B2c：把 draft 的「CLI + 模型 + 强度」映射成内部 B2 channel 形状
     * `{ kind, provider, model, reasoning, channelId? }`（不伪造；目录里没有的组合拒绝保存）。
     *
     * 找不到对应实例时**仍然返回组合**（不带 channelId），由调用方判断：
     * 编辑页据此给出「该组合在 profile 里没有执行组合」的准确错误，而不是写出半套配置。
     * @returns {{ channel: any | null, error: string | null }}
     */
    function channelForCombo(t, draft, capabilities, channels) {
      const cli = asString(draft?.cli)
      if (!cli) return { channel: null, error: t('pendingConfig') }
      const entry =
        asArray(capabilities).find((item) => item?.id === cli) ?? cliEntryOf({ capabilities }, cli)
      if (!entry) return { channel: null, error: t('pendingConfig') }
      const modelId = asString(draft?.model)
      if (modelId && !asArray(entry.models).some((item) => item.id === modelId)) {
        return { channel: null, error: t('pendingConfig') }
      }
      const strengthId = asString(draft?.reasoning)
      if (strengthId && !asArray(entry.strengths).some((item) => item.id === strengthId)) {
        return { channel: null, error: t('pendingConfig') }
      }
      const kind = CHANNEL_KIND_BY_CLI[cli]
      const modelEntry = modelId ? asArray(entry.models).find((item) => item.id === modelId) : null
      const provider = asString(modelEntry?.provider) || asString(entry.provider)
      if (!kind || !provider) return { channel: null, error: t('pendingConfig') }
      const instance = matchChannelInstance(
        { kind, provider, model: modelId, reasoning: strengthId },
        channels,
      )
      // 不声明用户没选的东西：只有「命中实例」或「显式选了模型」时才写 provider。
      // 否则默认角色（channel 只有 kind）保存设定时会被静默加上 provider=spawn，
      // 等于偷偷改写了执行组合声明。
      /** @type {Record<string, string>} */
      const channel = { kind }
      if (instance || modelId) channel.provider = provider
      if (modelId) channel.model = modelId
      if (instance) {
        const instanceId = asString(instance.channelId)
        if (instanceId) channel.channelId = instanceId
        // 强度留空时继承实例声明（派单校验要求两者一致，继承才不会分叉）。
        const instanceReasoning = asString(instance.reasoning)
        if (instanceReasoning) channel.reasoning = instanceReasoning
        else if (strengthId) channel.reasoning = strengthId
        // 模型留空时同样继承实例声明。
        const instanceModel = asString(instance.model)
        if (!channel.model && instanceModel) channel.model = instanceModel
      } else if (strengthId) {
        channel.reasoning = strengthId
      }
      return { channel, error: null }
    }

    /**
     * 详情页的「CLI / 模型 / 思考强度」选项（B2c：来自 4 CLI 能力目录，不伪造）。
     *
     * 2026-11-16（用户裁决）：**不拿 profile 的 channels 判「哪些能选」**。
     * 能力目录来自 CLI/宿主的实时探测，它就是唯一事实来源；profile 里的 channels
     * 只代表「过去配过什么」，不构成合法性白名单。
     * @param {any} view
     * @param {any} role
     * @param {any} draft
     */
    function detailOptionsOf(view, role, draft) {
      const capabilities = capabilitiesOf(view)
      const kind = asString(role?.channel?.kind) || asString(role?.kind)
      const cli = asString(draft?.cli) || CLI_BY_CHANNEL_KIND[kind] || ''
      const entry = capabilities.find((item) => item.id === cli) ?? null
      return {
        capabilities,
        clis: capabilities,
        entry,
        cli,
        models: entry ? entry.models : [],
        strengths: entry ? entry.strengths : [],
        sources: entry ? entry.sources : { models: 'unknown', strengths: 'unknown' },
        refreshedAt: entry ? entry.refreshedAt : null,
      }
    }

    /**
     * 全局 scope 的 patch（一次写入，交给 S2 global writer）。空字符串不写入：
     * 全局层没有「删除字段」语义，Prompt/名称留空视为无效输入。
     * @returns {{ patch: Record<string, any>, error: string | null }}
     */
    function buildGlobalPatch(t, role, draft, capabilities, channels) {
      /** @type {Record<string, any>} */
      const patch = {}
      const name = asString(draft?.name).trim()
      if (!name) return { patch, error: t('detailInvalidName') }
      if (name !== asString(role?.name)) patch.name = name

      const aliases = parseAliases(draft?.aliases)
      if (aliases.join('\u0000') !== asArray(role?.aliases).map(String).join('\u0000')) {
        patch.aliases = aliases
      }
      const setting = asString(draft?.setting)
      const currentSetting =
        asString(role?.setting) || asString(role?.prompt) || asString(role?.description)
      if (setting !== currentSetting) patch.setting = setting

      // B2c：CLI + 模型 + 强度 → 内部 channel。
      const current = asObject(role?.channel)
      const built = channelForCombo(t, draft, capabilities, channels)
      if (built.error || !built.channel) return { patch, error: built.error ?? t('pendingConfig') }
      const target = built.channel

      // 2026-11-16（用户裁决）：**不再拿 profile 的 channels 当白名单**。
      //
      // 用户原话：「你能获取的列表，就一定要让它能配置上去。profile 只能代表之前
      // 用户配置过，不能代表只有这个配置能用」——这是对的：能力目录来自 CLI/宿主的
      // 实时探测，profile 的 channels 只是历史配置残留，不构成「哪些组合合法」的权威。
      //
      // 因此这里只写用户选中的声明（kind/provider/model/reasoning），不再要求它必须
      // 命中某条既有实例。
      //
      // 但有一个**必须**处理的连带问题：全局配置是字段合并、没有删除语义。用户从一个
      // 已绑定实例的组合改到「探测到但没有实例」的组合时，旧 channelId 清不掉，会写出
      // 「channelId=旧实例 + model=新模型」的矛盾组合（派单必失败）。所以这里对
      // 「旧值存在、新值没有」的键写 `null`，由 global-writer 在合并时删除。
      /** @type {Record<string, string | null>} */
      const channelPatch = {}
      for (const key of ['channelId', 'kind', 'provider', 'model', 'reasoning']) {
        const next = asString(target[key])
        const previous = asString(current[key])
        if (next === previous) continue
        if (!next) {
          // 新组合没有这个字段，而旧的有 → 显式清空（null），避免残留造成矛盾组合。
          if (previous) channelPatch[key] = null
          continue
        }
        channelPatch[key] = next
      }
      if (Object.keys(channelPatch).length > 0) patch.channel = channelPatch
      return { patch, error: null }
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

    /** 详情页错误行（完整可读；原始 code 放 title 便于排障）。 */
    function detailErrorLine(t, error) {
      if (!error) return null
      const rawCode = asString(error.code)
      const rawMessage = asString(error.message)
      // 2026-11-12：之前这里是 `${code} ${message}` 原样拼给用户 ——
      // 用户看到的就是 `MEETINGSTONE_GUI_CAPABILITIES_UNAVAILABLE 能力目录未装配`，
      // 或者宿主的 `gateway/internal xxx is not defined`，不知道该干什么。
      // 现在翻成「发生了什么 + 怎么办」；原始 code 仍放在 title 里便于排障。
      const friendly = explainRemoteError(rawCode, rawMessage)
      const text = rawCode && rawCode !== 'gateway/internal' ? `${rawCode} ${friendly}` : friendly
      // 2026-11-16：原来这里 `whiteSpace: nowrap` + 省略号，把「怎么办」那半句直接截掉，
      // 真机截图里用户只看到「…无法在全局层直接切换到没有对应实例的 CLI；…」就没了。
      // 报错的价值全在后半句，改为可换行完整展示。
      return jsx('p', {
        role: 'alert',
        style: {
          ...noteStyle,
          color: 'var(--dsw-alias-state-error-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
        title: `${rawCode} ${rawMessage}`.trim(),
        children: text,
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
     *   showScope?: boolean,
     *   refreshing?: boolean,
     *   onRefreshCapabilities?: Function,
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
      // B1：右侧栏会话面板不再显示 scope 切换（全局编辑只在设置页内联面板）；
      // 设置页内联管理器也用它隐藏切换，避免出现「会话/全局」双入口。
      const showScope = opts.showScope !== false
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
      // B2c：CLI → 模型 → 思考强度（4 CLI 能力目录；来源可观测，不伪造）
      const sourceText = (source) => t(capabilitySourceKey(source))
      const capabilityNote = options.entry
        ? `${t('capabilitySource')}: ${t('sourceModels')}=${sourceText(options.sources.models)} · ${t('sourceStrengths')}=${sourceText(options.sources.strengths)}`
        : t('capabilityUnknown')
      // 来源说明（2026-11-12 用户真机反馈）。
      // 用户以为「刷新能力」能拉出实时模型列表；但 codebuddy / claude
      // 没有可枚举模型的接口，它们的模型只能来自配置或内置清单。
      // 这行说明直接写在来源标记下面，避免误解。
      const capabilitySourceHint = jsx('span', {
        style: { ...noteStyle, fontSize: 11 },
        children: t('capabilitySourceNote'),
      })
      const cliControl =
        options.clis.length === 0
          ? jsx('span', { style: noteStyle, children: t('pendingConfig') })
          : jsxs('select', {
              style: inputStyle,
              value: asString(draft.cli),
              disabled,
              onChange: (event) => {
                onDraft('cli', event?.target?.value ?? '')
                onDraft('model', '')
                onDraft('reasoning', '')
              },
              children: options.clis.map((item) =>
                jsx(
                  'option',
                  { value: item.id, children: item.label || item.id },
                  `cli-${item.id}`,
                ),
              ),
            })
      // 模型：来自能力目录；来源标注（动态/静态/未知），空目录置灰并标「不支持」。
      const modelControl =
        options.models.length === 0
          ? jsx('select', {
              style: { ...inputStyle, color: C.tertiary },
              disabled: true,
              value: '',
              children: jsx('option', {
                value: '',
                children: `${t('unsupported')} · ${t('noModelOptions')}`,
              }),
            })
          : jsxs('select', {
              style: inputStyle,
              value: asString(draft.model),
              disabled,
              onChange: (event) => {
                onDraft('model', event?.target?.value ?? '')
                onDraft('reasoning', '')
              },
              children: [
                jsx('option', { value: '', children: t('fieldUnset') }, 'model-unset'),
                ...options.models.map((item) => {
                  // 上下文窗口（2026-11-13）：有可信值才显示，拿不到就只显示来源。
                  // 用 K 为单位省宽度（1,000,000 → 1M，192,000 → 192K）。
                  const ctx = Number.isFinite(item.contextWindow)
                    ? ` · ${formatContextWindow(item.contextWindow)}`
                    : ''
                  // 2026-11-16（用户裁决）：不再标「未配置」。
                  // 能力目录来自实时探测，它就是可配置的范围；profile 只代表历史配置。
                  //
                  // 2026-11-16 修正：**不做任何「模型可用性验证」**。
                  // 官方 `model/list` 就是「当前客户端+账号的可选模型」权威口径
                  //（文档原话：可用模型取决于客户端和账户，请使用返回值），
                  // 而「列表 ≠ 账号授权」是官方承认的限制，不该由插件假装能判定。
                  // 唯一如实标注的是**额度状态**（免费从 account/rateLimits/read 拿到）：
                  // 额度耗尽是账号级临时状态，不是模型坏了。
                  const rateLimited = item.blocked === 'rate-limit'
                  return jsx(
                    'option',
                    {
                      value: item.id,
                      children:
                        `${item.label || item.id} · ${sourceText(item.source)}${ctx}` +
                        (rateLimited ? ` · ${t('modelRateLimited')}` : ''),
                    },
                    `model-${item.id}`,
                  )
                }),
              ],
            })
      // 思考强度：来自能力目录；空/未知 → 置灰并标「不支持」（不伪造）。
      const reasoningControl =
        options.strengths.length === 0
          ? jsx('select', {
              style: { ...inputStyle, color: C.tertiary },
              disabled: true,
              value: '',
              children: jsx('option', {
                value: '',
                children: `${t('unsupported')} · ${t('noReasoningOptions')}`,
              }),
            })
          : jsxs('select', {
              style: inputStyle,
              value: asString(draft.reasoning),
              disabled,
              onChange: (event) => onDraft('reasoning', event?.target?.value ?? ''),
              children: [
                jsx('option', { value: '', children: t('fieldUnset') }, 'reasoning-unset'),
                ...options.strengths.map((item) => {
                  // 2026-11-16（用户裁决）：同模型——不标「未配置」，探测到的就能选。
                  return jsx(
                    'option',
                    {
                      value: item.id,
                      children: `${item.label || item.id} · ${sourceText(item.source)}`,
                    },
                    `reasoning-${item.id}`,
                  )
                }),
              ],
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
        // B2：单一「角色设定」（原描述 + 角色 Prompt 合并）
        detailField(t, {
          key: 'setting',
          label: t('fieldSetting'),
          source: fieldSourceOf(view, roleId, 'setting'),
          canRestore: canRestore('setting'),
          onRestore: () => onRestore('setting'),
          disabled,
          control: jsx('textarea', {
            style: textareaStyle,
            value: asString(draft.setting),
            disabled,
            onChange: (event) => onDraft('setting', event?.target?.value ?? ''),
          }),
        }),
        // B2：CLI → 模型 → 思考强度（不再出现「通道」用户概念）
        detailField(t, {
          key: 'cli',
          label: t('fieldCli'),
          source: fieldSourceOf(view, roleId, 'channel.kind'),
          canRestore: canRestore('channel.kind'),
          onRestore: () => onRestore('channel.kind'),
          disabled,
          control: cliControl,
          note: capabilityNote,
        }),
        detailField(t, {
          key: 'model',
          label: t('fieldModel'),
          source: fieldSourceOf(view, roleId, 'channel.model'),
          canRestore: canRestore('channel.model'),
          onRestore: () => onRestore('channel.model'),
          disabled,
          control: modelControl,
        }),
        detailField(t, {
          key: 'reasoning',
          label: t('fieldReasoning'),
          source: fieldSourceOf(view, roleId, 'channel.reasoning'),
          canRestore: canRestore('channel.reasoning'),
          onRestore: () => onRestore('channel.reasoning'),
          disabled,
          control: reasoningControl,
        }),
        // 来源说明（2026-11-12 用户真机反馈）。
        // 用户以为「刷新能力」应该拉出实时模型列表，但 codebuddy / claude
        // 没有可枚举模型的接口，模型只能来自配置或内置清单。
        // 把它写在这三个字段下面，用户一眼能看懂「为什么只有这些」。
        jsx('p', { style: { ...noteStyle, fontSize: 11, gridColumn: '1 / -1' }, children: t('capabilitySourceNote') }),
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
              jsx('strong', {
                style: { fontSize: 13, lineHeight: '20px' },
                children: opts.title ? String(opts.title) : role.name || role.roleId,
              }),
              jsx(Tag, { tone: roleColorTone(asObject(role.state).color), children: t('detailTitle') }),
              jsx('span', { style: grow }),
              jsx('button', {
                type: 'button',
                style: linkButton,
                disabled: opts.refreshing === true,
                onClick: opts.onRefreshCapabilities,
                children: opts.refreshing === true ? t('refreshing') : t('refreshCapabilities'),
              }),
            ],
          }),
          showScope
            ? jsxs('div', {
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
              })
            : null,
          // B3/D1 缺陷 2：这两条提示语义不同，不能一起处理。
          // - `scopeGlobalNote`（全局改动需二次确认）与 scope 是否存在无关，始终准确，
          //   保留原有渲染条件（既有测试契约也依赖它）。
          // - `scopeGlobalBlocked`（不能恢复继承）只在**有 scope 切换**时才成立：
          //   设置页内联管理器固定 scope='global' 且 showScope:false，那里既没有
          //   会话层也没有「恢复继承」入口，旧条件只判 scope==='global' 会让它常驻，
          //   是 B3 没清干净的过时提示。
          scope === 'global'
            ? jsxs('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 2 },
                children: [
                  jsx('p', {
                    style: { ...noteStyle, color: 'var(--dsw-alias-state-warn-primary)' },
                    children: t('scopeGlobalNote'),
                  }),
                  showScope ? jsx('p', { style: meta, children: t('scopeGlobalBlocked') }) : null,
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
                  children: disabled
                    ? t('savingDetail')
                    : opts.saveLabel
                      ? String(opts.saveLabel)
                      : t('saveDetail'),
                }),
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
        configActions: makeConfigActions(getService, mountError),
      }
      const mountFailure = mountError ? { code: 'REMOTE_MOUNT_FAILED', message: mountError } : undefined

      // B3：只注册设置页；对话页头「角色」入口与右侧栏「本对话角色」面板已下线。
      guard('section', 'register', () =>
        registerSection(ctx, makeLoader(getService, mountFailure), t, deps.configActions),
      )
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
      renderSection,
      renderGlobalRoleManager,
      renderRoleDetail,
      draftOfRole,
      emptyRoleDraft,
      capabilitiesOf,
      cliEntryOf,
      channelForCombo,
      capabilitySourceKey,
      normalizeCapabilities,
      CLI_IDS,
      generateRoleId,
      buildCreateRolePayload,
      saveCreateGlobalRole,
      saveDeleteGlobalRole,
      detailOptionsOf,
      buildGlobalPatch,
      saveGlobalPatch,
      fieldSourceOf,
      roleReasonOf,
      cliRowsOf,
      CliSwitchRow,
      Tag,
      Switch,
      IconUsers,
      safeRender,
      makeRemoteCall,
      makeConfigActions,
      // 2026-11-12：错误码翻译。用户看到的是人话而不是 raw code。
      explainRemoteError,
      REMOTE_CONTRIBUTION,
      SESSION_TYPES,
      // D1 缺陷 2 护栏：文案断言需要真实字典（而非 t(key) 恒等替身）。
      MESSAGES: { zh, en },
      REMOTE_INJECT,
      PLUGIN_VERSION,
      makeLoader,
    }
    return module.exports
  },
})
