// @ts-check
/**
 * dsh-meetingstone — 集合石 / MeetingStone
 *
 * 入口：装配「配置 → 角色注册表 → 派单器 → 工具」，其余全部复用 DSH 原生。
 *
 * 设计约束（来自阶段 0 审计，勿改）：
 * - 不自建任务队列 / 会话 / 数据库（复用 DSH 原生）
 * - 不自研 CLI 启动器（派单经宿主 provider，docs/audit/03-native-capabilities.md）
 * - 任何资源都挂在 ctx.effect() 上，dispose 必须幂等且串行等待
 * - 权限不靠 Prompt：适配器拿不到强制手段时如实标 `readOnlyEnforced:false`（08-sandbox §8）
 */
import { Config } from './config.js'
import { createRegistry } from './roles/registry.js'
import { createDispatcher } from './dispatch/dispatcher.js'
import { createProbe } from './cli/probe.js'
import { createDefaultResolvers, runCommand } from './cli/resolvers.js'
import { createDshAdapter } from './dsh/adapter.js'
import { inject as toolsInject, registerTools } from './dsh/register.js'
import { createRequire } from 'node:module'
import { toRegistryInput } from './project/config-file.js'
import { createNodeProjectConfigStore } from './project/load.js'

/**
 * 宿主运行时把 `@deepseek-ai/dsh-tools` 作为 shared package 提供。
 * `defineTool` 会把「字段 spec 字典」编译成模型可见的 JSON Schema，并在
 * execute 前校验 args；缺了它，`ctx.tools.register` 收到的是未编译的字典，
 * 其中 `readOnly` 会被当成 JSON Schema 的保留注解（要求 boolean），
 * DeepSeek API 直接返回 `Invalid schema for function ... is not of type "boolean"`。
 *
 * 本地单测环境只装了 schemastery，故用同步探测 + 容错：拿不到宿主包时
 * 由 register.js 走等价的本地编译（见该文件 compileToolSpec），绝不降级为
 * 「原样注册」。刻意不用顶层 await 动态 import——插件可能被宿主以同步
 * require(ESM) 方式加载，含 TLA 的模块会抛 ERR_REQUIRE_ASYNC_MODULE。
 * 本地编译路径只保证 schema 合法，不含运行时 args 校验。
 */
const require = createRequire(import.meta.url)
let hostDefineTool
try {
  ({ defineTool: hostDefineTool } = require('@deepseek-ai/dsh-tools'))
} catch {
  hostDefineTool = undefined
}

/**
 * 注意：这里**不导出** `Config`。
 *
 * 原因（2026-11-10 真机定位）：宿主的 profile loader 会对插件导出的 `Config`
 * 做 Schemastery → JSON Schema 的静态投影（`dsh-app-boot` 里的 `validator.validate`），
 * 我们的零依赖 schema 不具备那套结构，导致 profile 启动时该行直接
 * `fiberPhase: failed`（diagnostic: "Cannot read properties of undefined (reading 'validate')"），
 * 插件整个不加载、工具全部消失。
 *
 * 因此配置由 `apply()` 内部校验，宿主侧不再参与投影。
 * 代价：没有自动生成的设置表单（第一版本来就不做 UI）。
 */
// 需要的宿主服务：
// - tools：工具注册（dsh-tools 的 defineTool 走这一层）
// - subagents：派单通道与可用性查询（Cordis 里不声明就访问会抛 "cannot get property ... without inject"）
export const inject = [...toolsInject, 'subagents']

/** 插件名，同时作为 Loader 行 id 的默认值。 */
export const name = 'meetingstone'

/** 包名，与 package.json 的 name 一致（补丁按包名解析入口）。 */
export const PACKAGE_NAME = 'dsh-meetingstone'

export const PLUGIN_VERSION = '0.0.2'

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 原始配置（宿主不再按导出的 schema 校验，见上方说明）
 */
export function apply(ctx, config = {}) {
  // 配置校验在这里做。**坏配置不能拖垮整个插件**：记一条告警、回落到默认值，
  // 让工具仍然可用（角色表为空时 list_roles 会如实返回空，而不是插件消失）。
  let cfg
  try {
    cfg = Config(/** @type {any} */ (config) ?? {})
  } catch (err) {
    cfg = Config({})
    const line = `[${name}] config invalid, falling back to defaults: ${
      err instanceof Error ? err.message : String(err)
    }`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
    else console.warn(line)
  }

  // 角色来源：全局配置 + 当前会话项目根的 `.meetingstone.json`（按 mtime 缓存）
  const projectStore = createNodeProjectConfigStore()

  /** @type {import('./roles/registry.js').RoleRegistry} */
  const globalRegistry = createRegistry({ globalRoles: cfg.roles ?? [] })

  /**
   * 按当前执行上下文构造项目级注册表。
   * 项目根取 `exec.agent.session.header.cwd`（docs/audit/07-config-extension.md §4.2）。
   * @param {any} exec
   */
  async function resolveRegistry(exec) {
    const projectRoot = exec?.agent?.session?.header?.cwd
    const loaded = projectStore.get(projectRoot, cfg.projectConfigFile)
    const registry = createRegistry(toRegistryInput(cfg, loaded.config))
    // 项目文件解析错误 + 注册表语义错误（别名冲突、权限放宽等）一起交给工具层展示
    return { registry, projectErrors: [...(loaded.errors ?? []), ...(registry.errors ?? [])] }
  }

  // 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录）
  const probe = createProbe({
    resolvers: createDefaultResolvers({ run: runCommand }),
    runner: runCommand,
  })

  // parent 由每次工具执行的 context.agent 传入（不再用全局 holder）
  // 通道实例表承载模型/强度：宿主的启动 spec 不接收这两个字段（DD7 方案 B）
  const adapter = createDshAdapter(ctx, { channels: cfg.channels ?? [] })

  const dispatcher = createDispatcher({
    registry: globalRegistry,
    adapter,
    limits: cfg.limits ?? {},
  })

  let registered = false

  ctx.effect(() => {
    registerTools(ctx, {
      registry: globalRegistry,
      dispatcher,
      probe,
      resolveRegistry,
      ...(typeof hostDefineTool === 'function' ? { defineTool: hostDefineTool } : {}),
    })
    registered = true

    const line = `[${name}] loaded v${PLUGIN_VERSION} (roles=${globalRegistry.list().length})`
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(line)
    else console.log(line)

    // 卸载/停用：幂等。工具与探测缓存由宿主 effect 体系回收，这里只做显式清理。
    return () => {
      if (!registered) return
      registered = false
      probe.invalidate()
      projectStore.invalidate()
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[${name}] disposed`)
      else console.log(`[${name}] disposed`)
    }
  }, `${name}: lifecycle`)
}
