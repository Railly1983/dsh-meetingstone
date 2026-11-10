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

  // 角色来源：第一版只有全局配置里的角色表。
  // 项目级 .meetingstone.json 的 IO 接线是下一步（P2-02 剩余部分）。
  const registry = createRegistry({ globalRoles: cfg.roles ?? [] })

  // 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录）
  const probe = createProbe({
    resolvers: createDefaultResolvers({ run: runCommand }),
    runner: runCommand,
  })

  /** @type {{ agent: unknown }} 每次工具执行都会被 onExecute 更新为当次 exec.agent */
  const holder = { agent: null }

  const adapter = createDshAdapter(ctx, {
    // startActivation 的 parent 必须来自当前执行上下文；拿不到时适配器会失败关闭
    getParent: () => holder.agent,
  })

  const dispatcher = createDispatcher({
    registry,
    adapter,
    limits: cfg.limits ?? {},
  })

  let registered = false

  ctx.effect(() => {
    registerTools(ctx, {
      registry,
      dispatcher,
      probe,
      onExecute: (exec) => {
        if (exec && typeof exec === 'object' && 'agent' in exec) holder.agent = exec.agent
      },
    })
    registered = true

    const line = `[${name}] loaded v${PLUGIN_VERSION} (roles=${registry.list().length})`
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(line)
    else console.log(line)

    // 卸载/停用：幂等。工具与探测缓存由宿主 effect 体系回收，这里只做显式清理。
    return () => {
      if (!registered) return
      registered = false
      probe.invalidate()
      holder.agent = null
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[${name}] disposed`)
      else console.log(`[${name}] disposed`)
    }
  }, `${name}: lifecycle`)
}
