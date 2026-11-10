// @ts-check
/**
 * dsh-meetingstone — 集合石 / MeetingStone
 *
 * 阶段 1/2 交界处的骨架：bundle 可安装、插件可加载、Config 生效、
 * 生命周期可观测且 dispose 幂等。角色解析由 src/roles/registry.js 承担，
 * 派单与 CLI 探测在后续任务接入。
 *
 * 设计约束（来自阶段 0 审计，勿改）：
 * - 不自建任务队列 / 会话 / 数据库（复用 DSH 原生）
 * - 不自研 CLI 启动器（派单经宿主 provider，docs/audit/03-native-capabilities.md）
 * - 任何资源都挂在 ctx.effect() 上，dispose 必须幂等且串行等待
 * - 权限不靠 Prompt：必须显式 sandbox 封装（docs/audit/08-sandbox.md）
 */
import { Config } from './config.js'

export { Config }

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
  const roleCount = Array.isArray(cfg.roles) ? cfg.roles.length : 0
  let loaded = false

  ctx.effect(() => {
    loaded = true
    const line = `[${name}] loaded v${PLUGIN_VERSION} (roles=${roleCount})`
    if (typeof ctx.logger?.info === 'function') {
      ctx.logger.info(line)
    } else {
      console.log(line)
    }

    // 卸载/停用：必须幂等。后续接入子进程与 job 时，这里要 await 全部收尾。
    return () => {
      if (!loaded) return
      loaded = false
      if (typeof ctx.logger?.info === 'function') {
        ctx.logger.info(`[${name}] disposed`)
      } else {
        console.log(`[${name}] disposed`)
      }
    }
  }, `${name}: lifecycle`)
}
