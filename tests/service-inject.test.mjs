// @ts-check
/**
 * 回归测试：Cordis 的「未 inject 访问就抛」语义。
 *
 * 事故背景（2026-11-10 真机暴露，单测当时全绿）：
 * 插件只声明了 `inject = ['tools']`，却在三处访问 `ctx.subagents`。
 * Cordis 里这种访问会直接抛
 *   `cannot get property "subagents" without inject`
 * ——普通假 ctx 是普通对象，随便取属性都不报错，所以假 ctx 测不出来。
 *
 * 这里用 Proxy 复刻宿主行为：**访问未声明的属性一律抛**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject } from '../src/index.js'

/**
 * 复刻 Cordis 语义的假 ctx：声明过的属性可读，其余一律抛。
 * @param {string[]} allowed
 * @param {Record<string, any>} base
 */
function strictCtx(allowed, base) {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop in target) return Reflect.get(target, prop)
      if (allowed.includes(prop)) return undefined
      throw new Error(`cannot get property "${prop}" without inject`)
    },
    has(target, prop) {
      return prop in target || allowed.includes(String(prop))
    },
  })
}

/** 最小可用的 ctx 内容（不包含 subagents，除非 allowed 声明了它）。 */
function makeBase() {
  const tools = []
  return {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    logger: { info() {} },
    effect(fn) {
      fn()
    },
    __tools: tools,
  }
}

test('inject 必须声明 subagents（否则真机会抛）', () => {
  assert.ok(inject.includes('subagents'), 'inject 里缺 subagents 就是 2026-11-10 那个 bug')
  assert.ok(inject.includes('tools'))
})

test('宿主不提供 subagents 时：apply 不崩、list_roles 返回 unknown 而不是抛', async () => {
  const ctx = strictCtx(['tools'], makeBase())
  assert.doesNotThrow(() => apply(ctx, {
    roles: [
      {
        roleId: 'role-a',
        name: 'A',
        aliases: [],
        channel: { kind: 'in-process' },
        permissionPreset: 'read-only',
        enabled: true,
      },
    ],
  }))

  const listTool = ctx.__tools.find((t) => t.name === 'meetingstone_list_roles')
  assert.ok(listTool, '工具应已注册')

  // 关键：即便访问 subagents 会抛，也不能把整个调用炸掉
  const res = await listTool.execute({}, ctx)
  assert.equal(res.roles.length, 1)
  assert.equal(res.roles[0].availability, 'unknown', '拿不到服务时应标 unknown，不能猜')
})

test('宿主不提供 subagents 时：dispatch 返回可诊断错误而不是抛', async () => {
  const ctx = strictCtx(['tools'], makeBase())
  apply(ctx, {
    roles: [
      {
        roleId: 'role-a',
        name: 'A',
        aliases: [],
        channel: { kind: 'in-process' },
        permissionPreset: 'project-write',
        enabled: true,
      },
    ],
  })

  const dispatchTool = ctx.__tools.find((t) => t.name === 'meetingstone_dispatch')
  const res = await dispatchTool.execute({ role: 'A', task: 'x' }, { agent: {} })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'PROVIDER_UNAVAILABLE')
  assert.match(res.message, /无法确认|未注册/)
})

test('安全取服务：getter 抛异常时退化为 unknown，不影响其它能力', async () => {
  const base = makeBase()
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (prop === 'subagents') throw new Error('cannot get property "subagents" without inject')
      if (prop in target) return Reflect.get(target, prop)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })

  apply(ctx, {
    roles: [
      {
        roleId: 'role-a',
        name: 'A',
        aliases: [],
        channel: { kind: 'codex' },
        permissionPreset: 'read-only',
        enabled: true,
      },
    ],
  })
  const listTool = base.__tools.find((t) => t.name === 'meetingstone_list_roles')
  const res = await listTool.execute({}, ctx)
  assert.equal(res.roles[0].availability, 'unknown')
})

test('cli_status 在严格 ctx 下仍然可用（不依赖 subagents）', async () => {
  const ctx = strictCtx(['tools'], makeBase())
  apply(ctx, { roles: [] })
  const cliTool = ctx.__tools.find((t) => t.name === 'meetingstone_cli_status')
  assert.ok(cliTool)
  // 没注入 probe 时应失败关闭，不编造
  const res = await cliTool.execute({})
  assert.ok(res && typeof res === 'object', '应返回对象而不是抛错')
})
