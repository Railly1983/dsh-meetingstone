// @ts-check
/**
 * 发布门禁 · 宿主 / 模型 API 契约校验（2026-11-10 事故回归）
 *
 * 背景：宿主 `ctx.tools.register()` 只校验 `output.schema`，**不校验 `parameters`**；
 * `schemas()` 投影时也只是把 parameters 深拷贝进 tools 数组。任何一个工具的
 * parameters 不是合法 JSON Schema，DeepSeek 就对整个 tools 数组返回
 * 400 INVALID_REQUEST，profile 下所有会话每一轮都发不出请求。
 *
 * 因此这里用假 ctx 走一遍 apply()，校验**最终注册产物**（真正会被发给 API 的东西），
 * 而不是校验源码长什么样。装进真实 profile 之前必须跑过这一关。
 *
 * 用法：node scripts/verify-host-schema.mjs（失败退出码 1）
 */

import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

/** JSON Schema 的保留注解 / 组合关键字：出现在 parameters 根上即说明字段字典没编译。 */
const RESERVED_ROOT_KEYS = new Set([
  'readOnly', 'writeOnly', 'deprecated', '$schema', '$ref', '$defs', 'definitions',
  'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'not', 'const', 'enum',
  'items', 'pattern', 'format', 'minimum', 'maximum', 'minLength', 'maxLength',
])

/** object 根允许出现的关键字；其余一律视为「字段字典没编译」。 */
const ALLOWED_ROOT_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties',
  'description', 'title', 'default', 'examples',
])

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

/**
 * @param {string} name
 * @param {any} p
 */
function checkParameters(name, p) {
  assert.ok(p && typeof p === 'object' && !Array.isArray(p), `${name}: parameters 必须是对象`)
  for (const key of Object.keys(p)) {
    if (RESERVED_ROOT_KEYS.has(key)) {
      throw new Error(
        `${name}: parameters 根上出现保留关键字 ${key}（字段必须放进 properties；` +
          '否则 DeepSeek 会整包拒掉 tools）',
      )
    }
  }
  assert.equal(
    p.type,
    'object',
    `${name}: parameters 必须是 object 根；未编译的字段字典会把参数名误当 JSON Schema 关键字`,
  )
  assert.ok(
    p.properties && typeof p.properties === 'object' && !Array.isArray(p.properties),
    `${name}: 缺 properties`,
  )
  for (const key of Object.keys(p)) {
    assert.ok(ALLOWED_ROOT_KEYS.has(key), `${name}: parameters 根上出现非法关键字 ${key}`)
  }
  if (p.required !== undefined) {
    assert.ok(
      Array.isArray(p.required) && p.required.every((k) => typeof k === 'string'),
      `${name}: required 必须是字符串数组`,
    )
    for (const k of p.required) {
      assert.ok(Object.hasOwn(p.properties, k), `${name}: required 里的 ${k} 不在 properties 里`)
    }
  }
  for (const [key, node] of Object.entries(p.properties)) {
    assert.ok(VALUE_TYPES.has(node?.type), `${name}.${key}: 非法 type ${String(node?.type)}`)
    assert.ok(
      !Object.hasOwn(node, 'required'),
      `${name}.${key}: required 必须提升到根级 required 数组，不能留在属性里`,
    )
  }
}

/** @param {string} name @param {any} s */
function checkOutputSchema(name, s) {
  assert.ok(s && typeof s === 'object' && !Array.isArray(s), `${name}: output.schema 必须是对象`)
  if (s.type === 'object') {
    assert.equal(
      typeof s.additionalProperties,
      'boolean',
      `${name}: object 输出 schema 必须显式声明 additionalProperties（官方 defineTool 硬性要求）`,
    )
  }
}

// 0) 门禁自检：确认检查器确实能抓到 2026-11-10 的事故模式，别让门禁变成摆设。
assert.throws(
  () =>
    checkParameters('regression-sample', {
      role: { type: 'string', required: true },
      readOnly: { type: 'boolean', description: '只收紧、不放宽' },
    }),
  /保留关键字 readOnly/,
  '门禁自身失效：未能识别未编译的参数字典',
)

// 1) 取最终注册产物。
/** @type {Array<any>} */
const tools = []
const ctx = {
  effect(fn) {
    fn()
  },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => {}
    },
  },
  logger: { info() {} },
}
apply(ctx, {})

assert.equal(tools.length, 6, '工具数量变了，门禁需要同步复核（当前应为 6）')
for (const tool of tools) {
  checkParameters(tool.name, tool.parameters)
  checkOutputSchema(tool.name, tool.output?.schema)
}

// 2) 宿主 projectToolSchema 要求 parameters 是 lossless JSON；不能有函数 / undefined 泄漏。
const wire = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}))
assert.deepEqual(JSON.parse(JSON.stringify(wire)), wire, 'parameters 不是 lossless JSON')

// 3) 事故特异性回归：readOnly 必须在 properties 里，而不是根上。
const dispatch = tools.find((t) => t.name === 'meetingstone_dispatch')
assert.equal(
  dispatch.parameters.properties.readOnly?.type,
  'boolean',
  'meetingstone_dispatch.readOnly 的 boolean 定义丢失',
)

console.log(`PASS: ${tools.length} 个工具的注册产物符合宿主 / 模型 API 契约`)
for (const tool of tools) {
  const args = Object.keys(tool.parameters.properties).join(', ') || '(无参数)'
  console.log(`  ${tool.name}: ${args}`)
}
