// @ts-check
/**
 * Host 侧 Typert strict Remote 注册（真实 zod + createTypertRemoteInfo）。
 *
 * 链路（证据见 docs/gui-0.2.0.md §8）：
 *   ctx.inject(['typert']) → ctx.typert.register(manifest)
 *     → dsh-typert-registry 校验 typeSymbol/create 并写入 Host 定义
 *     → dsh-api-gateway 优先使用 Host strict 定义
 *     → 参数在 Gateway 边界用 zod `.parse()` 校验
 *
 * 降级策略：
 * - 拿不到 zod / `@deepseek-ai/dsh-typert-protocol` / `ctx.inject` 时**不注册**
 *   strict 方法，返回 `{ registered:false, reason }`，由入口记一条日志；
 *   已存在的无参 `list`（SRC）不受影响。
 * - 注册失败（如 HMR 重复注册）只记日志，不抛出，不拖垮工具/派单。
 */
import { createRequire } from 'node:module'

import {
  SESSION_REMOTE_TYPES,
  TYPERT_FACE,
  TYPERT_PACKAGE,
  assertStrictDescriptors,
  createSessionRemoteSpec,
} from './typert-spec.js'

const require = createRequire(import.meta.url)

/**
 * 读取宿主 zod。优先直接解析；拿不到时从 typert-protocol 的依赖里解析
 * （该包声明 `zod` 为 dependencies，官方生成物也这么做）。
 * @returns {any}
 */
export function loadHostZod() {
  try {
    return require('zod')
  } catch {
    /* 继续尝试协议包依赖 */
  }
  try {
    const protocolRequire = createRequire(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'))
    return protocolRequire('zod')
  } catch {
    return null
  }
}

/**
 * 读取宿主的 `createTypertRemoteInfo`。桌面运行时 Node 24 支持 require(ESM)；
 * 本地 Node 20 测试通过注入真实实现来覆盖。
 * @returns {((spec: any, zod: any) => any) | null}
 */
export function loadCreateTypertRemoteInfo() {
  try {
    const mod = require('@deepseek-ai/dsh-typert-protocol/remote-info')
    const create = mod?.createTypertRemoteInfo ?? mod?.default?.createTypertRemoteInfo
    return typeof create === 'function' ? create : null
  } catch {
    return null
  }
}

/**
 * 构造可交给 `ctx.typert.register()` 的 Host manifest。
 *
 * @param {{ zod: any, createInfo: (spec: any, zod: any) => any }} deps
 * @returns {{ ok: true, manifest: any } | { ok: false, reason: string, error?: string }}
 */
export function buildSessionRemoteManifest({ zod, createInfo }) {
  if (!zod || typeof zod.string !== 'function') {
    return { ok: false, reason: 'ZOD_UNAVAILABLE' }
  }
  if (typeof createInfo !== 'function') {
    return { ok: false, reason: 'TYPERT_PROTOCOL_UNAVAILABLE' }
  }
  try {
    const info = createInfo(createSessionRemoteSpec(zod), zod)
    const invocations = info?.descriptors
    assertStrictDescriptors(invocations)
    return {
      ok: true,
      manifest: {
        package: TYPERT_PACKAGE,
        face: TYPERT_FACE,
        schemas: [],
        invocations,
        // 与官方 `TYPERT` 形状对齐；`ctx.typert.register` 只读 schemas/invocations。
        model: { services: [], events: [], objects: [] },
      },
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'TYPERT_MANIFEST_INVALID',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 在 typert 服务就绪后注册六个 strict Remote（会话 3 + 配置 3）。**永不抛**。
 *
 * @param {any} ctx Host 插件 ctx
 * @param {object} [options]
 * @param {any} [options.zod] 测试注入；生产省略
 * @param {(spec: any, zod: any) => any} [options.createInfo] 测试注入；生产省略
 * @param {(level: string, line: string) => void} [options.log]
 * @returns {{ registered: boolean, deferred?: boolean, reason?: string, error?: string }}
 */
export function registerSessionStrictRemotes(ctx, options = {}) {
  if (!ctx || typeof ctx.inject !== 'function') {
    return { registered: false, reason: 'CTX_INJECT_UNAVAILABLE' }
  }
  const zod = Object.hasOwn(options, 'zod') ? options.zod : loadHostZod()
  const createInfo = Object.hasOwn(options, 'createInfo') ? options.createInfo : loadCreateTypertRemoteInfo()
  const built = buildSessionRemoteManifest({ zod, createInfo })
  if (!built.ok) return { registered: false, reason: built.reason, error: built.error }

  const log = typeof options.log === 'function' ? options.log : null
  let status = { registered: true, deferred: true }

  try {
    ctx.inject(['typert'], (typeCtx) => {
      try {
        // `typert.register()` 的 disposer 属于 registry 自己的 ctx；必须挂到本
        // 子 fiber 的 effect 上，插件卸载/重载时才会正式 withdraw（否则重载会
        // 因 package-face 已注册而失败）。
        typeCtx.effect(() => {
          const dispose = typeCtx.typert.register(built.manifest)
          return () => {
            try {
              return dispose()
            } catch {
              /* 已注销/宿主回收：幂等忽略 */
            }
          }
        }, 'meetingstone: typert strict remotes')
        status = { registered: true }
        log?.(
          'info',
          `[meetingstone] gui module=remote phase=strict status=ok methods=${built.manifest.invocations.length}`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        status = { registered: false, reason: 'TYPERT_REGISTER_FAILED', error: message }
        log?.(
          'error',
          `[meetingstone] gui module=remote phase=strict error=${message}`,
        )
      }
    })
  } catch (error) {
    return {
      registered: false,
      reason: 'TYPERT_INJECT_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return status
}

export { SESSION_REMOTE_TYPES, TYPERT_PACKAGE }
