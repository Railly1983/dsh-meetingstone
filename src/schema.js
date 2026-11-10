// @ts-check
/**
 * 极简字段校验（零依赖）。
 *
 * 为什么不用 Schemastery（2026-11-10 决定）：
 * 为了一个配置校验引入 `@deepseek-ai/schemastery` 的 peer + dev 依赖，代价是
 * - 仓库里多出 node_modules，导致 pnpm 在 profile 里装**别的 provider** 时 EPERM（符号链接权限）
 * - tarball 安装后 peer 解析依赖宿主运行时干预（未验证）
 * - linked 安装带来 junction，递归删除 profile 可能伤到仓库
 * 而插件真正需要的只是「类型 + 默认值 + 枚举 + 必填」。这里用 60 行解决。
 *
 * 语义约定：
 * - 校验失败抛 `ValidationError`（带字段路径）
 * - `simplify` 去掉与默认值相等的字段（保持配置文件紧凑）
 */

export class ValidationError extends Error {
  /** @param {string} message @param {string} [path] */
  constructor(message, path = '') {
    super(path ? `${path}: ${message}` : message)
    this.name = 'ValidationError'
    this.path = path
  }
}

/** @param {unknown} v */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 字段规格工厂。所有字段都支持 `.default()` / `.required()` / `.description()`。
 * @param {'string'|'number'|'boolean'|'object'|'array'|'union'} kind
 * @param {object} [opts]
 */
function field(kind, opts = {}) {
  /** @type {any} */
  const spec = { kind, ...opts }
  spec.default = (/** @type {unknown} */ value) => field(kind, { ...spec, defaultValue: value })
  spec.required = () => field(kind, { ...spec, isRequired: true })
  spec.description = (/** @type {string} */ text) => field(kind, { ...spec, desc: text })
  return spec
}

export const S = {
  /** @param {object} [opts] */
  string: (opts) => field('string', opts),
  /** @param {object} [opts] */
  number: (opts) => field('number', opts),
  /** @param {object} [opts] */
  boolean: (opts) => field('boolean', opts),
  /** @param {string[]} values */
  union: (values) => field('union', { values: [...values] }),
  /** @param {object} fields */
  object: (fields) => field('object', { fields }),
  /** @param {any} inner */
  array: (inner) => field('array', { inner }),
  any: () => field('any'),
}

/**
 * 校验单个值。
 * @param {any} spec
 * @param {unknown} value
 * @param {string} path
 */
function validateValue(spec, value, path) {
  // 允许把「已编译的子 schema」当字段用（如 channel: ChannelSchema）
  if (typeof spec === 'function' && spec.spec) spec = spec.spec

  const missing = value === undefined || value === null
  if (missing) {
    if (spec.isRequired) throw new ValidationError('必填字段缺失', path)
    if ('defaultValue' in spec) return spec.defaultValue
    // 对象/数组缺省时按空值展开，让子字段的默认值生效（与 Schemastery 行为一致）
    if (spec.kind === 'object') return validateObject(spec, {}, path)
    if (spec.kind === 'array') return []
    return undefined
  }

  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string') throw new ValidationError('必须是字符串', path)
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError('必须是有限数字', path)
      }
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw new ValidationError('必须是布尔值', path)
      return value
    case 'union':
      if (!spec.values.includes(value)) {
        throw new ValidationError(`必须是 ${spec.values.join(' | ')} 之一`, path)
      }
      return value
    case 'array': {
      if (!Array.isArray(value)) throw new ValidationError('必须是数组', path)
      return value.map((item, i) => validateValue(spec.inner, item, `${path}[${i}]`))
    }
    case 'object': {
      if (!isPlainObject(value)) throw new ValidationError('必须是对象', path)
      return validateObject(spec, /** @type {Record<string, unknown>} */ (value), path)
    }
    case 'any':
      return value
    default:
      return value
  }
}

/**
 * 校验对象：**忽略未知字段**（向前兼容），已知字段逐个校验。
 * @param {any} spec
 * @param {Record<string, unknown>} input
 * @param {string} path
 */
function validateObject(spec, input, path) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, fieldSpec] of Object.entries(spec.fields)) {
    const value = validateValue(fieldSpec, input[key], path ? `${path}.${key}` : key)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 把字段规格编译成可调用的校验函数（保持与 Schemastery 相近的调用方式）。
 * @param {any} spec
 */
export function compile(spec) {
  /** @type {any} */
  const fn = (value) => validateValue(spec, value, '')
  fn.spec = spec
  /** 去掉与默认值相等的字段（保持持久化紧凑）。 */
  fn.simplify = (value) => simplifyObject(spec, value, '')
  return fn
}

/**
 * @param {any} spec
 * @param {unknown} value
 * @param {string} path
 */
function simplifyObject(spec, value, path) {
  if (typeof spec === 'function' && spec.spec) spec = spec.spec
  if (spec.kind !== 'object' || !isPlainObject(value)) return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, fieldSpec] of Object.entries(spec.fields)) {
    const current = /** @type {Record<string, unknown>} */ (value)[key]
    if (current === undefined) continue
    if ('defaultValue' in fieldSpec && JSON.stringify(current) === JSON.stringify(fieldSpec.defaultValue)) {
      continue
    }
    if (fieldSpec.kind === 'object') {
      const nested = simplifyObject(fieldSpec, current, path ? `${path}.${key}` : key)
      if (isPlainObject(nested) && Object.keys(nested).length === 0) continue
      out[key] = nested
      continue
    }
    if (fieldSpec.kind === 'array') {
      const inner = fieldSpec.inner
      if (inner?.kind === 'object') {
        out[key] = /** @type {unknown[]} */ (current).map((item) => simplifyObject(inner, item, key))
        continue
      }
    }
    out[key] = current
  }
  return out
}
