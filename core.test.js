// dsh-local-llm 语义核 keyless 单测：
// 可用门三态/list 双态/start 冷加载重试+超时/stop 双结局/未知 id·缺命令/call 分支
// + 子集解析器单元 + 缺省登记表路径解析 + 模型源解析/pull 计划/序列化/pull 全流程
// （236号）。全部经注入（readFile/writeFile/fetch/spawn/sleep），
// 零网络零真命令零真文件。

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSemantics, parseRegistryYaml, parseStartStopInput, parseCallInput, parsePullInput,
  parseModelSource, pickPullPlan, serializeRegistry, deriveId, resolveRegistryPath,
} from './core.js'

const REG = `# 登记表
models:
  - id: qwen3-4b        # 主力
    runtime: docker
    port: 8081
    ctx: 32768
    modelId: "qwen3:4b"
    apiBase: http://127.0.0.1:8081/v1
    start: "docker run -d --name qwen4b -p 8081:80 vllm/qwen"
    stop: "docker rm -f qwen4b"
    note: 备注自由文本
  - id: native-serve
    runtime: native
    port: 8090
`

const enoent = () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) }

/** 组装注入面：registry=null → ENOENT；probeResBy=fn(url)→Response；spawnQ=队列 */
const makeImpls = ({ registry = REG, fetchImpl, spawnQ = [], sleepLog = [] }) => ({
  readFileImpl: async () => (registry === null ? enoent() : registry),
  fetchImpl: fetchImpl ?? (async () => new Response('{}', { status: 200 })),
  spawnImpl: async () => spawnQ.shift() ?? { code: 0, output: '', timedOut: false },
  sleepImpl: async (ms) => { sleepLog.push(ms) },
})

const makeSem = (over = {}) => createSemantics({ registryPath: '/reg.yaml', ...makeImpls(over), ...over.impls })

describe('登记表子集解析 parseRegistryYaml', () => {
  test('登记格式契约形态：注释/引号串/整数/缺省可选项', () => {
    const out = parseRegistryYaml(REG)
    expect(out.models).toHaveLength(2)
    expect(out.models[0]).toEqual({
      id: 'qwen3-4b', runtime: 'docker', port: 8081, ctx: 32768, modelId: 'qwen3:4b',
      apiBase: 'http://127.0.0.1:8081/v1', start: 'docker run -d --name qwen4b -p 8081:80 vllm/qwen',
      stop: 'docker rm -f qwen4b', note: '备注自由文本',
    })
    expect(out.models[1]).toEqual({ id: 'native-serve', runtime: 'native', port: 8090 })
  })

  test('空 models 列表合法；空文本/缺 models:/顶层杂键/裸布尔/流式 → 报错不猜', () => {
    expect(parseRegistryYaml('models:\n').models).toEqual([])
    expect(() => parseRegistryYaml('')).toThrow('models')
    expect(() => parseRegistryYaml('others: 1')).toThrow('仅支持 models')
    expect(() => parseRegistryYaml('models:\n  - id: a\n    note: true\n    runtime: native\n    port: 1\n')).toThrow('引号')
    expect(() => parseRegistryYaml('models:\n  - id: a\n    note: [1,2]\n    runtime: native\n    port: 1\n')).toThrow('子集')
  })
})

describe('可用门三态（fail-closed）', () => {
  test('登记表缺失 → 统一不可用文案；坏 YAML → 带路径；坏结构 → 字段级', async () => {
    const miss = makeSem({ registry: null })
    const out = await miss.list()
    expect(out.ok).toBe(false)
    expect(out.message).toContain('/reg.yaml')
    expect(out.message).toContain('不存在')

    const badYaml = makeSem({ registry: 'models:\n  - id: a\n  bad line here\n' })
    const y = await badYaml.list()
    expect(y.ok).toBe(false)
    expect(y.message).toContain('不是合法 YAML')

    const badStruct = makeSem({ registry: 'models:\n  - id: a\n    runtime: vm\n    port: 8081\n' })
    const s = await badStruct.list()
    expect(s.ok).toBe(false)
    expect(s.message).toContain('models.0.runtime')
    const badYaml2 = makeSem({ registry: 'models: [not a list]\n' })
    const y2 = await badYaml2.list()
    expect(y2.message).toContain('无需重启')
  })
})

describe('list 双态投影', () => {
  test('在跑/未跑并行探活 + 探得模型名 + 空登记表引导', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('8081')) return Response.json({ data: [{ id: 'qwen3:4b' }] })
      throw new Error('connect ECONNREFUSED')
    }
    const out = await makeSem({ fetchImpl }).list()
    expect(out.ok).toBe(true)
    expect(out.message).toContain('2 条，1 个在跑')
    expect(out.message).toContain('● 在跑')
    expect(out.message).toContain('○ 未跑')
    expect(out.message).toContain('探得:qwen3:4b')
    expect(out.message).toContain('model=qwen3:4b')

    const empty = await makeSem({ registry: 'models:\n' }).list()
    expect(empty.message).toContain('登记表为空')
  })
})

describe('start 生命周期', () => {
  const probeThen = (refusedTimes, upAfter) => {
    let n = 0
    return async () => { n += 1; if (n <= refusedTimes || !upAfter) { throw new Error('connect ECONNREFUSED') } return Response.json({ data: [{ id: 'm' }] }) }
  }

  test('冷加载窗口内重试探活成功（sleep 计数>0，ok:true）', async () => {
    const sleepLog = []
    const sem = createSemantics({
      registryPath: '/reg.yaml', ...makeImpls({ sleepLog }),
      fetchImpl: probeThen(2, true), spawnImpl: async () => ({ code: 0, output: 'abc123', timedOut: false }),
    })
    const out = await sem.start({ id: 'qwen3-4b' })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('exit=0')
    expect(out.message).toContain('● 在跑')
    expect(sleepLog.length).toBeGreaterThanOrEqual(2)
  })

  test('命令超时 → ok:false 带输出尾部与复核指路', async () => {
    const out = await makeSem({ spawnQ: [{ code: -1, output: 'pulling…', timedOut: true }] }).start({ id: 'qwen3-4b' })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('已终止')
    expect(out.message).toContain('local-llm-list')
  })

  test('命令成功但探活始终不可达 → ok:true 报告型（不误判失败）', async () => {
    const out = await makeSem({ fetchImpl: probeThen(99, false) }).start({ id: 'qwen3-4b' })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('仍不可达')
  })
})

describe('stop 双结局 + 引导分支', () => {
  test('停后探活确认已停 → ok:true；仍在跑 → ok:false 指查 stop 命令', async () => {
    const stopped = await makeSem({ fetchImpl: async () => { throw new Error('refused') } }).stop({ id: 'qwen3-4b' })
    expect(stopped.ok).toBe(true)
    expect(stopped.message).toContain('○ 已停')

    const stillUp = await makeSem().stop({ id: 'qwen3-4b' })
    expect(stillUp.ok).toBe(false)
    expect(stillUp.message).toContain('stop 命令可能未生效')
  })

  test('未知 id → 列出已登记；缺 start/stop 命令 → 指引登记', async () => {
    const nf = await makeSem().start({ id: 'nope' })
    expect(nf.ok).toBe(false)
    expect(nf.message).toContain('没有 "nope"')
    expect(nf.message).toContain('qwen3-4b')
    const noCmd = await makeSem().stop({ id: 'native-serve' })
    expect(noCmd.ok).toBe(false)
    expect(noCmd.message).toContain('未登记 stop 命令')
  })
})

describe('call 分支', () => {
  const okBody = (extra = {}) => Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '答' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...extra,
  })

  test('成功含默认值（max_tokens=2048 随 body 发出）+ 用量行', async () => {
    const bodies = []
    const out = await makeSem({
      fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body)); return okBody() },
    }).call({ id: 'qwen3-4b', prompt: 'hi' })
    expect(out.ok).toBe(true)
    expect(out.message).toContain('答')
    expect(out.message).toContain('prompt 10 / completion 5')
    expect(bodies[0].max_tokens).toBe(2048)
    expect(bodies[0].model).toBe('qwen3:4b')
  })

  test('连接拒绝 → 指路 list/start；超时 → 指路加大 timeoutMs', async () => {
    const refused = await makeSem({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8081') } }).call({ id: 'qwen3-4b', prompt: 'x' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain('local-llm-start')
    const slow = await makeSem({ fetchImpl: async () => { throw new Error('The operation was aborted due to timeout') } }).call({ id: 'qwen3-4b', prompt: 'x' })
    expect(slow.message).toContain('加大 timeoutMs')
  })

  test('非 200 → 带状态码与响应体头', async () => {
    const out = await makeSem({ fetchImpl: async () => new Response('boom', { status: 503 }) }).call({ id: 'qwen3-4b', prompt: 'x' })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('HTTP 503')
    expect(out.message).toContain('boom')
  })

  test('思考型回退：content 空+reasoning 在 → 节选产出；两者皆空 → 形状异常', async () => {
    const think = await makeSem({
      fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '', reasoning: '想了很久' } }] }),
    }).call({ id: 'qwen3-4b', prompt: 'x' })
    expect(think.ok).toBe(true)
    expect(think.message).toContain('思考过程节选')
    expect(think.message).toContain('max_tokens=2048 截断')
    const weird = await makeSem({
      fetchImpl: async () => Response.json({ choices: [{ message: {} }] }),
    }).call({ id: 'qwen3-4b', prompt: 'x' })
    expect(weird.ok).toBe(false)
    expect(weird.message).toContain('回复形状异常')
  })

  test('参数复验：prompt 超限 / 未知 id', async () => {
    const bad = await makeSem().call({ id: 'qwen3-4b', prompt: 'x'.repeat(32769) })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('参数不合法')
    const nf = await makeSem().call({ id: 'ghost', prompt: 'x' })
    expect(nf.message).toContain('没有 "ghost"')
  })
})

describe('入参复验与路径解析（纯函数）', () => {
  test('parseStartStopInput / parseCallInput 边界', () => {
    expect(parseStartStopInput({ id: 'a' }).ok).toBe(true)
    expect(parseStartStopInput({ id: '' }).ok).toBe(false)
    expect(parseCallInput({ id: 'a', prompt: 'p' }).value.maxTokens).toBe(2048)
    expect(parseCallInput({ id: 'a', prompt: 'p', maxTokens: 8 }).ok).toBe(false)
  })

  test('resolveRegistryPath：显式 > env > HOME 缺省（env/HOME save/restore，禁裸 delete 无恢复）', () => {
    expect(resolveRegistryPath('/x.yaml')).toBe('/x.yaml')
    const savedEnv = process.env.DSH_LOCAL_MODELS_REGISTRY
    const savedHome = process.env.HOME
    try {
      process.env.DSH_LOCAL_MODELS_REGISTRY = '/env.yaml'
      expect(resolveRegistryPath()).toBe('/env.yaml')
      delete process.env.DSH_LOCAL_MODELS_REGISTRY
      process.env.HOME = '/home tester'
      expect(resolveRegistryPath().startsWith('/home tester')).toBe(true)
    } finally {
      if (savedEnv === undefined) delete process.env.DSH_LOCAL_MODELS_REGISTRY
      else process.env.DSH_LOCAL_MODELS_REGISTRY = savedEnv
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    }
  })
})

describe('缺省登记表路径（无 env 无显式路径）', () => {
  let savedEnv, savedHome, tmpHome
  beforeAll(() => {
    savedEnv = process.env.DSH_LOCAL_MODELS_REGISTRY
    savedHome = process.env.HOME
    tmpHome = mkdtempSync(join(tmpdir(), 'dsh-local-llm-home-test-'))
    delete process.env.DSH_LOCAL_MODELS_REGISTRY
    process.env.HOME = tmpHome
  })
  afterAll(() => {
    // 显式摘恢复（裸 delete 无恢复 → 同进程后续文件 HOME 语义漂移，返工教训）
    if (savedEnv === undefined) delete process.env.DSH_LOCAL_MODELS_REGISTRY
    else process.env.DSH_LOCAL_MODELS_REGISTRY = savedEnv
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })
  test('缺省 = HOME/.dsh/local-models.yaml', () => {
    expect(resolveRegistryPath()).toBe(join(tmpHome, '.dsh', 'local-models.yaml'))
  })
})

// ---------- local-llm-pull（236号） ----------

describe('模型源解析 parseModelSource', () => {
  test('HF 各形态：URL/hf.co 短形/hf-mirror/ollama tag/resolve·blob 单文件', () => {
    expect(parseModelSource('https://huggingface.co/Qwen/Qwen3-4B')).toEqual({
      hub: 'hf', repo: 'Qwen/Qwen3-4B', canonical: 'hf:Qwen/Qwen3-4B',
    })
    expect(parseModelSource('hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M')).toEqual({
      hub: 'hf', repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', tag: 'Q4_K_M',
      canonical: 'hf:bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M',
    })
    expect(parseModelSource('https://hf-mirror.com/org/name').hub).toBe('hf')
    expect(parseModelSource('https://huggingface.co/org/name/resolve/main/sub/model-Q4_K_M.gguf').file).toBe('sub/model-Q4_K_M.gguf')
    expect(parseModelSource('https://huggingface.co/org/name/blob/main/a.gguf').file).toBe('a.gguf')
    // /resolve/main（仅分支无文件）→ 无 file
    expect(parseModelSource('https://huggingface.co/org/name/tree/main').file).toBeUndefined()
  })

  test('魔搭各形态：/models/ 前缀/resolve 单文件/短路径/www.', () => {
    expect(parseModelSource('https://modelscope.cn/models/iic/Qwen3-0.6B')).toEqual({
      hub: 'ms', repo: 'iic/Qwen3-0.6B', canonical: 'ms:iic/Qwen3-0.6B',
    })
    expect(parseModelSource('https://www.modelscope.cn/models/iic/Qwen3-0.6B/resolve/master/model.safetensors').file).toBe('model.safetensors')
    expect(parseModelSource('modelscope.cn/iic/Qwen3-0.6B').hub).toBe('ms')
    expect(parseModelSource('ms:iic/Qwen3-0.6B')).toEqual({ hub: 'ms', repo: 'iic/Qwen3-0.6B', canonical: 'ms:iic/Qwen3-0.6B' })
  })

  test('简写/裸 id/前缀与站点一致性', () => {
    expect(parseModelSource('hf:org/name').hub).toBe('hf')
    expect(parseModelSource('org/name')).toEqual({ hub: 'hf', repo: 'org/name', canonical: 'hf:org/name' })
    expect(parseModelSource('org/name:Q4_K_M').tag).toBe('Q4_K_M')
    // canonical 可再喂回（不含 file）
    const once = parseModelSource('https://huggingface.co/org/name/resolve/main/a.gguf')
    expect(parseModelSource(once.canonical)).toEqual(parseModelSource('hf:org/name'))
    expect(() => parseModelSource('ms:hf.co/org/name')).toThrow('不一致')
  })

  test('fail-closed：元字符/未知站点/单段/查询串/.. 穿越/超长', () => {
    expect(() => parseModelSource('hf:a;b/name')).toThrow('不安全字符')
    expect(() => parseModelSource('hf:org/na me')).toThrow('不安全字符')
    expect(() => parseModelSource('https://evil.com/x/y')).toThrow('不认识的站点')
    expect(() => parseModelSource('single')).toThrow('org/name')
    expect(() => parseModelSource('https://huggingface.co/org/name?x=1')).toThrow('查询串')
    expect(() => parseModelSource('https://huggingface.co/org/name/resolve/main/../../etc/passwd')).toThrow('不安全字符')
    expect(() => parseModelSource('https://huggingface.co/org')).toThrow('两段')
    expect(() => parseModelSource(`${'a'.repeat(501)}`)).toThrow('超')
    expect(() => parseModelSource('')).toThrow('非空')
    expect(() => parseModelSource('org/name:bad;tag')).toThrow('不安全字符')
  })
})

describe('拉取计划 pickPullPlan', () => {
  const set = (...xs) => new Set(xs)
  const ggufTag = parseModelSource('hf:bartowski/Llama-3.2-1B-GGUF:Q4_K_M')
  const ggufFile = parseModelSource('https://huggingface.co/org/model-GGUF/resolve/main/q4_k_m.gguf')
  const repoHf = parseModelSource('hf:org/name')
  const repoMs = parseModelSource('ms:org/name')

  test('GGUF+ollama → ollama pull；无 tag 拒；无 ollama 拒', () => {
    const plan = pickPullPlan(ggufTag, set('ollama'), { dir: '/d' })
    expect(plan.kind).toBe('ollama-pull')
    expect(plan.cmd).toBe('ollama pull hf.co/bartowski/Llama-3.2-1B-GGUF:Q4_K_M')
    expect(plan.serve).toBe('ollama')
    expect(plan.modelId).toBe('hf.co/bartowski/Llama-3.2-1B-GGUF:Q4_K_M')
    expect(() => pickPullPlan(parseModelSource('hf:org/name'), set('ollama'), { backend: 'ollama', dir: '/d' })).toThrow('quant 标签')
    expect(() => pickPullPlan(ggufTag, set(), { backend: 'ollama', dir: '/d' })).toThrow('未探测到 ollama')
  })

  test('GGUF 文件无 ollama → hf CLI 单文件；hf 缺 → 指引；legacy huggingface-cli 兜底', () => {
    const plan = pickPullPlan(ggufFile, set('hf', 'llama-server'), { dir: '/d' })
    expect(plan.kind).toBe('cli-download')
    expect(plan.cmd).toBe('hf download org/model-GGUF "q4_k_m.gguf" --local-dir "/d"')
    expect(plan.serve).toBe('llama-server')
    expect(() => pickPullPlan(ggufFile, set('llama-server'), { dir: '/d' })).toThrow('huggingface_hub')
    const legacy = pickPullPlan(ggufFile, set('huggingface-cli'), { dir: '/d' })
    expect(legacy.cmd).toContain('huggingface-cli download')
  })

  test('mirror → HF_ENDPOINT 前缀；整仓 hf+vllm → vllm serve 计划', () => {
    const mirrored = pickPullPlan(repoHf, set('hf'), { dir: '/d', mirror: true })
    expect(mirrored.cmd).toContain('HF_ENDPOINT=https://hf-mirror.com hf download org/name')
    const vllmPlan = pickPullPlan(repoHf, set('hf', 'vllm'), { dir: '/d' })
    expect(vllmPlan.serve).toBe('vllm')
    expect(vllmPlan.cmd).toBe('hf download org/name --local-dir "/d"')
    const noServe = pickPullPlan(repoHf, set('hf'), { dir: '/d' })
    expect(noServe.serve).toBeNull()
  })

  test('魔搭通道 + backend 显式覆盖的站点一致性与缺 CLI 拒绝', () => {
    const plan = pickPullPlan(repoMs, set('modelscope'), { dir: '/d' })
    expect(plan.cmd).toBe('modelscope download --model org/name --local-dir "/d"')
    expect(() => pickPullPlan(repoMs, set(), { dir: '/d' })).toThrow('未探测到 modelscope')
    expect(() => pickPullPlan(repoMs, set('hf'), { backend: 'hf', dir: '/d' })).toThrow('不能拉魔搭')
    expect(() => pickPullPlan(repoHf, set('modelscope'), { backend: 'modelscope', dir: '/d' })).toThrow('不能拉 HF')
    // ms GGUF + llama-server → llama-server serve
    const msGguf = parseModelSource('ms:org/qwen-gguf')
    expect(pickPullPlan({ ...msGguf, file: 'm.gguf' }, set('modelscope', 'llama-server'), { dir: '/d' }).serve).toBe('llama-server')
  })
})

describe('登记表序列化 serializeRegistry', () => {
  test('往返等价：parse∘serialize = idempotent（含注释丢失——子集保真以数据为准）', () => {
    const entries = parseRegistryYaml(REG).models
    const text = serializeRegistry(entries)
    expect(parseRegistryYaml(text).models).toEqual(entries)
    expect(serializeRegistry(parseRegistryYaml(text).models)).toBe(text)
  })

  test('新条目（含 source 字段）可序列化并解析回来；数字裸写', () => {
    const entry = { id: 'new', runtime: 'native', port: 11434, modelId: 'hf.co/a/b:Q4_K_M', source: 'hf:a/b:Q4_K_M', note: "ollama 守护进程面（通常已自起）" }
    const text = serializeRegistry([entry])
    expect(text).toContain('  - id: "new"')
    expect(text).toContain('    port: 11434')
    expect(parseRegistryYaml(text).models).toEqual([entry])
  })

  test('fail-closed：双引号/换行/非标量 → 拒绝（子集无转义，不产坏表）', () => {
    expect(() => serializeRegistry([{ id: 'a"b', runtime: 'native', port: 1 }])).toThrow('无转义')
    expect(() => serializeRegistry([{ id: 'a\nb', runtime: 'native', port: 1 }])).toThrow('换行')
    expect(() => serializeRegistry([{ id: 'a', port: true }])).toThrow('类型不合法')
  })
})

describe('pull 入参与 id 派生（纯函数）', () => {
  test('parsePullInput 缺省与边界', () => {
    expect(parsePullInput({ source: 'hf:a/b' }).value.timeoutMs).toBe(600000)
    expect(parsePullInput({ source: 'hf:a/b', timeoutMs: 3_600_000 }).ok).toBe(true)
    expect(parsePullInput({ source: 'hf:a/b', timeoutMs: 3_600_001 }).ok).toBe(false)
    expect(parsePullInput({}).ok).toBe(false)
    expect(parsePullInput({ source: 'hf:a/b', backend: 'wget' }).ok).toBe(false)
    expect(parsePullInput({ source: 'hf:a/b', port: 0 }).ok).toBe(false)
    expect(parsePullInput({ source: 'hf:a/b', mirror: 'yes' }).ok).toBe(false)
  })

  test('deriveId：折叠非法字符/截断/空回退', () => {
    expect(deriveId('Org/Model-Name')).toBe('org-model-name')
    expect(deriveId('a/b..c__d')).toBe('a-b-c-d')
    expect(deriveId('x'.repeat(80))).toHaveLength(64)
    expect(deriveId('///')).toBe('model')
  })

  // P0 命令注入收口：id 拼进 downloadDir / bash -c 双引号 --local-dir / 登记表 start
  // 命令序列化——过 safeSegment 同款白名单，非法字符 fail-closed 拒绝（不静默清洗）
  test('id 白名单 fail-closed：$()/反引号/双引号/分号/空格/单引号/.. 穿越/斜杠 → 拒绝并报可读错', () => {
    const badIds = [
      'evil$(touch /tmp/pwned)',       // $(...) 命令替换（双引号内照常展开）
      'evil`touch /tmp/pwned`',        // 反引号替换
      'x"$(id)',                       // 双引号（破出 --local-dir "…" 引号）
      "x'$(id)",                       // 单引号（破出登记表 start 的 '…' 包裹）
      'evil;id',                       // 分号
      'evil id',                       // 空格
      'tab\tid',                       // 制表符（空白）
      '../escape',                     // .. 路径穿越（downloadDir 拼接面）
      '..',                            // 裸 .. 段
      '.',                             // 裸 . 段
      'a/b',                           // 斜杠（跨目录写）
      '-lead',                         // 前导 -（safeSegment 起点须字母数字）
      '.hidden',                       // 前导点
    ]
    for (const id of badIds) {
      const out = parsePullInput({ source: 'hf:a/b', id })
      expect(out.ok).toBe(false)
      expect(out.message).toContain('参数不合法')
      expect(out.message).toContain('不安全字符')
      expect(out.message).toContain(id) // 报错回显原值，可读可定位
    }
  })

  test('id 白名单放行：派生形态/点划线/大小写/Unicode 字母与 64 上限（与 safeSegment 同源）', () => {
    for (const id of ['org-name', 'my.model_1', 'Qwen3-4B', 'bartowski-llama-3-2-1b-gguf', '模型1', 'a'.repeat(64)]) {
      expect(parsePullInput({ source: 'hf:a/b', id }).ok).toBe(true)
    }
    expect(parsePullInput({ source: 'hf:a/b', id: 'a'.repeat(65) }).ok).toBe(false) // 长度上限原样保留
    expect(parsePullInput({ source: 'hf:a/b' }).value.id).toBeUndefined()          // 缺省不手填
  })
})

describe('pull 全流程（236号：探测→下载→登记）', () => {
  /** 组装：probeOut=通道探测输出；downloadQ=下载命令结果队列；捕获 cmds 与写入文本 */
  const pullSem = ({ registry = REG, probeOut = 'ollama', downloadQ = [], writeFile } = {}) => {
    const cmds = []
    let writes = []
    const impls = {
      readFileImpl: async () => (registry === null ? enoent() : registry),
      fetchImpl: async () => new Response('{}', { status: 200 }),
      spawnImpl: async (cmd) => {
        cmds.push(cmd)
        if (String(cmd).startsWith('for b in')) return { code: 0, output: probeOut, timedOut: false }
        return downloadQ.shift() ?? { code: 0, output: '', timedOut: false }
      },
      sleepImpl: async () => {},
      writeFileImpl: async (path, content) => { writes.push({ path, content }); writeFile?.(path, content) },
    }
    return { sem: createSemantics({ registryPath: '/reg.yaml', ...impls }), cmds, writes: () => writes }
  }

  test('GGUF+ollama：下载命令、条目 11434/modelId/source、登记表含新旧条目', async () => {
    const p = pullSem({})
    const out = await p.sem.pull({ source: 'hf:bartowski/Llama-3.2-1B-GGUF:Q4_K_M' })
    expect(out.ok).toBe(true)
    expect(p.cmds[1]).toBe('ollama pull hf.co/bartowski/Llama-3.2-1B-GGUF:Q4_K_M')
    expect(p.writes()).toHaveLength(1)
    const text = p.writes()[0].content
    const entries = parseRegistryYaml(text).models
    expect(entries).toHaveLength(3)
    const added = entries[2]
    expect(added.id).toBe('bartowski-llama-3-2-1b-gguf')
    expect(added.port).toBe(11434)
    expect(added.modelId).toBe('hf.co/bartowski/Llama-3.2-1B-GGUF:Q4_K_M')
    expect(added.source).toBe('hf:bartowski/Llama-3.2-1B-GGUF:Q4_K_M')
    expect(added.start).toBeUndefined()
    expect(out.message).toContain('11434')
  })

  test('hf CLI+llama-server：单文件路径进 start 命令（tmp+rename 面）', async () => {
    const p = pullSem({ probeOut: 'hf\nllama-server' })
    const out = await p.sem.pull({ source: 'https://huggingface.co/org/model-GGUF/resolve/main/q4_k_m.gguf', id: 'my-gguf', port: 9000 })
    expect(out.ok).toBe(true)
    expect(p.cmds[1]).toBe('hf download org/model-GGUF "q4_k_m.gguf" --local-dir "/models/my-gguf"')
    const added = parseRegistryYaml(p.writes()[0].content).models[2]
    expect(added.id).toBe('my-gguf')
    expect(added.port).toBe(9000)
    expect(added.start).toBe("llama-server -m '/models/my-gguf/q4_k_m.gguf' --host 127.0.0.1 --port 9000 -c 4096")
    expect(added.stop).toBe("pkill -f 'llama-server.*--port 9000'")
    expect(added.modelId).toBe('q4_k_m.gguf')
    expect(out.message).toContain('local-llm-start my-gguf')
  })

  test('登记表缺失可引导建表；file 参数覆盖；无后端 → start/stop 留空+note', async () => {
    const p = pullSem({ registry: null, probeOut: 'hf', downloadQ: [{ code: 0, output: 'downloading 100%', timedOut: false }] })
    const out = await p.sem.pull({ source: 'hf:org/name', file: 'sub/m.gguf' })
    expect(out.ok).toBe(true)
    const text = p.writes()[0].content
    expect(text.startsWith('models:\n')).toBe(true)
    const entries = parseRegistryYaml(text).models
    expect(entries).toHaveLength(1)
    expect(entries[0].start).toBeUndefined()
    expect(entries[0].note).toContain('未探测到推理后端')
    expect(p.cmds[1]).toContain('"sub/m.gguf"')
    expect(out.message).toContain('downloading 100%')
  })

  test('vllm 整仓路径：start= vllm serve 目录', async () => {
    const p = pullSem({ probeOut: 'hf\nvllm' })
    const out = await p.sem.pull({ source: 'hf:Qwen/Qwen3-4B' })
    expect(out.ok).toBe(true)
    const added = parseRegistryYaml(p.writes()[0].content).models[2]
    expect(added.start).toBe("vllm serve '/models/qwen-qwen3-4b' --host 127.0.0.1 --port 8081")
    expect(added.stop).toBe("pkill -f 'vllm serve.*--port 8081'")
    expect(added.modelId).toBe('/models/qwen-qwen3-4b')
  })

  test('fail-closed：id 撞车不写表/坏表拒写/source 解析失败/无通道/下载红/超时续传', async () => {
    const collision = await pullSem({}).sem.pull({ source: 'hf:org/x', id: 'qwen3-4b' })
    expect(collision.ok).toBe(false)
    expect(collision.message).toContain('不覆盖既有条目')

    const broken = await pullSem({ registry: 'models:\n  bad line\n' }).sem.pull({ source: 'hf:a/b' })
    expect(broken.ok).toBe(false)
    expect(broken.message).toContain('不覆盖损坏的登记表')

    const badSource = await pullSem({}).sem.pull({ source: 'not-a-model' })
    expect(badSource.ok).toBe(false)
    expect(badSource.message).toContain('source 解析失败')

    const noCli = await pullSem({ probeOut: '', registry: 'models:\n' }).sem.pull({ source: 'hf:a/b' })
    expect(noCli.ok).toBe(false)
    expect(noCli.message).toContain('未探测到 hf CLI')

    const failed = await pullSem({ probeOut: 'hf', downloadQ: [{ code: 1, output: '401 Unauthorized', timedOut: false }] }).sem.pull({ source: 'hf:a/b' })
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('HF_TOKEN')

    const slow = await pullSem({ probeOut: 'hf', downloadQ: [{ code: -1, output: '50%', timedOut: true }] }).sem.pull({ source: 'hf:a/b' })
    expect(slow.ok).toBe(false)
    expect(slow.message).toContain('续传')

    const badInput = await pullSem({}).sem.pull({ source: '' })
    expect(badInput.ok).toBe(false)
    expect(badInput.message).toContain('参数不合法')
  })

  // P0 命令注入收口（全流程）：恶意 id 在入参复验即死——通道探测/下载命令零执行、
  // 登记表零写入（downloadDir 路径拼接与 --local-dir "…" 双引号插值不可达）
  test('fail-closed：id 含元字符 → 解析即拒，零命令执行零登记写', async () => {
    for (const id of ['x"$(touch /tmp/pwned)', 'x`id`', "x'id", 'x;id', 'x id', '../escape']) {
      const p = pullSem({ probeOut: 'hf', downloadQ: [{ code: 0, output: 'sentinel-should-never-run', timedOut: false }] })
      const out = await p.sem.pull({ source: 'hf:org/name', id })
      expect(out.ok).toBe(false)
      expect(out.message).toContain('不安全字符')
      expect(p.cmds).toHaveLength(0)      // bash -c 一次都没跑（连通道探测都没有）
      expect(p.writes()).toHaveLength(0)  // 登记表零写入
    }
    // 对照组：同 source 走合法 id 正常放行（正常 org/name 派生/手填流程不受影响）
    const ok = pullSem({ probeOut: 'hf', downloadQ: [{ code: 0, output: '', timedOut: false }] })
    const okOut = await ok.sem.pull({ source: 'hf:org/name', id: 'org-name' })
    expect(okOut.ok).toBe(true)
    expect(ok.cmds).toHaveLength(2) // 通道探测 + 下载
    expect(ok.writes()).toHaveLength(1)
  })
})
