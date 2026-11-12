// @ts-check
/**
 * CLI 能力与角色→执行组合解析（B2）。
 *
 * 目标（PDF 第 2 条）：用户只面对「CLI → 模型 → 思考强度」三件事，
 * 不再看到「通道实例」这一内部概念；内部仍由 channels 表承载模型/强度。
 *
 * 边界（勿破坏）：
 * - **不伪造能力**：模型/强度选项只来自已配置的通道实例（`config.channels`）。
 *   实例没声明 reasoning 就标「不支持」，不拿推断填充。
 * - 纯函数：不读文件、不探测宿主、不写配置。
 * - 通道解析失败一律返回明确错误码，由上层决定拒绝方式（失败关闭）。
 *
 * @typedef {'in-process' | 'acp-cli' | 'codex' | 'claude-code'} ChannelKind
 */

/** CLI（内部 kind）→ 用户可见名称。 */
export const CLI_LABELS = Object.freeze({
  'in-process': 'DSH 原生',
  'acp-cli': 'CodeBuddy（ACP）',
  codex: 'Codex',
  'claude-code': 'Claude Code',
})

/** 解析错误码（稳定字符串，供 UI/测试断言）。 */
export const RESOLVE_ERRORS = Object.freeze({
  CHANNEL_NOT_CONFIGURED: 'CHANNEL_NOT_CONFIGURED',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CHANNEL_AMBIGUOUS: 'CHANNEL_AMBIGUOUS',
  CHANNEL_MISMATCH: 'CHANNEL_MISMATCH',
  MODEL_UNSUPPORTED: 'MODEL_UNSUPPORTED',
  REASONING_UNSUPPORTED: 'REASONING_UNSUPPORTED',
})

/** @param {unknown} value @returns {string} */
function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把通道实例表聚合成「CLI → 模型 → 强度」能力矩阵。
 *
 * @param {any[]} channels
 * @returns {Array<{
 *   cli: string, label: string,
 *   models: Array<{ model: string, efforts: string[], channelIds: string[] }>,
 *   efforts: string[],
 *   reasoningSupported: boolean,
 * }>}
 */
export function buildCliCapabilities(channels = []) {
  /** @type {Map<string, { cli: string, label: string, models: Map<string, { efforts: Set<string>, channelIds: string[] }>, efforts: Set<string> }>} */
  const byCli = new Map()
  for (const channel of Array.isArray(channels) ? channels : []) {
    if (!channel || typeof channel !== 'object') continue
    const cli = asString(channel.kind)
    if (!cli) continue
    let row = byCli.get(cli)
    if (!row) {
      row = { cli, label: /** @type {Record<string, string>} */ (CLI_LABELS)[cli] ?? cli, models: new Map(), efforts: new Set() }
      byCli.set(cli, row)
    }
    const model = asString(channel.model)
    const reasoning = asString(channel.reasoning)
    if (reasoning) row.efforts.add(reasoning)
    const modelKey = model || '(未声明模型)'
    let entry = row.models.get(modelKey)
    if (!entry) {
      entry = { efforts: new Set(), channelIds: [] }
      row.models.set(modelKey, entry)
    }
    if (asString(channel.channelId)) entry.channelIds.push(asString(channel.channelId))
    if (reasoning) entry.efforts.add(reasoning)
  }
  return [...byCli.values()].map((row) => {
    const models = [...row.models.entries()]
      .filter(([model]) => model !== '(未声明模型)')
      .map(([model, entry]) => ({
        model,
        efforts: [...entry.efforts],
        channelIds: [...entry.channelIds],
      }))
    const efforts = [...row.efforts]
    return {
      cli: row.cli,
      label: row.label,
      models,
      efforts,
      // 有实例但都没声明 reasoning → UI 显示「不支持」，不隐藏
      reasoningSupported: efforts.length > 0,
    }
  })
}

/**
 * 某 CLI 可选的模型（只来自已配置实例）。
 * @param {string} cli
 * @param {any[]} channels
 * @returns {string[]}
 */
export function modelOptionsFor(cli, channels = []) {
  const row = buildCliCapabilities(channels).find((item) => item.cli === cli)
  return row ? row.models.map((item) => item.model) : []
}

/**
 * 某 CLI（+模型）可选的思考强度。
 * @param {string} cli
 * @param {string | null | undefined} model
 * @param {any[]} channels
 * @returns {{ efforts: string[], supported: boolean }}
 */
export function effortOptionsFor(cli, model, channels = []) {
  const row = buildCliCapabilities(channels).find((item) => item.cli === cli)
  if (!row) return { efforts: [], supported: false }
  const wanted = asString(model)
  const models = wanted ? row.models.filter((item) => item.model === wanted) : row.models
  const efforts = [...new Set(models.flatMap((item) => item.efforts))]
  return { efforts, supported: efforts.length > 0 }
}

/**
 * 把角色的「CLI + 模型 + 强度」解析成一条具体通道实例。
 *
 * 规则（失败关闭）：
 * - 有 `channelId`：实例必须存在，且声明的 provider/kind/model/reasoning 必须与实例一致；
 * - 无 `channelId`：按 kind（+model+reasoning）在实例表里找**唯一**匹配项；
 *   找不到/多义都返回明确错误码，不猜。
 *
 * @param {any} role
 * @param {any[]} channels
 * @returns {{ channel: any | null, error: { code: string, message: string } | null }}
 */
export function resolveRoleChannel(role, channels = []) {
  const declared = role && typeof role === 'object' && role.channel && typeof role.channel === 'object' ? role.channel : {}
  const list = Array.isArray(channels) ? channels.filter((item) => item && typeof item === 'object') : []
  const declaredChannelId = asString(declared.channelId)

  if (declaredChannelId) {
    const instance = list.find((item) => asString(item.channelId) === declaredChannelId)
    if (!instance) {
      return {
        channel: null,
        error: {
          code: RESOLVE_ERRORS.CHANNEL_NOT_FOUND,
          message: `角色引用的执行组合 ${declaredChannelId} 不存在，请在设置里重新选择 CLI/模型/强度`,
        },
      }
    }
    const instanceKind = asString(instance.kind)
    if (asString(declared.kind) && instanceKind && asString(declared.kind) !== instanceKind) {
      return {
        channel: null,
        error: {
          code: RESOLVE_ERRORS.CHANNEL_MISMATCH,
          message: `角色声明的 CLI ${declared.kind} 与已配置组合 ${declaredChannelId} 的 ${instanceKind} 不一致，已拒绝`,
        },
      }
    }
    for (const key of /** @type {const} */ (['model', 'reasoning'])) {
      const expected = asString(declared[key])
      const actual = asString(instance[key])
      if (expected && actual && expected !== actual) {
        return {
          channel: null,
          error: {
            // 与既有适配器错误码保持一致：模型/强度不一致 → MODEL_UNSUPPORTED
            code: RESOLVE_ERRORS.MODEL_UNSUPPORTED,
            message: `角色声明 ${key}=${expected}，但已配置组合 ${declaredChannelId} 的是 ${actual}；两者必须一致`,
          },
        }
      }
    }
    return { channel: { ...declared, ...instance, channelId: declaredChannelId }, error: null }
  }

  const kind = asString(declared.kind)
  const model = asString(declared.model)
  const reasoning = asString(declared.reasoning)
  if (!kind) {
    return {
      channel: null,
      error: {
        code: RESOLVE_ERRORS.CHANNEL_NOT_CONFIGURED,
        message: '角色还没有选择 CLI，请先在设置里选择 CLI/模型/强度',
      },
    }
  }
  const sameCli = list.filter((item) => asString(item.kind) === kind)
  if (sameCli.length === 0) {
    return {
      channel: null,
      error: {
        code: RESOLVE_ERRORS.CHANNEL_NOT_CONFIGURED,
        message: `还没有为 ${/** @type {Record<string, string>} */ (CLI_LABELS)[kind] ?? kind} 配置执行组合（模型/强度），请先在设置里配置`,
      },
    }
  }
  // 逐层收窄：CLI → 模型 → 强度；某层收窄到 0 说明该层"不支持"。
  let candidates = sameCli
  if (model) {
    candidates = candidates.filter((item) => asString(item.model) === model)
    if (candidates.length === 0) {
      return {
        channel: null,
        error: {
          code: RESOLVE_ERRORS.MODEL_UNSUPPORTED,
          message: `当前 CLI 没有声明模型 ${model}（可选：${modelOptionsFor(kind, list).join(' / ') || '无'}）`,
        },
      }
    }
  }
  if (reasoning) {
    candidates = candidates.filter((item) => asString(item.reasoning) === reasoning)
    if (candidates.length === 0) {
      return {
        channel: null,
        error: {
          code: RESOLVE_ERRORS.REASONING_UNSUPPORTED,
          message: `当前组合不支持思考强度 ${reasoning}，请改用已支持的强度或留空`,
        },
      }
    }
  }
  if (candidates.length > 1) {
    return {
      channel: null,
      error: {
        code: RESOLVE_ERRORS.CHANNEL_AMBIGUOUS,
        message: `CLI/模型/强度 对应多个已配置组合（${candidates
          .map((item) => asString(item.channelId))
          .filter(Boolean)
          .join(' / ')}），请在设置里明确选择`,
      },
    }
  }
  const instance = candidates[0]
  return { channel: { ...declared, ...instance, channelId: asString(instance.channelId) }, error: null }
}
