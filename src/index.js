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
import { toRegistryInput } from './project/config-file.js'
import { createNodeProjectConfigStore } from './project/load.js'

export { Config }
// 工具注册需要宿主注入 tools 服务（dsh-tools 的 defineTool 走这一层）
export const inject = [...toolsInject]

/** 插件名，同时作为 Loader 行 id 的默认值。 */
export const name = 'meetingstone'

/** 包名，与 package.json 的 name 一致（补丁按包名解析入口）。 */
export const PACKAGE_NAME = 'dsh-meetingstone'

export const PLUGIN_VERSION = '0.0.1'

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 由 Loader 按导出的 `Config` schema 校验后的配置
 */
export function apply(ctx, config = {}) {
  // Loader 通常已校验过；这里再兜一次，避免直接调用时拿到脏值。
  const cfg = Config(/** @type {any} */ (config) ?? {})

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
    registerTools(ctx, { registry: globalRegistry, dispatcher, probe, resolveRegistry })
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
