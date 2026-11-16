// @ts-check
/**
 * 角色 → 执行路由的**唯一解析入口**。
 *
 * 为什么单独成模块（2026-11-16 外部审查 F1/F2 修复）：
 * 之前 `resolveRoute` 藏在 dsh/adapter.js 的闭包里，而 `roleAvailability`
 * 用 `providerNameFor(role)` 另算一套。结果：channels 明明把角色映射到
 * codex-b，可用性却查 codex（不存在）→ 报「不可用」却又能派单（F2）。
 *
 * 现在派单、可用性、GUI 三处共用本函数，口径不再分叉。
 *
 * 规则（优先级从高到低）：
 * 1. 角色引用了 channelId 且实例存在 → 用实例（校验声明不自相矛盾）；
 * 2. 没引用 / 实例已不存在 → 在 channels 里按 kind + model + reasoning 匹配：
 *    - 恰好一个 → 用它；多个 → CHANNEL_AMBIGUOUS；没有 → 回退到 role.channel.provider；
 * 3. 都没有 → 抛 CHANNEL_NOT_CONFIGURED。
 *
 * 本模块是纯函数：不访问 ctx、不探测 provider，只做配置层面的解析。
 */
/**
 * `channel.kind` → `ctx.subagents` 上的 provider 名。
 * 与 adapter.js 的 `PROVIDER_BY_KIND` 同源（adapter 从本模块重导出，避免两处漂移）。
 */
export const PROVIDER_BY_KIND = Object.freeze({
  'in-process': 'spawn',
  'acp-cli': 'acp',
  codex: 'codex',
  'claude-code': 'claude-code',
})

/**
 * 解析角色声明的 provider 名（不看 channels，只看角色自身）。
 * 命中 channel.provider 优先，否则按 kind 映射。
 * @param {any} role
 * @returns {string | null}
 */
export function providerNameFor(role) {
  const channel = role && typeof role === 'object' ? role.channel : null
  if (!channel || typeof channel !== 'object') return null
  if (typeof channel.provider === 'string' && channel.provider.trim()) {
    return channel.provider.trim()
  }
  return PROVIDER_BY_KIND[channel.kind] ?? null
}

/**
 * @typedef {{ provider: string | null, instance: any | null, role: any,
 *   source: 'instance' | 'capability' | 'fallback' }} RouteResult
 */

/**
 * 解析角色的实际执行路由。
 *
 * @param {any} role
 * @param {Array<any>} [channels] 插件配置里的通道实例表
 * @returns {RouteResult}
 */
export function resolveRoleRoute(role, channels = []) {
  const list = Array.isArray(channels) ? channels : []
  const byId = new Map()
  for (const instance of list) {
    if (instance && typeof instance.channelId === 'string' && instance.channelId) {
      byId.set(instance.channelId, instance)
    }
  }
  const declaredChannel = role && typeof role === 'object' ? role.channel : null
  const declaredId =
    declaredChannel && typeof declaredChannel.channelId === 'string'
      ? declaredChannel.channelId.trim()
      : ''

  // 1. 角色显式引用实例
  if (declaredId) {
    const instance = byId.get(declaredId)
    if (!instance) {
      const matched = matchByCapability(role, list)
      if (matched) return matched
      const fallback = providerNameFor(role)
      if (fallback) {
        return { provider: fallback, instance: null, role, source: 'fallback' }
      }
      throw new Error(
        `CHANNEL_NOT_FOUND: 角色引用的执行组合 ${declaredId} 已不存在，且没有可匹配的实例或 provider`,
      )
    }
    const instanceProvider =
      typeof instance.provider === 'string' && instance.provider.trim()
        ? instance.provider.trim()
        : PROVIDER_BY_KIND[instance.kind] ?? null
    if (!instanceProvider) {
      throw new Error(
        `CHANNEL_MISMATCH: 执行组合 ${declaredId} 既没声明 provider 也没有已知 kind，拒绝启动`,
      )
    }
    const declaredProvider = declaredChannel?.provider
    if (
      typeof declaredProvider === 'string' &&
      declaredProvider.trim() &&
      declaredProvider.trim() !== instanceProvider
    ) {
      throw new Error(
        `CHANNEL_MISMATCH: 角色声明的 provider 是 ${declaredProvider}，但执行组合 ${declaredId} 实际是 ${instanceProvider}；` +
          '两者必须一致，否则会出现「配置写的是一个组合、实际跑的是另一个」。已拒绝启动',
      )
    }
    // [F1 复核修复] 逐个校验角色声明与实例的「执行事实」字段是否一致。
    // 之前只校验 provider/model，遗漏 kind/reasoning；且合并顺序写反（声明覆盖实例），
    // 导致角色声明 kind=in-process 能覆盖实例 kind=codex，绕过 F1 的模型校验 ——
    // 实际 buildChildAgentOptions 用的是实例 kind=codex（返回 {}），却按 in-process 跳过校验。
    // 规则：声明只要填了就必须与实例一致；实例是执行事实，不能被声明覆盖。
    const instanceKind = typeof instance.kind === 'string' ? instance.kind.trim() : ''
    const declaredKind = typeof declaredChannel?.kind === 'string' ? declaredChannel.kind.trim() : ''
    if (declaredKind && instanceKind && declaredKind !== instanceKind) {
      throw new Error(
        `CHANNEL_MISMATCH: 角色声明的 CLI=${declaredKind}，但执行组合 ${declaredId} 实际是 ${instanceKind}；两者必须一致`,
      )
    }
    for (const key of /** @type {const} */ (['model', 'reasoning'])) {
      const expected = typeof declaredChannel?.[key] === 'string' ? declaredChannel[key].trim() : ''
      const actual = typeof instance[key] === 'string' ? instance[key].trim() : ''
      if (expected && actual && expected !== actual) {
        throw new Error(
          `CHANNEL_MISMATCH: 角色声明 ${key}=${expected}，但执行组合 ${declaredId} 的是 ${actual}；两者必须一致`,
        )
      }
    }
    // 实例在后覆盖声明：实例是真实执行组合，声明里的旧值/歧义值不得顶替它。
    const roleChannel = { ...(declaredChannel ?? {}), ...instance }
    return {
      provider: instanceProvider,
      instance,
      role: { ...role, channel: roleChannel },
      source: 'instance',
    }
  }

  const matched = matchByCapability(role, list)
  if (matched) return matched
  const fallback = providerNameFor(role)
  if (!fallback) {
    throw new Error(
      'CHANNEL_NOT_CONFIGURED: 角色既没有引用执行组合，也没有声明 CLI/provider，无法确定执行通道',
    )
  }
  return { provider: fallback, instance: null, role, source: 'fallback' }
}

/**
 * 在 channels 里按 kind + model + reasoning 找唯一匹配项。
 * @param {any} role
 * @param {Array<any>} list
 * @returns {RouteResult | null}
 */
function matchByCapability(role, list) {
  if (list.length === 0) return null
  const declared = role && typeof role === 'object' ? role.channel : null
  const kind = typeof declared?.kind === 'string' ? declared.kind.trim() : ''
  const model = typeof declared?.model === 'string' ? declared.model.trim() : ''
  const reasoning = typeof declared?.reasoning === 'string' ? declared.reasoning.trim() : ''
  if (!kind) return null

  const candidates = list.filter((instance) => {
    if (!instance || typeof instance !== 'object') return false
    const instanceKind = typeof instance.kind === 'string' ? instance.kind.trim() : ''
    if (instanceKind !== kind) return false
    const instanceModel = typeof instance.model === 'string' ? instance.model.trim() : ''
    if (model && instanceModel && instanceModel !== model) return false
    const instanceReasoning = typeof instance.reasoning === 'string' ? instance.reasoning.trim() : ''
    if (reasoning && instanceReasoning && instanceReasoning !== reasoning) return false
    return true
  })
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    const ids = candidates.map((c) => c.channelId).join(' / ')
    throw new Error(
      `CHANNEL_AMBIGUOUS: kind=${kind} model=${model || '(任意)'} reasoning=${reasoning || '(任意)'} ` +
        `同时匹配到多个执行组合（${ids}），请用 channelId 明确指定`,
    )
  }
  const instance = candidates[0]
  const instanceProvider =
    typeof instance.provider === 'string' && instance.provider.trim()
      ? instance.provider.trim()
      : PROVIDER_BY_KIND[instance.kind] ?? null
  if (!instanceProvider) return null
  // 实例在后覆盖声明（与老版本 resolveRoleChannel 一致）：实例是执行事实。
  return {
    provider: instanceProvider,
    instance,
    role: { ...role, channel: { ...(declared ?? {}), ...instance } },
    source: 'capability',
  }
}
