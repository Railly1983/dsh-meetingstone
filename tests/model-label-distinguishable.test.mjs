// @ts-check
/**
 * 桥模型的**显示名可区分性**测试。
 *
 * ## 背景（2026-11-13 用户真机反馈）
 *
 * > 「hy4 分为收费和免费两个版本，你这里只有一个名字，用户没法区分。
 * >   free 版要标注区分一下。hy3 也是这样。其他的你也检查下。」
 *
 * 桥上有多组同名模型：
 *
 * | id | name | credits | official |
 * |---|---|---|---|
 * | `hy4free` | Hy4 | **0**（免费） | 官方 |
 * | `hy4std` | Hy4 | **0.29** | 官方 |
 * | `hy3` | Hy3 | 0 | 官方 |
 * | `hy3-x` | Hy3 | **0.05** | 官方 |
 * | `kimi-k3-2` | Kimi-K3 | 1.62 | 官方 |
 * | `kimi-k3-1` | Kimi-K3 | 1.62 | **三方** |
 * | `hy4-preview-*` × 5 | Hy4 preview | 0.29 | 三方 |
 *
 * 直接用 `name` 当下拉标签会出现多条一模一样，用户无法知道哪条免费。
 *
 * ## 本文件守住两条底线
 *
 * 1. **任意两条的显示名必须不同**（可区分）
 * 2. **免费 / 计费信息必须出现**（不能让人误以为免费模型要扣积分，反之亦然）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDefaultProbes } from '../src/cli/capabilities.js'

/**
 * 直接调桥探测（需要本机 WorkBuddy 桥在跑）。
 * 桥不可用时跳过 —— 这不是产品缺陷，是环境依赖。
 */
async function getBridgeModels() {
  const probes = createDefaultProbes({})
  try {
    const models = await probes.dsh({})
    return Array.isArray(models) && models.length > 0 ? models : null
  } catch {
    return null
  }
}

test('桥模型：任意两条显示名不重复（用户能区分）', async (t) => {
  const models = await getBridgeModels()
  if (!models) {
    t.skip('本机 WorkBuddy 桥不可用，跳过')
    return
  }
  /** @type {Map<string, string[]>} */
  const byLabel = new Map()
  for (const m of models) {
    const label = String(m.label ?? m.id)
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label).push(String(m.id))
  }
  /** @type {string[]} */
  const dups = []
  for (const [label, ids] of byLabel) {
    if (ids.length > 1) dups.push(`${label} ← ${ids.join(', ')}`)
  }
  assert.deepEqual(dups, [], `以下显示名重复，用户无法区分：\n  ${dups.join('\n  ')}`)
})

test('桥模型：免费模型必须标注「免费」', async (t) => {
  const models = await getBridgeModels()
  if (!models) {
    t.skip('本机 WorkBuddy 桥不可用，跳过')
    return
  }
  // 已知免费：hy4free / hy3 / hy3-b / hy3-c
  const freeIds = ['hy4free', 'hy3', 'hy3-b', 'hy3-c']
  for (const id of freeIds) {
    const m = models.find((x) => x.id === id)
    if (!m) continue // 账号可能没有这个模型
    assert.match(
      String(m.label),
      /免费/,
      `${id} 是免费模型，标签必须含「免费」，实际：${m.label}`,
    )
  }
})

test('桥模型：收费模型必须显示倍率（不能被误认为免费）', async (t) => {
  const models = await getBridgeModels()
  if (!models) {
    t.skip('本机 WorkBuddy 桥不可用，跳过')
    return
  }
  // 已知收费：hy4std(0.29) / hy3-x(0.05)
  const paid = [
    ['hy4std', '0.29'],
    ['hy3-x', '0.05'],
  ]
  for (const [id, ratio] of paid) {
    const m = models.find((x) => x.id === id)
    if (!m) continue
    assert.match(
      String(m.label),
      new RegExp(`x${ratio.replace('.', '\\.')}`),
      `${id} 是收费模型（x${ratio}），标签必须显示倍率，实际：${m.label}`,
    )
    assert.doesNotMatch(String(m.label), /免费/, `${id} 不该标「免费」`)
  }
})

test('桥模型：同组重名时带 id 区分段', async (t) => {
  const models = await getBridgeModels()
  if (!models) {
    t.skip('本机 WorkBuddy 桥不可用，跳过')
    return
  }
  // hy4free / hy4std 都叫 Hy4 → 必须能区分
  const hy4free = models.find((m) => m.id === 'hy4free')
  const hy4std = models.find((m) => m.id === 'hy4std')
  if (hy4free && hy4std) {
    assert.notEqual(hy4free.label, hy4std.label, 'hy4free 与 hy4std 的显示名必须不同')
    // free 应带 free 段（或至少免费标识），std 应带 std 段
    assert.match(String(hy4free.label), /free|免费/, `hy4free 标签：${hy4free.label}`)
    assert.match(String(hy4std.label), /std/, `hy4std 标签：${hy4std.label}`)
  }
})

test('桥模型：id 保持不变（显示名可改，派单用的 id 不能动）', async (t) => {
  const models = await getBridgeModels()
  if (!models) {
    t.skip('本机 WorkBuddy 桥不可用，跳过')
    return
  }
  // id 里不能混入中文括号/标注
  for (const m of models) {
    assert.doesNotMatch(String(m.id), /[（）()\u4e00-\u9fa5]/, `id 被污染：${m.id}`)
  }
})

test('CodeBuddy 模型：显示名也不重复（同一套区分逻辑）', async (t) => {
  // CodeBuddy 的 ACP 返回同样有重名（hy4free/hy4std 都叫 Hy4）。
  // 它自己不带计费信息，我们从桥补齐。
  const probes = createDefaultProbes({
    resolveExecutable: async (cli) =>
      cli === 'codebuddy' ? 'C:/Users/30673/AppData/Roaming/npm/codebuddy.cmd' : null,
  })
  let models = null
  try {
    models = await probes.codebuddy({})
  } catch {
    models = null
  }
  if (!models || models.length === 0) {
    t.skip('本机 CodeBuddy 不可用，跳过')
    return
  }
  /** @type {Map<string, string[]>} */
  const byLabel = new Map()
  for (const m of models) {
    const label = String(m.label ?? m.id)
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label).push(String(m.id))
  }
  /** @type {string[]} */
  const dups = []
  for (const [label, ids] of byLabel) {
    if (ids.length > 1) dups.push(`${label} ← ${ids.join(', ')}`)
  }
  assert.deepEqual(dups, [], `CodeBuddy 显示名重复：\n  ${dups.join('\n  ')}`)
})
