// dsh-local-llm 面层 keyless 单测：插件名/审批门决策/五实名注册/
// pre-execute 挂载/execute→core 委托（config.impls 测试缝注入，不触网零真文件）。
// 语义核分支覆盖在 core.test.js。

import { describe, expect, test } from 'bun:test'
import { apply, decideLocalLlmGate, name } from './index.js'

const makeCtx = () => {
  const registered = new Map()
  const hooks = new Map()
  return {
    registered,
    hooks,
    tools: { register: (t) => registered.set(t.name, t) },
    on: (event, fn) => hooks.set(event, fn),
  }
}

/** 测试缝 impls：登记表文本可换（null=ENOENT）；fetch 恒 200 空对象 */
const makeImpls = (registry = null) => ({
  readFileImpl: async () => {
    if (registry === null) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    return registry
  },
  fetchImpl: async () => new Response('{}', { status: 200 }),
  spawnImpl: async () => ({ code: 0, output: '', timedOut: false }),
  sleepImpl: async () => {},
})

describe('decideLocalLlmGate（审批门决策核）', () => {
  test('插件名 = dsh-local-llm', () => {
    expect(name).toBe('dsh-local-llm')
  })

  test('start/stop/pull → ask（写面）；list/call/未知名 → 不干预', () => {
    const start = decideLocalLlmGate({ name: 'local-llm-start' })
    expect(start?.kind).toBe('ask')
    expect(start.reason).toContain('本地小模型')
    const stop = decideLocalLlmGate({ name: 'local-llm-stop' })
    expect(stop?.kind).toBe('ask')
    const pull = decideLocalLlmGate({ name: 'local-llm-pull' })
    expect(pull?.kind).toBe('ask')
    expect(pull.reason).toContain('下载')
    expect(decideLocalLlmGate({ name: 'local-llm-list' })).toBeNull()
    expect(decideLocalLlmGate({ name: 'local-llm-call' })).toBeNull()
    expect(decideLocalLlmGate({ name: 'file_read' })).toBeNull()
    expect(decideLocalLlmGate({})).toBeNull()
    expect(decideLocalLlmGate(undefined)).toBeNull()
  })
})

describe('apply（接线）', () => {
  test('注册五实名 + pre-execute ask 门挂载（start/stop/pull 写面）', () => {
    const ctx = makeCtx()
    apply(ctx, {})
    expect([...ctx.registered.keys()]).toEqual(['local-llm-list', 'local-llm-start', 'local-llm-stop', 'local-llm-call', 'local-llm-pull'])
    expect(ctx.hooks.has('tools/pre-execute')).toBe(true)
    expect(ctx.registered.get('local-llm-pull').parameters.required).toEqual(['source'])
  })

  test('local-llm-pull id schema 收白名单 pattern（LLM 面与 core safeSegment 消毒同源）', () => {
    const ctx = makeCtx()
    apply(ctx, {})
    const id = ctx.registered.get('local-llm-pull').parameters.properties.id
    expect(id.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._-]*$')
    expect(id.description).toContain('首字符为字母数字')
  })

  test('无会话身份要求（升格后 in-child 直执行，登记表=机器级资产）', () => {
    const ctx = makeCtx()
    apply(ctx, { impls: makeImpls(null) })
    // execute 不再依赖 exec.agent（旧宿主回调形态的传输产物已拆）
    expect(ctx.registered.get('local-llm-call').parameters.required).toEqual(['id', 'prompt'])
  })

  test('execute → core 委托：登记表缺失 → 统一不可用文案（fail-closed）', async () => {
    const ctx = makeCtx()
    apply(ctx, { registryPath: '/t/reg.yaml', impls: makeImpls(null) })
    const out = await ctx.registered.get('local-llm-list').execute({}, {})
    expect(out.ok).toBe(false)
    expect(out.message).toContain('/t/reg.yaml')
    expect(out.message).toContain('不存在')
  })

  test('execute → core 委托：call 走通成功分支（impls 注入零网络）', async () => {
    const reg = 'models:\n  - id: m1\n    runtime: native\n    port: 8090\n'
    const impls = makeImpls(reg)
    impls.fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '答' } }] })
    const ctx = makeCtx()
    apply(ctx, { registryPath: '/t/reg.yaml', impls })
    const out = await ctx.registered.get('local-llm-call').execute({ id: 'm1', prompt: 'hi' }, {})
    expect(out).toEqual({ ok: true, message: '答' })
  })
})
