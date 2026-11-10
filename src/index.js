// @ts-check
/**
 * dsh-meetingstone — 集合石 / MeetingStone
 *
 * 阶段 1 骨架：只验证「bundle 能被安装、插件能被加载、卸载能干净退出」。
 * 角色注册表、CLI 探测、派单编排在阶段 2 加入，见 docs/开发计划.md。
 *
 * 设计约束（全部来自阶段 0 审计，勿改）：
 * - 不自建任务队列 / 会话 / 数据库（复用 DSH 原生）
 * - 不自研 CLI 启动器（派单经宿主 provider，docs/audit/03-native-capabilities.md）
 * - 任何资源都挂在 ctx.effect() 上，dispose 必须幂等且串行等待
 */

/** 插件名，同时作为 Loader 行 id 的默认值。 */
export const name = 'meetingstone'

/** 包名，与 package.json 的 name 一致（补丁按包名解析入口）。 */
export const PACKAGE_NAME = 'dsh-meetingstone'

export const PLUGIN_VERSION = '0.0.1'

/**
 * 插件入口。
 * 阶段 1 只建立可观测的生命周期，不注册工具、不碰配置、不派发任务。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let loaded = false

  ctx.effect(() => {
    loaded = true
    if (typeof ctx.logger?.info === 'function') {
      ctx.logger.info(`[${name}] loaded v${PLUGIN_VERSION}`)
    } else {
      console.log(`[${name}] loaded v${PLUGIN_VERSION}`)
    }

    // 卸载/停用：必须幂等。阶段 2 起，这里要 await 所有子进程与 job 收尾。
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
