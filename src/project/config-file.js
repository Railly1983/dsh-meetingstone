// @ts-check
/**
 * 项目级配置（`.meetingstone.json`）的解析与规范化。
 *
 * 边界（勿破坏）：
 * - 纯函数：不读文件、不碰 DSH API；IO 由调用方负责（见 src/project/load.js）
 * - **永不抛异常**：配置是用户手写的，坏文件只能降级 + 报错，不能让派单链路崩
 * - 只回答「项目想覆盖什么」，合并语义交给 roles/registry.js
 *
 * 文件形状（docs/开发计划.md §7.1）：
 * {
 *   "version": 1,
 *   "defaultRoleId": "role-sashi",
 *   "roles": [ ... 项目新增角色 ... ],
 *   "roleOverrides": { "role-sashi": { "model": "..." } },
 *   "dispatchNotes": "...",
 *   "projectRules": ["..."]
 * }
 *
 * 注意：项目级配置**不提供 `limits`**（死配置已移除）。同项目串行开关 `serializeWrites`
 * 只在插件全局配置（src/config.js）里生效；项目文件里写 `limits` 会按未知字段忽略。
 */

export const PROJECT_CONFIG_FILENAME = '.meetingstone.json'

/** 当前支持的 schema 版本。 */
export const PROJECT_CONFIG_VERSION = 1

/** 错误码（全部带中文可读 message，直接可展示）。 */
export const PROJECT_CONFIG_ERRORS = Object.freeze({
  INVALID_JSON: 'PROJECT_CONFIG_INVALID_JSON',
  NOT_OBJECT: 'PROJECT_CONFIG_NOT_OBJECT',
  UNSUPPORTED_VERSION: 'PROJECT_CONFIG_UNSUPPORTED_VERSION',
  BAD_FIELD: 'PROJECT_CONFIG_BAD_FIELD',
})

/**
 * @typedef {object} ProjectConfigError
 * @property {string} code
 * @property {string} message
 * @property {string} [field]
 */

/**
 * @typedef {object} ProjectConfig
 * @property {number} version
 * @property {string | undefined} defaultRoleId
 * @property {object[]} roles
 * @property {Record<string, object>} roleOverrides
 * @property {string} dispatchNotes
 * @property {string[]} projectRules
 */

/** 空配置（文件不存在或不可用时使用）。 */
export function emptyProjectConfig() {
  return /** @type {ProjectConfig} */ ({
    version: PROJECT_CONFIG_VERSION,
    defaultRoleId: undefined,
    roles: [],
    roleOverrides: {},
    dispatchNotes: '',
    projectRules: [],
  })
}

/**
 * 把 JSON 文本解析成配置。
 * @param {string} text
 * @returns {{ config: ProjectConfig, errors: ProjectConfigError[] }}
 */
export function parseProjectConfig(text) {
  /** @type {ProjectConfigError[]} */
  const errors = []

  if (typeof text !== 'string' || text.trim() === '') {
    return { config: emptyProjectConfig(), errors }
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    errors.push({
      code: PROJECT_CONFIG_ERRORS.INVALID_JSON,
      message: `项目配置不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    })
    return { config: emptyProjectConfig(), errors }
  }

  return normalizeProjectConfig(raw)
}

/**
 * 规范化一个已解析的对象。未知字段忽略（向前兼容），已知字段类型不对则降级并报错。
 * @param {unknown} raw
 * @returns {{ config: ProjectConfig, errors: ProjectConfigError[] }}
 */
export function normalizeProjectConfig(raw) {
  /** @type {ProjectConfigError[]} */
  const errors = []
  const config = emptyProjectConfig()

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      code: PROJECT_CONFIG_ERRORS.NOT_OBJECT,
      message: '项目配置必须是 JSON 对象',
    })
    return { config, errors }
  }

  const input = /** @type {Record<string, any>} */ (raw)

  // version
  if (input.version !== undefined) {
    if (input.version !== PROJECT_CONFIG_VERSION) {
      errors.push({
        code: PROJECT_CONFIG_ERRORS.UNSUPPORTED_VERSION,
        field: 'version',
        message: `不支持的项目配置版本 ${JSON.stringify(input.version)}，当前只支持 ${PROJECT_CONFIG_VERSION}`,
      })
      return { config, errors }
    }
    config.version = PROJECT_CONFIG_VERSION
  }

  // defaultRoleId
  if (input.defaultRoleId !== undefined) {
    if (typeof input.defaultRoleId === 'string' && input.defaultRoleId.trim()) {
      config.defaultRoleId = input.defaultRoleId.trim()
    } else {
      errors.push({
        code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
        field: 'defaultRoleId',
        message: 'defaultRoleId 必须是非空字符串，已忽略',
      })
    }
  }

  // roles
  if (input.roles !== undefined) {
    if (Array.isArray(input.roles)) {
      config.roles = input.roles.filter((/** @type {unknown} */ r, /** @type {number} */ i) => {
        if (r && typeof r === 'object' && !Array.isArray(r)) return true
        errors.push({
          code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
          field: `roles[${i}]`,
          message: '角色必须是对象，已跳过该项',
        })
        return false
      })
    } else {
      errors.push({
        code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
        field: 'roles',
        message: 'roles 必须是数组，已忽略',
      })
    }
  }

  // roleOverrides
  if (input.roleOverrides !== undefined) {
    if (input.roleOverrides && typeof input.roleOverrides === 'object' && !Array.isArray(input.roleOverrides)) {
      for (const [roleId, patch] of Object.entries(input.roleOverrides)) {
        if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
          config.roleOverrides[roleId] = patch
        } else {
          errors.push({
            code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
            field: `roleOverrides.${roleId}`,
            message: '角色覆盖必须是对象，已跳过该项',
          })
        }
      }
    } else {
      errors.push({
        code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
        field: 'roleOverrides',
        message: 'roleOverrides 必须是对象，已忽略',
      })
    }
  }

  // dispatchNotes / projectRules
  if (input.dispatchNotes !== undefined) {
    if (typeof input.dispatchNotes === 'string') {
      config.dispatchNotes = input.dispatchNotes
    } else {
      errors.push({
        code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
        field: 'dispatchNotes',
        message: 'dispatchNotes 必须是字符串，已忽略',
      })
    }
  }

  if (input.projectRules !== undefined) {
    if (Array.isArray(input.projectRules)) {
      config.projectRules = input.projectRules.filter((/** @type {unknown} */ r) => typeof r === 'string')
      if (config.projectRules.length !== input.projectRules.length) {
        errors.push({
          code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
          field: 'projectRules',
          message: 'projectRules 里非字符串项已丢弃',
        })
      }
    } else {
      errors.push({
        code: PROJECT_CONFIG_ERRORS.BAD_FIELD,
        field: 'projectRules',
        message: 'projectRules 必须是字符串数组，已忽略',
      })
    }
  }

  return { config, errors }
}

/**
 * 把「全局插件配置 + 项目配置」摊平成注册表的入参。
 * 只做搬移与默认值，不做合并语义（那是 registry 的职责）。
 *
 * @param {{ roles?: object[] } | undefined} globalConfig
 * @param {ProjectConfig | undefined} projectConfig
 * @returns {{ globalRoles: object[], projectRoles: object[], projectOverrides: Record<string, object> }}
 */
export function toRegistryInput(globalConfig, projectConfig) {
  return {
    globalRoles: Array.isArray(globalConfig?.roles) ? /** @type {object[]} */ (globalConfig.roles) : [],
    projectRoles: Array.isArray(projectConfig?.roles) ? projectConfig.roles : [],
    projectOverrides:
      projectConfig && projectConfig.roleOverrides && typeof projectConfig.roleOverrides === 'object'
        ? projectConfig.roleOverrides
        : {},
  }
}
