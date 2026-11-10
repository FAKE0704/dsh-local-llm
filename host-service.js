// dsh-local-llm — V1 Host 服务核：provider adapter（OpenAI 兼容 wire）+ Web 桥 + 探活缓存。
//
// 零宿主包 import 纪律：LlmRuntime 对 adapter 只做鸭子调用（providerInfo /
// providerRetryPolicy / listModels / resolveModel / prepareCall / stream），
// 契约已对照 @deepseek-ai/dsh-llm@0.2.2-rc.1 lib 核实：
//   stream 产出 StreamChunk：block-start / text-delta / reasoning-delta /
//   tool-call-delta / block-end / usage / finish；usage 在 finish 之前，其后无 chunk。
// 状态联动：登记表/启停/下载变化 → ctx.emit('llm/models-updated', 'local-llm')，
// 选择器与设置页自行重载目录（已核实消费面监听该事件）。

import { readFile, readdir, stat, writeFile, rename, mkdir, open } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  resolveRegistryPath,
  parseRegistryYaml,
  parseModelSource,
  deriveId,
  parsePullInput,
  pickPullPlan,
  serializeRegistry,
  createSemantics,
} from './core.js'

/** provider 路由名（Composer 模型菜单里「本地模型」组的 provider id） */
export const PROVIDER_ID = 'local-llm'

const PROBE_TIMEOUT_MS = 2500
const WEB_PATH = '/api/dsh-local-llm'
const USER_AGENT = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness) dsh-local-llm/1.2.6'
const PULL_PROBE_CMD = 'for b in ollama hf huggingface-cli modelscope llama-server vllm; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done'
const PULL_PROBE_TIMEOUT_MS = 5000

// ---------- 目录扫描识别（V2.1：从用户已有目录发现本地模型） ----------

/** 扫描深度（相对根）与非模型目录黑名单（源码树/依赖/产物不进） */
const SCAN_DEPTH = 3
const SKIP_DIR_NAMES = new Set([
  'node_modules', '__pycache__', 'build', 'bin', 'cmake', 'include', 'src', 'tests',
  'test', 'docs', 'examples', 'ci', 'scripts', 'tools', 'licenses', 'vendor',
  'gguf-py', 'adapter', 'adapter_vllm', 'videos', 'reports', 'demos', 'datasets',
])
/** GGUF 分片形如 *-00001-of-00003.gguf——同目录分片归组为一个模型 */
const GGUF_SHARD = /-(\d{5})-of-\d{5}\.gguf$/i
/** 小于该体积的 .gguf 视为词表/测试文件（llama.cpp 源码树的 ggml-vocab-* 等），不识别 */
const MIN_GGUF_BYTES = 16 * 1024 * 1024

async function isFile(p) {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

async function dirHas(p, name) {
  return isFile(join(p, name))
}

/** PATH → 根目录常见位置，解析建议的推理后端二进制（找不到 → null，命令退回裸名） */
async function resolveServeBinary(root, bin) {
  const onPath = await runProbe(`command -v ${bin}`, 5000)
  if (onPath.code === 0 && onPath.output !== '') return onPath.output.split('\n')[0].trim()
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
  if (bin === 'llama-server') {
    const direct = [join(root, 'llama.cpp', 'build', 'bin', 'llama-server'), join(root, 'llama-server')]
    for (const g of direct) if (await isFile(g)) return g
    for (const d of dirs) {
      const g = join(root, d, 'build', 'bin', 'llama-server')
      if (await isFile(g)) return g
    }
  }
  if (bin === 'vllm') {
    for (const d of entries) {
      if (!d.isDirectory()) continue
      if (d.name === '.venv' || d.name.endsWith('venv')) {
        const g = join(root, d.name, 'bin', 'vllm')
        if (await isFile(g)) return g
      }
    }
    for (const d of dirs) {
      const g = join(root, d, 'bin', 'vllm')
      if (await isFile(g)) return g
    }
  }
  return null
}

/** 单字节计（gguf 文件或 safetensors 集合），失败忽略 */
async function sizeOfList(paths) {
  let total = 0
  for (const p of paths) {
    try {
      total += (await stat(p)).size
    } catch { /* 忽略 */ }
  }
  return total
}

/**
 * 扫描识别（只读）：根目录深度 ≤3，跳过点目录与黑名单目录。
 * 识别两类：*.gguf 文件（同目录分片归组）；含 config.json + *.safetensors
 * （或 model.safetensors.index.json）的 HF 整仓目录。
 */
/** 模块级导出（keyless 直测缝）：scanDirectory 只读无副作用 */
export async function scanDirectory(root) {
  const found = []
  const [llamaBin, vllmBin] = await Promise.all([
    resolveServeBinary(root, 'llama-server'),
    resolveServeBinary(root, 'vllm'),
  ])

  async function visit(dir, depth) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // —— HF 整仓目录：config.json + 分片/单文件 safetensors 或 index ——
    if (await dirHas(dir, 'config.json')) {
      const safetensors = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.safetensors'))
        .map((e) => join(dir, e.name))
      const hasIndex = await isFile(join(dir, 'model.safetensors.index.json'))
      if (safetensors.length > 0 || hasIndex) {
        const name = basename(dir)
        found.push({
          kind: 'hf-dir',
          id: deriveId(name),
          name,
          path: dir,
          sizeBytes: await sizeOfList(safetensors),
          serveBin: vllmBin,
          serveKind: vllmBin ? 'vllm' : null,
        })
        return // 已分类，不再下探（adapter/vl/reports 等子目录不误报）
      }
    }
    // —— GGUF 文件（分片归组；<16MB 视为词表/测试片，跳过）——
    // 注意：本目录有 GGUF 不代表没有子目录模型——不 return，继续下探。
    const ggufEntries = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.gguf'))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    if (ggufEntries.length > 0) {
      const shards = ggufEntries.filter((e) => GGUF_SHARD.test(e.name))
      const singles = ggufEntries.filter((e) => !GGUF_SHARD.test(e.name))
      if (shards.length > 0) {
        const paths = shards.map((e) => join(dir, e.name))
        const sizeBytes = await sizeOfList(paths)
        if (sizeBytes >= MIN_GGUF_BYTES) {
          const first = paths[0]
          const stem = shards[0].name.replace(GGUF_SHARD, '')
          found.push({
            kind: 'gguf',
            id: deriveId(stem),
            name: stem,
            path: first,
            sizeBytes,
            serveBin: llamaBin,
            serveKind: llamaBin ? 'llama-server' : null,
            shardCount: shards.length,
          })
        }
      }
      for (const e of singles) {
        const p = join(dir, e.name)
        const sizeBytes = await sizeOfList([p])
        if (sizeBytes < MIN_GGUF_BYTES) continue
        found.push({
          kind: 'gguf',
          id: deriveId(e.name.replace(/\.gguf$/i, '')),
          name: e.name.replace(/\.gguf$/i, ''),
          path: p,
          sizeBytes,
          serveBin: llamaBin,
          serveKind: llamaBin ? 'llama-server' : null,
        })
      }
    }
    if (depth >= SCAN_DEPTH) return
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue
      await visit(join(dir, e.name), depth + 1)
    }
  }

  await visit(root, 1)
  // 同 id 去重（保留首个）
  const seen = new Set()
  return found.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
}

// ---------- Ollama 模型库识别（V2.2：~/.ollama/models 的 manifests+blobs 布局） ----------

const OLLAMA_MODELS_DIR = join(homedir(), '.ollama', 'models')
/** ollama manifest 里指向文本生成权重的 layer 类型（embedding/adapter 等另行判断或跳过） */
const OLLAMA_MODEL_LAYER = 'application/vnd.ollama.image.model'
/** 名字带这些词的按嵌入模型标注（bge-m3 等）——登记时补 --embeddings */
const EMBEDDING_NAME_RE = /(?:^|[-_./])(?:bge|e5|gte|nomic|embed|arctic-embed|jina-clip)/i

/** 读文件头 4 字节校验 GGUF 魔数（ollama blob 是改名 GGUF，但不盲信 manifest 标注） */
async function isGgufPath(p) {
  let fh
  try {
    fh = await open(p, 'r')
  } catch {
    return false
  }
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    return bytesRead === 4 && buf.toString('latin1') === 'GGUF'
  } catch {
    return false
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 扫描 Ollama 模型库（只读）：…/manifests/<host>/<ns…>/<name>/<tag> 叶文件即 tag，
 * manifest JSON 的 layers 里 mediaType 为 vnd.ollama.image.model 的 blob 即权重——
 * 本质是标准 GGUF，可直接用 llama-server 起（rootHint 传入用户工作台以探测其构建树）。
 * 注意 blob 是内容寻址的共享存储：多个 tag 复用同一权重时体积按 layer 标注值计，磁盘实际去重。
 */
export async function scanOllamaStore(rootHint) {
  const manifestsDir = join(OLLAMA_MODELS_DIR, 'manifests')
  const blobsDir = join(OLLAMA_MODELS_DIR, 'blobs')
  const probe = await readdir(manifestsDir).catch(() => null)
  if (probe === null) return [] // 本机没有 ollama 模型库
  const llamaBin = await resolveServeBinary(rootHint ?? OLLAMA_MODELS_DIR, 'llama-server')
  const found = []

  async function visit(dir, rel) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const nextRel = [...rel, e.name]
      if (e.isDirectory()) {
        await visit(join(dir, e.name), nextRel)
        continue
      }
      if (!e.isFile()) continue
      // 叶 = tag；host 是第一段，name 是中间段（最后一段 name）
      if (nextRel.length < 3) continue
      const tag = nextRel[nextRel.length - 1]
      const base = nextRel[nextRel.length - 2]
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(dir, e.name), 'utf8'))
      } catch {
        continue
      }
      const layers = Array.isArray(manifest?.layers) ? manifest.layers : []
      const modelLayers = layers.filter(
        (l) => typeof l === 'object' && l !== null && l.mediaType === OLLAMA_MODEL_LAYER && typeof l.digest === 'string' && l.digest !== '',
      )
      if (modelLayers.length === 0) continue
      const first = join(blobsDir, String(modelLayers[0].digest).replace(':', '-'))
      if (!(await isFile(first))) continue
      if (!(await isGgufPath(first))) continue // adapter / 非 GGUF 权重，跳过
      const display = `${base}:${tag}`
      found.push({
        kind: 'ollama',
        source: 'ollama',
        base,
        id: deriveId(`${base}-${tag}`),
        name: display,
        path: first,
        manifestRef: nextRel.join('/'),
        sizeBytes: modelLayers.reduce((acc, l) => acc + (Number(l.size) || 0), 0),
        serveBin: llamaBin,
        serveKind: llamaBin ? 'llama-server' : null,
        ...(EMBEDDING_NAME_RE.test(base) ? { embedding: true } : {}),
      })
    }
  }

  await visit(manifestsDir, [])
  // 同一权重 blob 的多个 tag 折叠为一个条目：代表取「最短 base，再最短 tag」
  // （minicpm5:2b-q8_0 优于 minicpm5-2b-108k:latest），其余 tag 进 extraTags 展示。
  const byBlob = new Map()
  for (const c of found) {
    const hit = byBlob.get(c.path)
    if (hit) hit.all.push(c)
    else byBlob.set(c.path, { ...c, all: [c] })
  }
  const grouped = []
  for (const g of byBlob.values()) {
    const rep = [...g.all].sort((a, b) =>
      a.base.length !== b.base.length
        ? a.base.length - b.base.length
        : a.name < b.name ? -1 : 1,
    )[0]
    grouped.push({
      ...rep,
      id: deriveId(`${rep.base}-${rep.name.slice(rep.name.lastIndexOf(':') + 1)}`),
      extraTags: g.all.map((x) => x.name).filter((n) => n !== rep.name),
    })
  }
  return grouped.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** entry → API 侧模型名（登记表 modelId 优先，缺省 id） */
const modelIdOf = (e) => String(e.modelId ?? e.id)

/** entry → 展示名（剥 ollama host 前缀 / 取路径末段） */
function displayNameOf(e) {
  const raw = modelIdOf(e)
  const stripped = raw.startsWith('hf.co/') ? raw.slice(6) : raw
  const tail = stripped.split('/').pop() ?? stripped
  return tail === '' ? String(e.id) : tail
}

const apiBaseOf = (e) =>
  (typeof e.apiBase === 'string' && e.apiBase.trim() !== '' ? e.apiBase.trim() : `http://127.0.0.1:${e.port}/v1`)

/** bash -c 同步跑探测命令（与 core.js defaultSpawn 同形，超时 SIGKILL） */
function runProbe(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { out += d })
    const finish = (code) => { clearTimeout(timer); resolve({ code, output: out.trim(), timedOut }) }
    proc.on('close', (code) => finish(code ?? -1))
    proc.on('error', (err) => { out += String(err); finish(-1) })
  })
}

async function detectBackends() {
  const run = await runProbe(PULL_PROBE_CMD, PULL_PROBE_TIMEOUT_MS)
  return new Set(run.output.split('\n').map((x) => x.trim()).filter((x) => x !== ''))
}

/**
 * 服务工厂。ctx 仅用于：emit / get('configEditor') / fiber.entry（保存配置）。
 * 返回 { semantics, adapter, handleRequest, watchRegistry, afterMutation, initialProbe }。
 */
export function createLocalLlmService({ ctx, registryPath }) {
  const sem = createSemantics({ registryPath })
  /** id → { up, why, models } 探活缓存（catalog 只读缓存，UI list 时刷新） */
  const status = new Map()

  // ---------- 登记表读取（结构化，供 UI 与 catalog；复用 core 的解析器） ----------

  async function readEntries() {
    let text
    try {
      text = await readFile(registryPath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return { state: 'missing' }
      return { state: 'error', message: `登记表不可读（${registryPath}）：${err instanceof Error ? err.message : String(err)}` }
    }
    let raw
    try {
      raw = parseRegistryYaml(text)
    } catch (err) {
      return { state: 'error', message: `登记表不是合法 YAML（${registryPath}）：${err instanceof Error ? err.message : String(err)}` }
    }
    const entries = []
    for (let i = 0; i < raw.models.length; i++) {
      const e = raw.models[i]
      const bad = lightValidate(e, i)
      entries.push(bad ? { ...e, _invalid: bad } : e)
    }
    return { state: 'ok', entries }
  }

  /** 轻校验（目录展示面）：必填 id/runtime/port + port 范围；错误标注在条目上不抛 */
  function lightValidate(e, i) {
    const at = `models.${i}`
    if (typeof e.id !== 'string' || e.id.length < 1 || e.id.length > 64) return `${at}.id 缺失或超长`
    if (e.runtime !== 'docker' && e.runtime !== 'native') return `${at}.runtime 须为 docker|native`
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) return `${at}.port 须为 1-65535 整数`
    return null
  }

  // ---------- 探活（GET /v1/models） ----------

  async function probeEntry(e) {
    try {
      const res = await fetch(`${apiBaseOf(e)}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!res.ok) return { up: false, why: `HTTP ${res.status}` }
      const json = await res.json().catch(() => null)
      const models = Array.isArray(json?.data)
        ? json.data.map((m) => (typeof m?.id === 'string' ? m.id : null)).filter((s) => !!s).slice(0, 5)
        : undefined
      // 端口被别的模型占用时不应报「运行中」——条目探的是自己的 alias/modelId
      const expect = String(e.modelId ?? e.id)
      if (Array.isArray(models) && models.length > 0 && !models.includes(expect)) {
        return { up: false, why: `端口 ${e.port} 在服务其他模型（${models.join(', ')}）——本条目未启动` }
      }
      return { up: true, models }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { up: false, why: msg.toLowerCase().includes('refused') ? '连接拒绝（未启动）' : msg.slice(0, 80) }
    }
  }

  async function probeAll(entries) {
    await Promise.all(entries.filter((e) => !e._invalid).map(async (e) => {
      status.set(e.id, await probeEntry(e))
    }))
  }

  async function initialProbe() {
    const reg = await readEntries()
    if (reg.state === 'ok') await probeAll(reg.entries)
    // catalogCache 一并刷新：Composer 在 UI 未打开时也可能直接调本地模型，
    // resolveModelInfo/streamLocal 都读这份同步缓存——启动即就位。
    await refreshCatalogCache()
  }

  // ---------- catalog（GUI 模型目录：成员资格即选择面；未运行 → warning badge） ----------

  function catalogModel(e) {
    const st = status.get(e.id)
    const up = st?.up === true
    return {
      provider: PROVIDER_ID,
      id: modelIdOf(e),
      name: displayNameOf(e),
      ...(up ? {} : {
        badge: {
          text: { en: 'Not running', zh: '未运行' },
          tone: 'warning',
        },
      }),
      _entry: e,
    }
  }

  async function catalog() {
    const reg = await readEntries()
    if (reg.state !== 'ok') return []
    return reg.entries.filter((e) => !e._invalid).map(catalogModel)
  }

  function findEntryByModel(model) {
    // 同步查找：以最近一次读取为准（stream 路径不能等 fs）——登记表变更由
    // watcher 刷新 cache；未命中即报错，报文指向本地模型页。
    return catalogCache.find((c) => c.id === model)?._entry
  }

  let catalogCache = []

  async function refreshCatalogCache() {
    catalogCache = await catalog()
    return catalogCache
  }

  // ---------- 模型元数据 ----------

  function resolveModelInfo(model) {
    const entry = findEntryByModel(model)
    if (!entry) {
      throw new Error(`local-llm: 没有已登记的本地模型 "${model}"——在 设置 → 本地模型 页查看登记表，或先用 local-llm-pull 拉取`)
    }
    return {
      provider: PROVIDER_ID,
      id: model,
      name: displayNameOf(entry),
      inputModalities: ['text'],
      context: { contextWindow: Number.isInteger(entry.ctx) && entry.ctx > 0 ? entry.ctx : 32768 },
      defaultMaxTokens: 4096,
    }
  }

  // ---------- OpenAI 兼容 wire（chat/completions SSE → StreamChunk） ----------

  function textOf(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }

  function buildPayload(options, entry) {
    const messages = []
    if (typeof options.system === 'string' && options.system !== '') {
      messages.push({ role: 'system', content: options.system })
    }
    for (const m of options.messages ?? []) {
      switch (m.role) {
        case 'system':
        case 'developer':
          messages.push({ role: 'system', content: textOf(m.content) })
          break
        case 'user':
          messages.push({ role: 'user', content: textOf(m.content) })
          break
        case 'assistant': {
          const text = textOf(m.content)
          const toolCalls = (Array.isArray(m.content) ? m.content : [])
            .filter((b) => b && b.type === 'tool-call')
            .map((b) => ({
              id: String(b.id),
              type: 'function',
              function: { name: String(b.name ?? ''), arguments: typeof b.arguments === 'string' && b.arguments !== '' ? b.arguments : '{}' },
            }))
          if (toolCalls.length > 0) messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
          else messages.push({ role: 'assistant', content: text })
          break
        }
        case 'tool':
          messages.push({ role: 'tool', tool_call_id: String(m.toolCallId ?? ''), content: textOf(m.content) })
          break
        default:
          break // 未知 role 防御性跳过
      }
    }
    const payload = { model: modelIdOf(entry), messages, stream: true, stream_options: { include_usage: true } }
    if (options.tools?.length) {
      payload.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    if (options.temperature !== undefined) payload.temperature = options.temperature
    if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens
    if (options.stop?.length) payload.stop = options.stop
    return payload
  }

  function wireFinish(finishReason) {
    if (finishReason === 'length') return { kind: 'max-tokens' }
    if (finishReason === 'tool_calls') return { kind: 'tool-calls' }
    return { kind: 'stop' }
  }

  async function* streamLocal(options) {
    const entry = findEntryByModel(options.model)
    if (!entry) {
      throw new Error(`local-llm: 没有已登记的本地模型 "${options.model}"——在 设置 → 本地模型 页查看登记表`)
    }
    const base = apiBaseOf(entry)
    let res
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify(buildPayload(options, entry)),
        signal: options.signal,
      })
    } catch (err) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
        return
      }
      throw new Error(`local-llm: 无法连接 ${base}（${err instanceof Error ? err.message : String(err)}）——模型可能未部署，在 设置 → 本地模型 页部署后再试`, { cause: err })
    }
    if (!res.ok || res.body == null) {
      const detail = (await res.text().catch(() => '')).slice(0, 400)
      const code = res.status === 401 || res.status === 403 ? 'AUTH' : res.status >= 500 ? 'SERVER' : 'TRANSPORT'
      // 附 failure 快照：LlmRuntime.normalizeLlmFailure 优先读取 error.failure，
      // 消费面按稳定 code 路由（AUTH/SERVER/TRANSPORT），不解析报文。
      const err = new Error(`local-llm: 本地端点返回 HTTP ${res.status}（${base}）${detail ? `：${detail}` : ''}`)
      err.failure = Object.freeze({ message: err.message, code })
      throw err
    }
    // —— 流式翻译状态机 ——
    let nextIndex = 0
    let open = null // { index, blockType: 'text'|'reasoning', text }
    const tools = new Map() // wire tool index → { index, id, name, args }
    let usage = null
    let finishReason = null

    function* closeOpen() {
      if (open) {
        yield {
          type: 'block-end',
          index: open.index,
          block: open.blockType === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
        }
        open = null
      }
    }

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunkBytes of res.body) {
        if (options.signal?.aborted) break
        buffer += decoder.decode(chunkBytes, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { buffer = ''; break }
          let evt
          try { evt = JSON.parse(data) } catch { continue }
          const u = evt?.usage
          if (u && typeof u === 'object') {
            usage = {
              inputTokens: Number(u.prompt_tokens ?? 0) || 0,
              outputTokens: Number(u.completion_tokens ?? 0) || 0,
              ...(u.total_tokens !== undefined ? { totalTokens: Number(u.total_tokens) || 0 } : {}),
            }
          }
          const choice = Array.isArray(evt?.choices) && evt.choices.length > 0 ? evt.choices[0] : null
          if (choice?.finish_reason) finishReason = String(choice.finish_reason)
          const delta = choice?.delta
          if (!delta) continue
          const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta.reasoning === 'string' ? delta.reasoning : ''
          const text = typeof delta.content === 'string' ? delta.content : ''
          if (text !== '') {
            if (open?.blockType !== 'text') {
              yield* closeOpen()
              open = { index: nextIndex++, blockType: 'text', text: '' }
              yield { type: 'block-start', index: open.index, blockType: 'text' }
            }
            open.text += text
            yield { type: 'text-delta', index: open.index, text }
          }
          if (reasoning !== '') {
            if (open?.blockType !== 'reasoning') {
              yield* closeOpen()
              open = { index: nextIndex++, blockType: 'reasoning', text: '' }
              yield { type: 'block-start', index: open.index, blockType: 'reasoning' }
            }
            open.text += reasoning
            yield { type: 'reasoning-delta', index: open.index, text: reasoning }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (tc === null || typeof tc !== 'object') continue
              const wi = Number.isInteger(tc.index) ? tc.index : tools.size
              let t = tools.get(wi)
              if (!t) {
                yield* closeOpen()
                t = { index: nextIndex++, id: typeof tc.id === 'string' && tc.id !== '' ? tc.id : `call_${wi}`, name: '', args: '' }
                tools.set(wi, t)
                yield { type: 'block-start', index: t.index, blockType: 'tool-call' }
              }
              if (typeof tc.id === 'string' && tc.id !== '' && t.id !== tc.id) t.id = tc.id
              const fnName = typeof tc.function?.name === 'string' ? tc.function.name : ''
              if (fnName !== '' && t.name === '') t.name = fnName
              const argsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''
              if (argsDelta !== '') t.args += argsDelta
              yield {
                type: 'tool-call-delta',
                index: t.index,
                id: t.id,
                ...(t.name !== '' ? { name: t.name } : {}),
                argumentsDelta: argsDelta,
              }
            }
          }
        }
        if (buffer === '' && options.signal?.aborted) break
      }
    } catch (err) {
      yield* closeOpen()
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
        return
      }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `local-llm: 流读取中断（${err instanceof Error ? err.message : String(err)}）`, code: 'TRANSPORT' } },
      }
      return
    }
    yield* closeOpen()
    for (const t of tools.values()) {
      yield {
        type: 'block-end',
        index: t.index,
        block: { type: 'tool-call', id: t.id, name: t.name, arguments: t.args === '' ? '{}' : t.args },
      }
    }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: wireFinish(finishReason) }
  }

  // ---------- 变更广播 ----------

  async function afterMutation() {
    await initialProbe()
    await refreshCatalogCache()
    ctx?.emit?.('llm/models-updated', PROVIDER_ID)
  }

  // ---------- 登记表 watcher（agent 侧 pull 写表 / 手工编辑同样驱动目录刷新） ----------

  function watchRegistry() {
    let watcher = null
    let timer = null
    try {
      watcher = watch(dirname(registryPath), { persistent: false }, (_event, file) => {
        if (file && file !== basename(registryPath)) return
        clearTimeout(timer)
        timer = setTimeout(() => { void afterMutation() }, 400)
      })
    } catch {
      return () => {} // 目录不存在（登记表未建）——pull 首次建表后经重启/操作刷新
    }
    return () => { clearTimeout(timer); watcher?.close() }
  }

  // ---------- Web 桥（POST /api/dsh-local-llm，{ method, args } JSON） ----------

  async function rpcList() {
    const reg = await readEntries()
    if (reg.state === 'missing') {
      return { available: false, registryPath, models: [], hint: 'missing' }
    }
    if (reg.state === 'error') {
      return { available: false, registryPath, models: [], error: reg.message }
    }
    await probeAll(reg.entries)
    await refreshCatalogCache()
    return {
      available: true,
      registryPath,
      models: reg.entries.map((e) => {
        const st = status.get(e.id)
        return {
          id: e.id,
          runtime: e.runtime,
          port: e.port,
          ctx: e.ctx ?? null,
          modelId: modelIdOf(e),
          apiBase: apiBaseOf(e),
          hasStart: typeof e.start === 'string' && e.start !== '',
          hasStop: typeof e.stop === 'string' && e.stop !== '',
          note: e.note ?? null,
          source: e.source ?? null,
          invalid: e._invalid ?? null,
          up: st?.up === true,
          why: st?.why ?? null,
          probedModels: st?.models ?? null,
        }
      }),
    }
  }

  async function rpcPreview(args) {
    const parsed = parseModelSource(String(args?.source ?? ''))
    const id = deriveId(parsed.repo)
    const downloadDir = join(dirname(registryPath), 'models', id)
    const installed = await detectBackends()
    let plan = null
    let planError = null
    try {
      plan = pickPullPlan(parsed, installed, { dir: downloadDir })
    } catch (err) {
      planError = err instanceof Error ? err.message : String(err)
    }
    return {
      ok: true,
      canonical: parsed.canonical,
      hub: parsed.hub,
      repo: parsed.repo,
      tag: parsed.tag ?? null,
      file: parsed.file ?? null,
      id,
      downloadDir,
      installed: [...installed],
      plan,
      planError,
    }
  }

  async function rpcPull(args) {
    const input = parsePullInput(args ?? {})
    if (!input.ok) return { ok: false, message: input.message }
    const result = await sem.pull(input.value)
    if (result?.ok) await afterMutation()
    return result
  }

  async function rpcLifecycle(args, phase) {
    const result = await (phase === 'start' ? sem.start({ id: args?.id }) : sem.stop({ id: args?.id }))
    await afterMutation()
    if (phase === 'start' && result?.ok) schedulePostStartReprobe()
    // stop 不看 ok：进程退出慢时探活仍 200 → ok=false（「可能未生效」）恰恰是常态，
    // 此刻最需要延迟复核把状态翻过来
    if (phase === 'stop') schedulePostStopReprobe()
    return result
  }

  async function rpcSetModelsDir(args) {
    const dir = String(args?.dir ?? '')
    if (dir === '') return { ok: false, message: '目录为空' }
    const st = await stat(dir).catch(() => null)
    if (st === null || !st.isDirectory()) return { ok: false, message: `目录不存在或不可读：${dir}` }
    const entry = ctx?.fiber?.entry
    const editor = ctx?.get?.('configEditor')
    if (entry === undefined || editor === undefined) {
      return { ok: false, message: '当前宿主没有 configEditor——请在 cordis.patch.yml 手工设置本插件 config.registryPath' }
    }
    const nextPath = join(dir, 'local-models.yaml')
    await editor.edit(entry, (current) => ({
      ...(typeof current === 'object' && current !== null ? current : {}),
      registryPath: nextPath,
    }))
    return { ok: true, registryPath: nextPath }
  }

  // ---------- V2.1：目录扫描 + 一键登记 ----------

  async function rpcScan(args) {
    const requested = typeof args?.dir === 'string' && args.dir.trim() !== '' ? args.dir.trim() : dirname(registryPath)
    const st = await stat(requested).catch(() => null)
    if (st === null || !st.isDirectory()) {
      return { ok: false, message: `目录不存在或不可读：${requested}`, dir: requested }
    }
    const [dirCandidates, ollamaCandidates] = await Promise.all([
      scanDirectory(requested),
      scanOllamaStore(requested),
    ])
    const candidates = [
      ...dirCandidates.map((c) => ({ ...c, source: 'dir' })),
      ...ollamaCandidates,
    ]
    return {
      ok: true,
      dir: requested,
      candidates,
      extraSources: ollamaCandidates.length > 0
        ? [{ kind: 'ollama', dir: OLLAMA_MODELS_DIR, count: ollamaCandidates.length }]
        : [],
    }
  }

  /** 登记表原子写（与 core.js defaultWriteFile 同形：tmp+rename，父目录递归建） */
  async function writeRegistryFile(entries) {
    const text = serializeRegistry(entries)
    const tmp = `${registryPath}.tmp-${process.pid}-${Date.now()}`
    await mkdir(dirname(registryPath), { recursive: true })
    await writeFile(tmp, text)
    await rename(tmp, registryPath)
  }

  function buildEntryFromCandidate(c, port) {
    const bin = typeof c.serveBin === 'string' && c.serveBin !== ''
      ? c.serveBin
      : (c.kind === 'hf-dir' ? 'vllm' : 'llama-server')
    if (bin.includes("'")) throw new Error(`推理后端路径含单引号，登记表子集无法安全引用：${bin}`)
    if (String(c.path).includes("'")) throw new Error(`模型路径含单引号，登记表子集无法安全引用：${c.path}`)
    const entry = { id: String(c.id), runtime: 'native', port }
    // 服务进程必须与宿主进程树脱离：前台命令会让 llama-server 成为宿主的子进程，
    // 插件重载/宿主清理时被连带杀掉（服务「莫名消失」的根因）。
    // 形态要点：mkdir 用 `;` 分隔（macOS bash 3.2 下 `A && B &` 的复合 list 后台化
    // 会让主 bash wait 整个异步 subshell，永不返回）；单命令 & 则立即退出（实测 ~5ms）。
    // nohup + 后台 + 日志落盘 → bash 立即退出，服务被 launchd 收养，生命周期独立。
    const logDir = join(dirname(registryPath), '.local-models-logs')
    const logPath = join(logDir, `${c.id}.log`)
    if (logPath.includes("'")) throw new Error(`日志路径含单引号，登记表子集无法安全引用：${logPath}`)
    const detach = (cmd) => `mkdir -p '${logDir}'; nohup ${cmd} > '${logPath}' 2>&1 &`
    if (c.kind === 'gguf' || c.kind === 'ollama') {
      entry.modelId = String(c.id)
      entry.start = detach(`${bin} -m '${c.path}' --host 127.0.0.1 --port ${port} -c 16384 -np 1 --jinja --alias ${c.id}${c.embedding ? ' --embeddings' : ''}`)
      entry.stop = `pkill -f 'llama-server.*--port ${port}'`
    } else {
      entry.modelId = String(c.id)
      entry.start = detach(`${bin} serve '${c.path}' --host 127.0.0.1 --port ${port} --served-model-name ${c.id}`)
      entry.stop = `pkill -f 'vllm serve.*--port ${port}'`
    }
    entry.note = c.kind === 'ollama'
      ? `Ollama 模型库登记（${c.name}${c.embedding ? '，嵌入模型' : ''}${Array.isArray(c.extraTags) && c.extraTags.length > 0 ? `，同权重另有 ${c.extraTags.length} 个 tag` : ''}）——服务后台独立运行，日志：${logPath}`
      : `目录扫描登记（${c.kind === 'gguf' ? 'GGUF' : 'HF 整仓'}：${c.name}）——服务后台独立运行，日志：${logPath}`
    return entry
  }

  /** 本机 127.0.0.1 试绑探测端口空闲（瞬时绑定即关，窗口极短） */
  function portFree(p) {
    return new Promise((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
  }

  /** 登记端口分配：候选被登记表其他条目或本机现有监听占用时自 port 起顺延找空闲 */
  async function allocatePort(preferred, usedPorts) {
    const used = usedPorts instanceof Set ? usedPorts : new Set(usedPorts)
    const start = Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535 ? preferred : 8081
    for (let p = start; p <= Math.min(start + 40, 65535); p++) {
      if (used.has(p)) continue
      if (await portFree(p)) return p
    }
    return null
  }

  async function rpcRegisterEntry(args) {
    const c = args?.candidate
    if (typeof c !== 'object' || c === null) return { ok: false, message: 'candidate 缺失' }
    const kind = c.kind === 'gguf' || c.kind === 'hf-dir' || c.kind === 'ollama' ? c.kind : null
    if (kind === null) return { ok: false, message: `candidate.kind 不合法：${String(c.kind)}` }
    const path = typeof c.path === 'string' ? c.path : ''
    if (path === '' || !path.startsWith('/')) return { ok: false, message: `candidate.path 不合法：${path}` }
    // 路径存在性 + 类型复核（客户端回传的对象不可尽信）
    const st = await stat(path).catch(() => null)
    if (st === null) return { ok: false, message: `路径不存在：${path}` }
    if (kind === 'ollama') {
      // ollama blob 是内容寻址的改名 GGUF——不看扩展名，验魔数
      if (!st.isFile() || !(await isGgufPath(path))) {
        return { ok: false, message: `不是有效的 GGUF 权重 blob：${path}` }
      }
    } else if (kind === 'gguf' && (!st.isFile() || !path.toLowerCase().endsWith('.gguf'))) {
      return { ok: false, message: `不是 GGUF 文件：${path}` }
    }
    if (kind === 'hf-dir' && (!st.isDirectory() || !(await dirHas(path, 'config.json')))) {
      return { ok: false, message: `不是 HF 整仓目录（缺 config.json）：${path}` }
    }
    const reg = await readEntries()
    if (reg.state === 'error') return { ok: false, message: `${reg.error}\n登记不覆盖损坏的登记表——修好后再试。` }
    const entries = reg.state === 'ok' ? reg.entries.filter((e) => !e._invalid) : []
    const id = typeof c.id === 'string' && c.id !== '' ? c.id : deriveId(String(c.name ?? 'model'))
    if (entries.some((e) => e.id === id)) {
      return { ok: false, message: `登记表已有 id "${id}"——换 id 或先清理登记表。已登记：${entries.map((e) => e.id).join(', ') || '（空）'}` }
    }
    // 端口分配：与登记表其他条目或本机现有监听冲突时自动顺延（否则两个条目同端口，
    // 启动其一后探活会污染另一条目的运行状态）
    const usedPorts = new Set(entries.map((e) => e.port).filter((p) => Number.isInteger(p)))
    const port = await allocatePort(args?.port, usedPorts)
    if (port === null) {
      return { ok: false, message: `无法分配端口：${Number(args?.port) || 8081} 起 41 个端口均被登记表条目或本机监听占用` }
    }
    let entry
    try {
      entry = buildEntryFromCandidate({ ...c, id }, port)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    try {
      await writeRegistryFile([...entries, entry])
    } catch (err) {
      return { ok: false, message: `登记表写入失败：${err instanceof Error ? err.message : String(err)}` }
    }
    await afterMutation()
    return { ok: true, message: `已登记 "${id}"（port ${port}）。部署：设置页或 Composer 就绪后可用。`, id, port }
  }

  const METHODS = {
    list: () => rpcList(),
    preview: (args) => rpcPreview(args),
    pull: (args) => rpcPull(args),
    deploy: (args) => rpcLifecycle(args, 'start'),
    stop: (args) => rpcLifecycle(args, 'stop'),
    setModelsDir: (args) => rpcSetModelsDir(args),
    scan: (args) => rpcScan(args),
    registerEntry: (args) => rpcRegisterEntry(args),
  }

  /** Remote/桥公共分发面：method 必须是 METHODS 实名（fail-closed，不猜）。 */
  async function rpcInvoke(method, params) {
    const fn = Object.hasOwn(METHODS, String(method)) ? METHODS[String(method)] : null
    if (fn === null) return { ok: false, message: `未知方法 "${String(method)}"（支持：${Object.keys(METHODS).join('/')}）` }
    return fn(params ?? {})
  }

  function handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    // 同源守卫：带 Origin 的请求必须指向本服务 host（防跨站页驱动本机下载/启停）
    const origin = req.headers.origin
    const host = req.headers.host
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) {
          res.writeHead(403)
          res.end()
          return
        }
      } catch {
        res.writeHead(403)
        res.end()
        return
      }
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let rpc = null
      try { rpc = JSON.parse(body === '' ? '{}' : body) } catch { rpc = null }
      const fn = rpc && typeof rpc.method === 'string' ? METHODS[rpc.method] : undefined
      let payload
      if (fn === undefined) {
        payload = { ok: false, message: `未知方法（支持：${Object.keys(METHODS).join('/')}）` }
      } else {
        try {
          payload = await fn(rpc.args ?? {})
        } catch (err) {
          payload = { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload ?? { ok: false, message: '空响应' }))
    })
  }

  // ---------- V2：原生目录条目 + 端点发现面（设置-模型 的「Local models」行） ----------

  /** 本插件在用户设置文档里的命名空间（whole-section profile：settingsPath = []） */
  const DIRECTORY_NS = 'dsh-local-llm'

  /** 探测任意 baseURL 的 /v1/models（发现面草稿查询；无 /v1 后缀时补试一次） */
  async function probeModelsAt(baseURL, signal) {
    const trim = String(baseURL).replace(/\/+$/, '')
    const candidates = [`${trim}/models`, ...(trim.endsWith('/v1') ? [] : [`${trim}/v1/models`])]
    for (const url of candidates) {
      try {
        const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        if (!res.ok) continue
        const json = await res.json().catch(() => null)
        if (Array.isArray(json?.data)) {
          return json.data
            .map((m) => (typeof m?.id === 'string' && m.id !== '' ? { id: m.id } : null))
            .filter((m) => m !== null)
        }
      } catch {
        if (signal?.aborted) return []
      }
    }
    return []
  }

  /**
   * 目录条目 + 发现面。返回 disposer（两者一并撤销）。
   * 条目为 whole-section provider（settingsPath = []，与 DeepSeek 同形态）——
   * 设置-模型 渲染「Local models」行；无已注册设置 schema 时页面按不可编辑行呈现。
   */
  function registerDirectory(llm) {
    const handle = llm.registerConfigurableProviders([
      {
        provider: PROVIDER_ID,
        displayName: 'Local models',
        settingsNs: DIRECTORY_NS,
        settingsPath: [],
      },
    ])
    const disposeDiscovery = llm.registerModelDiscovery(DIRECTORY_NS, async (request, signal) => {
      // 草稿带了 baseURL（添加流程的端点探测）→ 直接问端点；否则按登记表作答
      // （adapter 已知的模型从登记表答，不发网络请求——与 pi-ai 同策略）。
      if (typeof request.baseURL === 'string' && request.baseURL !== '') {
        return probeModelsAt(request.baseURL, signal)
      }
      const reg = await readEntries()
      if (reg.state !== 'ok') return []
      await probeAll(reg.entries)
      return reg.entries
        .filter((e) => !e._invalid)
        .map((e) => ({
          id: modelIdOf(e),
          name: displayNameOf(e),
          ...(Number.isInteger(e.ctx) && e.ctx > 0 ? { contextWindow: e.ctx } : {}),
        }))
    })
    return () => {
      disposeDiscovery()
      handle()
    }
  }

  // ---------- V2：运行状态周期复核（badge 真实性：外部崩溃 up→down、
  // start 探活窗口内没加载完的模型 down→up，两个方向都要抓） ----------

  async function reprobeRunning() {
    const reg = await readEntries()
    if (reg.state !== 'ok') return
    const live = reg.entries.filter((e) => !e._invalid)
    if (live.length === 0) return
    let flipped = false
    await Promise.all(live.map(async (e) => {
      const was = status.get(e.id)
      const st = await probeEntry(e)
      status.set(e.id, st)
      if (was?.up !== st.up) flipped = true
    }))
    if (flipped) await afterMutation()
  }

  /** start 后模型加载超过探活窗口（2.5s）很常见——追加短周期复核让 Composer 徽标尽快翻绿 */
  function schedulePostStartReprobe() {
    for (const delayMs of [5000, 15000, 30000]) {
      const timer = setTimeout(() => { void reprobeRunning() }, delayMs)
      timer.unref?.()
    }
  }

  /** stop 后进程退出是异步的（pkill 信号 → 权重清理需数秒）——stop 瞬间探活仍 200，
   *  UI 会停在「运行中」；短周期复核在进程死透后翻转状态并广播。 */
  function schedulePostStopReprobe() {
    for (const delayMs of [1200, 3000, 8000]) {
      const timer = setTimeout(() => { void reprobeRunning() }, delayMs)
      timer.unref?.()
    }
  }

  return {
    semantics: sem,
    registryPath,
    adapter: {
      providerInfo: () => ({ id: PROVIDER_ID, name: 'Local models' }),
      providerRetryPolicy: () => undefined,
      // —— 契约核对（@deepseek-ai/dsh-llm LlmAdapter 抽象类全方法面）——
      // plain-object adapter 鸭子调用没有基类默认实现兜底：imageRequestPricing /
      // imageRequestTarget 缺席时 runtime 切模型压缩上下文/token 计量直接 TypeError
      // （MODEL_SWITCH_COMPACTION_FAILED）。语义照抄基类默认：
      // 本地文本模型不声明图片定价（undefined → consumer 走中性估算）；
      // 图片目标默认保留归一化尺寸。
      imageRequestPricing: (_provider, _model) => undefined,
      imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
      listModels: async () => {
        const reg = await readEntries()
        if (reg.state !== 'ok') return []
        return reg.entries.filter((e) => !e._invalid).map((e) => {
          const st = status.get(e.id)
          const up = st?.up === true
          return {
            provider: PROVIDER_ID,
            id: modelIdOf(e),
            name: displayNameOf(e),
            ...(up ? {} : { badge: { text: { en: 'Not running', zh: '未运行' }, tone: 'warning' } }),
          }
        })
      },
      resolveModel: async (_provider, model) => resolveModelInfo(model),
      prepareCall: async (_provider, model) => ({ model: resolveModelInfo(model), stream: streamLocal }),
      stream: (options) => streamLocal(options),
    },
    handleRequest,
    watchRegistry,
    afterMutation,
    initialProbe,
    registerDirectory,
    reprobeRunning,
    schedulePostStartReprobe,
    schedulePostStopReprobe,
    rpcInvoke,
    DIRECTORY_NS,
    WEB_PATH,
  }
}
