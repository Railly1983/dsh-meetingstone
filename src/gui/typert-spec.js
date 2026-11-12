// @ts-check
/**
 * 配置 Remote 的 strict 契约（Host/Client 共用语义，纯函数，无宿主 import）。
 * B3 起只剩五个配置方法；会话级方法与其 typeSymbol 已整体下线。
 *
 * 事实依据（app.asar，DSH 0.2.2-rc.1）：
 *  - 宿主允许手写 wire schema 经 `ctx.typert.register()` 注册：
 *    `dsh-typert-loader/lib/index.js:27-29`；
 *  - registry 只要求非空 `typeSymbol` + `create()` 函数，不要求生成器：
 *    `dsh-typert-registry/lib/index.js:584-628`；
 *  - Gateway 在边界用 `parameter.codec.create().parse(value)` 做真实校验：
 *    `dsh-api-gateway/lib/index.js:1796-1820`；
 *  - 官方生成物的写法（真实 zod + `createTypertRemoteInfo`）：
 *    `dsh-host-plugin-inventory/lib/typert.host.js:1-4,51-83`。
 *
 * 本文件只产出 spec；`typert.js` 再用宿主的 `createTypertRemoteInfo` 把它变成
 * descriptor。**禁止空壳 create**：这里每个 `create()` 都返回真实 zod schema。
 */

/** Remote 包名（与 package.json 一致）。 */
export const TYPERT_PACKAGE = 'dsh-meetingstone'

/** Host 面。 */
export const TYPERT_FACE = 'host'

/**
 * typeSymbol 契约。Host 与 Client 必须逐字一致；`tests/typert-contract.test.mjs`
 * 与 `tests/gui.test.mjs` 会做双向断言，防止两侧漂移。
 */
export const SESSION_REMOTE_TYPES = Object.freeze({
  roleId: 'dsh-meetingstone/types#RoleId',
  value: 'dsh-meetingstone/types#JsonValue',
  // U2：外部 CLI 开关 / 重新检测 / 全局角色写入。
  cliName: 'dsh-meetingstone/types#CliName',
  booleanValue: 'dsh-meetingstone/types#BooleanValue',
  jsonResult: 'dsh-meetingstone/types#JsonResult',
})

/** 配置方法名（U2：CLI 开关 + 重新检测 + 全局角色写；B1b：新增/删除全局角色）。 */
export const CONFIG_REMOTE_METHODS = Object.freeze([
  'setCliEnabled',
  'refreshCli',
  'updateGlobalRole',
  'createGlobalRole',
  'deleteGlobalRole',
])

/** Host 注册的全部 strict 方法（B3：只剩配置方法；`list` 仍走无参 SRC）。 */
export const GUI_STRICT_METHODS = Object.freeze([...CONFIG_REMOTE_METHODS])

/**
 * 构造一个 strict codec。`build` 必须是返回 zod schema 的工厂。
 * @param {string} typeSymbol
 * @param {() => any} build
 */
function strictCodec(typeSymbol, build) {
  return Object.freeze({
    mode: 'strict',
    typeSymbol,
    create: build,
  })
}

/**
 * 参数 → descriptor 参数。`acceptsUndefined` 只用于可省略参数（clear.field）。
 * @param {{ name: string, wire?: string, typeSymbol: string, build: () => any, acceptsUndefined?: boolean }} input
 */
function parameter(input) {
  return {
    name: input.name,
    wire: input.wire ?? input.name,
    source: 'json',
    ...(input.acceptsUndefined === true ? { acceptsUndefined: true } : {}),
    codec: strictCodec(input.typeSymbol, input.build),
  }
}

/** 结果 codec：strict + 非空 typeSymbol + 真实 zod schema。 */
function result(typeSymbol, build) {
  return {
    mode: 'strict',
    typeSymbol,
    create: build,
  }
}

/**
 * 构造 Host spec。`zod` 是宿主的真实 zod 运行时（由 `typert.js` 注入）。
 *
 * 返回的形状与官方生成物（`typert.host.js`）一致：
 * `{ package, methods: { '<namespace>/<method>': { service, invocation, parameters, result } } }`
 *
 * @param {any} zod
 */
export function createSessionRemoteSpec(zod) {
  if (!zod || typeof zod.string !== 'function' || typeof zod.object !== 'function') {
    throw new TypeError('typert-spec: real zod runtime is required')
  }
  const z = zod

  /** roleId：传输边界只校验非空字符串与长度；路径安全仍由业务层白名单负责。 */
  const roleId = () => z.string().min(1).max(128)
  /** value：任意 JSON；Gateway 在 parse 后还会做 `assertJsonValue`。 */
  const value = () => z.unknown()
  /** cli：只允许已支持的外部 CLI 名（业务层还会再校验一次）。 */
  const cliName = () => z.enum(['codex', 'codebuddy', 'claude'])
  /** force：重新检测是否绕过 probe 缓存。 */
  const booleanValue = () => z.boolean()
  /** 配置写结果：形状由业务层决定，这里只要求是可 JSON 化的任意值。 */
  const jsonResult = () => z.unknown()

  return {
    package: TYPERT_PACKAGE,
    methods: {
      'meetingstone/setCliEnabled': {
        service: 'meetingstone',
        invocation: { kind: 'direct' },
        parameters: [
          parameter({
            name: 'cli',
            typeSymbol: SESSION_REMOTE_TYPES.cliName,
            build: cliName,
          }),
          parameter({
            name: 'enabled',
            typeSymbol: SESSION_REMOTE_TYPES.booleanValue,
            build: booleanValue,
          }),
        ],
        result: result(SESSION_REMOTE_TYPES.jsonResult, jsonResult),
      },
      'meetingstone/refreshCli': {
        service: 'meetingstone',
        invocation: { kind: 'direct' },
        parameters: [
          parameter({
            name: 'cli',
            typeSymbol: SESSION_REMOTE_TYPES.cliName,
            build: cliName,
          }),
          parameter({
            name: 'force',
            typeSymbol: SESSION_REMOTE_TYPES.booleanValue,
            build: booleanValue,
          }),
        ],
        result: result(SESSION_REMOTE_TYPES.jsonResult, jsonResult),
      },
      'meetingstone/updateGlobalRole': {
        service: 'meetingstone',
        invocation: { kind: 'direct' },
        parameters: [
          parameter({
            name: 'roleId',
            typeSymbol: SESSION_REMOTE_TYPES.roleId,
            build: roleId,
          }),
          parameter({
            name: 'patch',
            typeSymbol: SESSION_REMOTE_TYPES.value,
            build: value,
          }),
        ],
        result: result(SESSION_REMOTE_TYPES.jsonResult, jsonResult),
      },
      'meetingstone/createGlobalRole': {
        service: 'meetingstone',
        invocation: { kind: 'direct' },
        parameters: [
          parameter({
            name: 'role',
            typeSymbol: SESSION_REMOTE_TYPES.value,
            build: value,
          }),
        ],
        result: result(SESSION_REMOTE_TYPES.jsonResult, jsonResult),
      },
      'meetingstone/deleteGlobalRole': {
        service: 'meetingstone',
        invocation: { kind: 'direct' },
        parameters: [
          parameter({
            name: 'roleId',
            typeSymbol: SESSION_REMOTE_TYPES.roleId,
            build: roleId,
          }),
        ],
        result: result(SESSION_REMOTE_TYPES.jsonResult, jsonResult),
      },
    },
  }
}

/**
 * 自检：descriptor 的参数/结果必须是 strict 且带非空 typeSymbol 与真实 create。
 * 在注册前调用，任何一条不满足就抛错（不允许静默退回 src-json）。
 *
 * @param {any[]} descriptors
 * @returns {true}
 */
export function assertStrictDescriptors(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new TypeError('typert-spec: descriptors must be a non-empty array')
  }
  /** @param {any} codec @param {string} subject */
  const check = (codec, subject) => {
    if (!codec || codec.mode !== 'strict') {
      throw new TypeError(`typert-spec: ${subject} must be mode "strict"`)
    }
    if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
      throw new TypeError(`typert-spec: ${subject} must have a non-empty typeSymbol`)
    }
    if (typeof codec.create !== 'function') {
      throw new TypeError(`typert-spec: ${subject} must have a create() factory`)
    }
    const schema = codec.create()
    if (!schema || typeof schema.parse !== 'function') {
      throw new TypeError(`typert-spec: ${subject} create() must return a real zod schema`)
    }
  }
  for (const descriptor of descriptors) {
    const id = typeof descriptor?.id === 'string' ? descriptor.id : '<unknown>'
    check(descriptor?.result, `${id} result`)
    const parameters = Array.isArray(descriptor?.parameters) ? descriptor.parameters : []
    if (parameters.length === 0) throw new TypeError(`typert-spec: ${id} must declare parameters`)
    for (const item of parameters) {
      check(item?.codec, `${id} parameter ${JSON.stringify(item?.name ?? item?.wire)}`)
    }
  }
  return true
}
