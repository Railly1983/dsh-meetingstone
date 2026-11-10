// @ts-check
/**
 * 项目配置的读取与缓存（`.meetingstone.json`）。
 *
 * 边界：
 * - IO 全部通过注入的 `readFile` / `statFile`，便于单测（不碰真实磁盘）
 * - **永不抛异常**：读不到、坏 JSON、版本不认识，都降级为空配置 + errors
 * - 只读**项目根下的那一个文件**，不做目录遍历
 *
 * 缓存策略（docs/audit/07-config-extension.md §5.1 的建议）：
 * 用 mtime+size 做签名，文件没变就复用解析结果；另设 TTL 兜底（应对 mtime 精度问题）。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PROJECT_CONFIG_FILENAME, emptyProjectConfig, parseProjectConfig } from './config-file.js'

/** 默认 TTL：5 秒（用户改完配置文件后不必等太久）。 */
export const DEFAULT_TTL_MS = 5000

/**
 * @typedef {object} ProjectConfigResult
 * @property {import('./config-file.js').ProjectConfig} config
 * @property {import('./config-file.js').ProjectConfigError[]} errors
 * @property {string | null} path
 * @property {boolean} exists
 */

/**
 * @param {{
 *   readFile: (path: string) => string,
 *   statFile: (path: string) => { mtimeMs: number, size: number },
 *   now?: () => number,
 *   ttlMs?: number,
 * }} deps
 */
export function createProjectConfigStore(deps) {
  const readFile = deps.readFile
  const statFile = deps.statFile
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS

  /** @type {Map<string, { signature: string | null, at: number, value: ProjectConfigResult }>} */
  const cache = new Map()

  /** @param {string} path */
  function signatureOf(path) {
    try {
      const st = statFile(path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /**
   * 读某个项目根的配置。
   * @param {string | null | undefined} projectRoot
   * @param {string} [fileName]
   * @returns {ProjectConfigResult}
   */
  function get(projectRoot, fileName = PROJECT_CONFIG_FILENAME) {
    if (!projectRoot || typeof projectRoot !== 'string') {
      return {
        config: emptyProjectConfig(),
        errors: [
          {
            code: 'PROJECT_ROOT_UNKNOWN',
            message: '无法确定项目根目录，已跳过项目级配置（仅使用全局角色表）',
          },
        ],
        path: null,
        exists: false,
      }
    }

    const path = join(projectRoot, fileName)
    const signature = signatureOf(path)
    const cached = cache.get(path)
    if (cached && cached.signature === signature && now() - cached.at < ttlMs) {
      return cached.value
    }

    /** @type {ProjectConfigResult} */
    let value
    if (signature === null) {
      // 文件不存在：这是正常情况，不算错误
      value = { config: emptyProjectConfig(), errors: [], path, exists: false }
    } else {
      try {
        const text = readFile(path)
        const parsed = parseProjectConfig(text)
        value = { ...parsed, path, exists: true }
      } catch (err) {
        value = {
          config: emptyProjectConfig(),
          errors: [
            {
              code: 'PROJECT_CONFIG_READ_FAILED',
              message: `读取项目配置失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          path,
          exists: true,
        }
      }
    }

    cache.set(path, { signature, at: now(), value })
    return value
  }

  /** 清缓存（改完配置想立刻生效时用）。 */
  function invalidate(path) {
    if (path) cache.delete(path)
    else cache.clear()
  }

  return { get, invalidate, size: () => cache.size }
}

/**
 * 生产环境用的 store（真读磁盘）。
 */
export function createNodeProjectConfigStore() {
  return createProjectConfigStore({
    readFile: (path) => readFileSync(path, 'utf8'),
    statFile: (path) => {
      const st = statSync(path)
      return { mtimeMs: st.mtimeMs, size: st.size }
    },
  })
}
