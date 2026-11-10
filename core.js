// dsh-local-llm 语义核（自包含 in-child 执行）。
//
// 本机无头本地 LLM 桥的五元语义单点：登记表真源读取/子集解析/复验、
// /v1/models 探活、启停命令执行护栏、OpenAI 兼容问答截断、HF/魔搭模型源
// 解析与拉取登记（236号 local-llm-pull）。宿主零回调——
// 全部逻辑随本包走，任何 dsh 宿主（桌面壳/服务器）装上即用。
//
// 零依赖纪律（可分享前提）：不引 yaml/zod——登记表按契约子集手写解析
// （顶 models: + 条目平铺标量；注释/引号串/整数；锚点/流式/嵌套不支持=显式报错），
// 复验手写。登记格式全文与迁移见插件 README。
//
// keyless 纪律：全部副作用（fs/fetch/spawn/sleep）经 createSemantics 注入，纯函数直测。

import { readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename, mkdir as fsMkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 探活超时（/v1/models，本地回环——2.5s 足够区分「在跑」与「没起」） */
const PROBE_TIMEOUT_MS = 2500
/** 启停命令执行超时（docker run -d 本地镜像秒回；含拉镜像场景宁超时报清也不挂死） */
const CMD_TIMEOUT_MS = 120_000
/** 命令输出回显上限 */
const OUTPUT_CAP = 4000
/** call 回复截断上限（字符） */
const REPLY_CAP = 30000
/** start 后探活窗口：最多 10 次 × 2s ≈ 18s（vLLM 类冷加载超窗则提示稍后复核） */
const START_PROBE_ATTEMPTS = 10
const START_PROBE_INTERVAL_MS = 2000
/** stop 后退出窗口：最多 6 次 × 1.5s ≈ 9s（权重卸载通常数秒内完成） */
const STOP_PROBE_ATTEMPTS = 6
const STOP_PROBE_INTERVAL_MS = 1500

/** 登记表路径（env DSH_LOCAL_MODELS_REGISTRY 覆盖；缺省 ~/.dsh/local-models.yaml，显式 HOME 优先） */
export function resolveRegistryPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const env = process.env.DSH_LOCAL_MODELS_REGISTRY?.trim()
  if (env) return env
  const home = process.env.HOME || homedir()
  return join(home, '.dsh', 'local-models.yaml')
}

// ---------- 登记表子集解析（fail-closed，不支持即报错不猜） ----------

/** 剥行尾注释：引号外的 ` #` 起视为注释（登记表命令值含裸 # 罕见，引号内 # 保留） */
function stripComment(line) {
  let inS = false, inD = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inD) inS = !inS
    else if (ch === '"' && !inS) inD = !inD
    else if (ch === '#' && !inS && !inD && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i)
  }
  return line
}

/** 标量解析：引号串原样剥引号；裸整数转 number；其余记字符串（true/false 不转布尔——宽容向） */
function parseScalar(raw, where) {
  const v = raw.trim()
  if (v === '') throw new Error(`${where}：空值`)
  if ((v.startsWith("'") && v.endsWith("'") && v.length >= 2) || (v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
    return v.slice(1, -1)
  }
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === 'true' || v === 'false' || v === 'null' || v === '~') {
    throw new Error(`${where}：裸 true/false/null 不是字符串——请加引号（本解析器为登记格式子集，不支持 YAML 布尔）`)
  }
  if (v.startsWith('[') || v.startsWith('{') || v.startsWith('&') || v.startsWith('*') || v.startsWith('|') || v.startsWith('>')) {
    throw new Error(`${where}：不支持的 YAML 形态（流式/锚点/块标量不在登记格式子集内）——字段须为平铺标量`)
  }
  return v
}

/**
 * 登记表文本 → { models: object[] }。子集：顶层级仅 `models:`，条目为
 * `- key: value` 起头 + 同缩进 `key: value` 续行；注释/空行任意。越子集即抛错
 * （带行号），坏结构交给 validateRegistry 报字段级错误。
 */
export function parseRegistryYaml(text) {
  const lines = String(text).split(/\r?\n/)
  const entries = []
  let inModels = false
  let entryIndent = -1
  let entry = null
  const pushEntry = () => { if (entry) entries.push(entry) }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = stripComment(lines[i])
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const where = `第 ${i + 1} 行`
    if (!inModels) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
      if (!m) throw new Error(`${where}：期待顶层键 models:，得到 "${line.trim()}"`)
      if (m[1] !== 'models') throw new Error(`${where}：顶层仅支持 models:（得到 "${m[1]}"，登记格式子集）`)
      if (m[2].trim() !== '') throw new Error(`${where}：models: 须为列表（行内值不支持）`)
      inModels = true
      continue
    }
    const item = line.match(/^(\s*)-\s+(.*)$/)
    if (item) {
      // entryIndent 无须哨兵复位：下一行即按本条目缩进重定（-1 赋值属死代码，lint 清零批删）
      if (indent < entryIndent) { pushEntry(); entry = null }
      if (entry) { pushEntry(); entry = null }
      entryIndent = item[1].length
      entry = {}
      const first = item[2]
      if (first.trim() !== '') {
        const kv = first.match(/^([\w-]+):\s*(.*)$/)
        if (!kv) throw new Error(`${where}：列表项首段须为 "key: value"，得到 "${first.trim()}"`)
        entry[kv[1]] = parseScalar(kv[2], where)
      }
      continue
    }
    if (entry === null) throw new Error(`${where}：models: 下须为 "- key: value" 列表项，得到 "${line.trim()}"`)
    if (indent <= entryIndent) throw new Error(`${where}：顶层出现第二个键 "${line.trim()}"——仅支持 models:（登记格式子集）`)
    const kv = line.match(/^\s*([\w-]+):\s*(.*)$/)
    if (!kv) throw new Error(`${where}：条目字段须为 "key: value"，得到 "${line.trim()}"`)
    entry[kv[1]] = parseScalar(kv[2], where)
  }
  pushEntry()
  if (!inModels) throw new Error('缺少顶层键 models:')
  return { models: entries }
}

// ---------- 复验（字段约束逐条对应登记格式，见插件 README） ----------

const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max
const int = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function validateEntry(e, i) {
  const at = `models.${i}`
  if (!str(e.id, 1, 64)) return `${at}.id: 须为 1-64 字符字符串`
  if (e.runtime !== 'docker' && e.runtime !== 'native') return `${at}.runtime: 须为 docker|native`
  if (!int(e.port, 1, 65535)) return `${at}.port: 须为 1-65535 整数`
  if (e.ctx !== undefined && !int(e.ctx, 1, 10_000_000)) return `${at}.ctx: 须为正整数`
  if (e.modelId !== undefined && !str(e.modelId, 1, 200)) return `${at}.modelId: 须为 1-200 字符字符串`
  if (e.apiBase !== undefined && !str(e.apiBase, 1, 500)) return `${at}.apiBase: 须为 ≤500 字符字符串`
  if (e.start !== undefined && !str(e.start, 1, 2000)) return `${at}.start: 须为 1-2000 字符命令（超长命令请写脚本后登记脚本调用）`
  if (e.stop !== undefined && !str(e.stop, 1, 2000)) return `${at}.stop: 须为 1-2000 字符命令`
  if (e.note !== undefined && !str(e.note, 1, 500)) return `${at}.note: 须为 ≤500 字符`
  if (e.source !== undefined && !str(e.source, 1, 500)) return `${at}.source: 须为 ≤500 字符字符串（local-llm-pull 登记的模型来源）`
  for (const k of Object.keys(e)) {
    if (!['id', 'runtime', 'port', 'ctx', 'modelId', 'apiBase', 'start', 'stop', 'note', 'source'].includes(k)) {
      return `${at}.${k}: 未知字段（支持 id/runtime/port/ctx/modelId/apiBase/start/stop/note/source）`
    }
  }
  return null
}

/** 入参复验（工具 execute 内再验一道，agent 传参不合法即时报） */
export function parseStartStopInput(raw) {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '参数不合法：须为对象' }
  if (!str(raw.id, 1, 64) || typeof raw.id !== 'string') return { ok: false, message: '参数不合法：id 须为 1-64 字符字符串' }
  return { ok: true, value: { id: raw.id } }
}

export function parseCallInput(raw) {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '参数不合法：须为对象' }
  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 64) return { ok: false, message: '参数不合法：id 须为 1-64 字符字符串' }
  if (typeof raw.prompt !== 'string' || raw.prompt.length < 1 || raw.prompt.length > 32768) return { ok: false, message: '参数不合法：prompt 须为 1-32768 字符' }
  if (raw.system !== undefined && (typeof raw.system !== 'string' || raw.system.length > 8192)) return { ok: false, message: '参数不合法：system 须为 ≤8192 字符' }
  const maxTokens = raw.maxTokens ?? 2048
  if (!int(maxTokens, 16, 16384)) return { ok: false, message: '参数不合法：maxTokens 须为 16-16384 整数（缺省 2048）' }
  const timeoutMs = raw.timeoutMs ?? 120000
  if (!int(timeoutMs, 1000, 600000)) return { ok: false, message: '参数不合法：timeoutMs 须为 1000-600000 整数毫秒（缺省 120000）' }
  return { ok: true, value: { id: raw.id, prompt: raw.prompt, system: raw.system, maxTokens, timeoutMs } }
}

// ---------- 模型源解析与拉取计划（local-llm-pull，236号） ----------

/** 安全段白名单：字母/数字（含 Unicode）/._-，起点须为字母数字——禁 shell 元字符/空白/点段穿越 */
const SAFE_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u
const SOURCE_CAP = 500
/** 站点 → hub 映射（裸 www. 前缀先剥） */
const HUB_HOSTS = { 'huggingface.co': 'hf', 'hf.co': 'hf', 'hf-mirror.com': 'hf', 'modelscope.cn': 'ms' }
const RESOLVE_WORDS = new Set(['resolve', 'blob', 'tree'])

/** 单段白名单校验（fail-closed——下载命令由解析产物拼装，元字符在这里就死） */
function safeSegment(s, where) {
  if (!SAFE_SEGMENT.test(s) || s === '.' || s === '..') {
    throw new Error(`${where} "${s}" 含不安全字符（仅限字母/数字/._-，禁 shell 元字符、空白与 .. 穿越）`)
  }
  return s
}

/** 仓库内文件路径校验：每段过白名单（允许子目录），返回原样 */
function safeFilePath(file) {
  const parts = String(file).split('/')
  for (const p of parts) safeSegment(p, 'file 路径段')
  return parts.join('/')
}

/** hub 侧 URL 路径解析：{org}/{name}[:TAG][/resolve|blob|tree/{branch}[/{file...}]] */
function parseHubPath(hub, path) {
  if (path.includes('?') || path.includes('#')) throw new Error('URL 含查询串/锚点——不支持，请给纯模型地址')
  const segs = path.split('/').filter((x) => x !== '')
  if (hub === 'ms' && segs[0] === 'models') segs.shift()
  const ri = segs.findIndex((x) => RESOLVE_WORDS.has(x))
  let repoSegs = segs
  let file = null
  if (ri >= 0) {
    repoSegs = segs.slice(0, ri)
    const rest = segs.slice(ri + 1)
    if (rest.length === 0) throw new Error('URL 缺 resolve 后的分支段（如 /resolve/main/...）')
    if (rest.length > 1) file = safeFilePath(rest.slice(1).join('/'))
  }
  if (repoSegs.length !== 2) throw new Error('URL 路径须为 {org}/{name} 两段（不识别 release/docs 等非模型页）')
  const org = safeSegment(repoSegs[0], 'org')
  // hf 的 {name}:TAG 形态（ollama）——先拆 tag 再过白名单（':' 不在 SAFE_SEGMENT 内）
  let rawName = repoSegs[1]
  let tag = null
  if (hub === 'hf') {
    const tm = rawName.match(/^(.+):([\p{L}\p{N}][\p{L}\p{N}._-]*)$/u)
    if (tm) { rawName = tm[1]; tag = safeSegment(tm[2], 'tag') }
  }
  const name = safeSegment(rawName, 'name')
  return {
    hub,
    repo: `${org}/${name}`,
    ...(file ? { file } : {}),
    ...(tag ? { tag } : {}),
    canonical: `${hub}:${org}/${name}${tag ? `:${tag}` : ''}`,
  }
}

/**
 * 模型源解析（纯函数，可直测）：HF/魔搭 URL（huggingface.co/hf.co/hf-mirror.com/
 * modelscope.cn，含 /resolve|/blob|/tree 单文件路径）、hf:/ms: 前缀简写、
 * ollama 形态 hf.co/org/name:TAG、裸 org/name（缺省 hub=hf——报文注明可加 ms:）。
 * 返回 { hub, repo, file?, tag?, canonical }；canonical 可再喂回本函数（不含 file）。
 */
export function parseModelSource(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('source 须为非空字符串（HF/魔搭 URL 或 org/name 形态）')
  const original = raw.trim()
  if (original.length > SOURCE_CAP) throw new Error(`source 超 ${SOURCE_CAP} 字符`)
  let s = original
  let hub = null
  const pref = s.match(/^(hf|ms):/)
  if (pref) { hub = pref[1]; s = s.slice(pref[0].length) }
  const url = s.match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[\w-]+)(\/.*)$/)
  if (url) {
    const host = url[1].toLowerCase().replace(/^www\./, '')
    const mapped = HUB_HOSTS[host]
    if (!mapped) throw new Error(`不认识的站点 "${url[1]}"——支持 huggingface.co/hf.co/hf-mirror.com/modelscope.cn，或用 hf:/ms: 前缀简写`)
    if (hub && hub !== mapped) throw new Error(`前缀 ${hub}: 与站点 ${host} 不一致`)
    return parseHubPath(mapped, url[2])
  }
  // 非 URL：org/name[:TAG]
  const ci = s.lastIndexOf(':')
  let tag = null
  if (ci > 0) {
    tag = safeSegment(s.slice(ci + 1), 'tag')
    s = s.slice(0, ci)
  }
  const parts = s.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error('模型 id 须为 org/name 两段——或加 hf:/ms: 前缀，或给完整 URL')
  }
  const org = safeSegment(parts[0], 'org')
  const name = safeSegment(parts[1], 'name')
  hub = hub ?? 'hf'
  const repo = `${org}/${name}`
  return { hub, repo, ...(tag ? { tag } : {}), canonical: `${hub}:${repo}${tag ? `:${tag}` : ''}` }
}

/** id 派生：org/name → org-name（非法字符折叠为 -，截 64） */
export function deriveId(repo) {
  const folded = repo.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 64)
  const id = folded.replace(/^-+/, '').replace(/-+$/, '')
  return id || 'model'
}

/** pull 入参复验 */
export function parsePullInput(raw) {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '参数不合法：须为对象' }
  if (typeof raw.source !== 'string' || raw.source.length < 1 || raw.source.length > SOURCE_CAP) return { ok: false, message: `参数不合法：source 须为 1-${SOURCE_CAP} 字符字符串` }
  if (raw.id !== undefined && (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 64)) return { ok: false, message: '参数不合法：id 须为 1-64 字符字符串' }
  // id 会拼进下载目录（join …/models/<id>）、bash -c 双引号 --local-dir 插值与登记表
  // start 命令序列化——整体过 safeSegment 白名单（P0 命令注入收口：fail-closed 拒绝，不静默清洗）
  if (raw.id !== undefined) {
    try {
      safeSegment(raw.id, 'id')
    } catch (err) {
      return {
        ok: false,
        message: `参数不合法：${err instanceof Error ? err.message : String(err)}——id 会拼进下载目录与登记的启停命令，不能含 shell 元字符；缺省 id 由模型名派生（如 org/name → org-name），通常无需手填`,
      }
    }
  }
  if (raw.file !== undefined && (typeof raw.file !== 'string' || raw.file.length < 1 || raw.file.length > 300)) return { ok: false, message: '参数不合法：file 须为 1-300 字符字符串' }
  if (raw.backend !== undefined && !['ollama', 'hf', 'modelscope'].includes(raw.backend)) return { ok: false, message: '参数不合法：backend 须为 ollama|hf|modelscope' }
  if (raw.mirror !== undefined && typeof raw.mirror !== 'boolean') return { ok: false, message: '参数不合法：mirror 须为布尔' }
  if (raw.port !== undefined && !int(raw.port, 1, 65535)) return { ok: false, message: '参数不合法：port 须为 1-65535 整数' }
  const timeoutMs = raw.timeoutMs ?? 600_000
  if (!int(timeoutMs, 1000, 3_600_000)) return { ok: false, message: '参数不合法：timeoutMs 须为 1000-3600000 整数毫秒（缺省 600000）' }
  return { ok: true, value: { source: raw.source, id: raw.id, file: raw.file, backend: raw.backend, mirror: raw.mirror, port: raw.port, timeoutMs } }
}

/**
 * 拉取计划（纯决策，可直测）：parsed=parseModelSource 产物、installed=探测到的
 * CLI/后端集合、opts={backend?, mirror?, dir}。返回 { kind, cmd, serve, modelId?, cli? }；
 * 通道不可满足即抛错（带安装指引）。决策表：
 *   GGUF（tag 或 .gguf 文件）∧ ollama 在装 → ollama pull（须有 tag）
 *   否则按 hub：hf → hf CLI（hf 优先于 legacy huggingface-cli）、ms → modelscope CLI
 *   serve 建议：GGUF 文件 → llama-server 在装则用；整仓 → vllm 在装则用；否则 null
 */
export function pickPullPlan(parsed, installed, opts = {}) {
  const isGguf = (typeof parsed.file === 'string' && parsed.file.toLowerCase().endsWith('.gguf')) || !!parsed.tag
  const hfBin = installed.has('hf') ? 'hf' : installed.has('huggingface-cli') ? 'huggingface-cli' : null
  const dir = opts.dir
  const envPrefix = opts.mirror && parsed.hub === 'hf' ? 'HF_ENDPOINT=https://hf-mirror.com ' : ''
  const wantOllama = opts.backend === 'ollama' || (opts.backend === undefined && isGguf && installed.has('ollama'))
  if (wantOllama) {
    if (!installed.has('ollama')) throw new Error('backend=ollama 但本机未探测到 ollama——安装：https://ollama.com/download')
    if (!parsed.tag) throw new Error('ollama 通道需要 quant 标签（如 hf:org/name:Q4_K_M）——补标签，或改 backend=hf 用 hf CLI 单文件下载')
    return { kind: 'ollama-pull', cmd: `ollama pull hf.co/${parsed.repo}:${parsed.tag}`, serve: 'ollama', modelId: `hf.co/${parsed.repo}:${parsed.tag}` }
  }
  const fileArg = parsed.file ? ` "${parsed.file}"` : ''
  if (opts.backend === 'modelscope' || (opts.backend === undefined && parsed.hub === 'ms')) {
    if (parsed.hub !== 'ms') throw new Error('backend=modelscope 不能拉 HF 模型——改 backend=hf')
    if (!installed.has('modelscope')) throw new Error('未探测到 modelscope CLI——安装：pip install -U modelscope')
    return { kind: 'cli-download', cmd: `modelscope download --model ${parsed.repo}${fileArg} --local-dir "${dir}"`, cli: 'modelscope', serve: parsed.file && isGguf && installed.has('llama-server') ? 'llama-server' : !parsed.file && installed.has('vllm') ? 'vllm' : null }
  }
  // 缺省/显式 hf
  if (parsed.hub !== 'hf') throw new Error('backend=hf 不能拉魔搭模型——改 backend=modelscope')
  if (!hfBin) throw new Error('未探测到 hf CLI——安装：pip install -U "huggingface_hub[cli]"（中国网络建议 mirror: true 走 hf-mirror.com，或改用魔搭源）')
  return { kind: 'cli-download', cmd: `${envPrefix}${hfBin} download ${parsed.repo}${fileArg} --local-dir "${dir}"`, cli: hfBin, serve: parsed.file && isGguf && installed.has('llama-server') ? 'llama-server' : !parsed.file && installed.has('vllm') ? 'vllm' : null }
}

/**
 * 登记表序列化（解析子集的发射端，与 parseRegistryYaml 互逆）：条目首键起
 * `  - `，续键同缩进；字符串一律双引号包裹、数字裸写。含双引号/换行的值
 * 直接抛错（子集无转义机制，fail-closed 不产坏表）。
 */
export function serializeRegistry(entries) {
  const out = ['models:']
  for (const e of entries) {
    const keys = Object.keys(e)
    if (keys.length === 0) throw new Error('空条目不能序列化')
    keys.forEach((k, i) => {
      const val = e[k]
      let rendered
      if (typeof val === 'number') rendered = String(val)
      else if (typeof val === 'string') {
        if (val.includes('"') || /\r|\n/.test(val)) throw new Error(`字段 ${k} 含双引号/换行——登记格式子集无转义，请改写该值`)
        rendered = `"${val}"`
      } else throw new Error(`字段 ${k} 类型不合法（${typeof val}，仅支持字符串/整数）`)
      out.push(`${i === 0 ? '  - ' : '    '}${k}: ${rendered}`)
    })
  }
  return `${out.join('\n')}\n`
}

// ---------- Node 默认执行器（child 进程内；测试经注入替换） ----------

/** bash -c 同步跑登记的命令，超时 SIGKILL，stdout/stderr 合并截断（pull 用更长窗口） */
export function defaultSpawn(cmd, timeoutMs = CMD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { out += d })
    const finish = (code) => {
      clearTimeout(timer)
      const merged = out.trim()
      resolve({
        code,
        output: merged.length > OUTPUT_CAP ? `${merged.slice(0, OUTPUT_CAP)}\n…（输出截断至 ${OUTPUT_CAP} 字符）` : merged,
        timedOut,
      })
    }
    proc.on('close', (code) => finish(code ?? -1))
    proc.on('error', (err) => { out += String(err); finish(-1) })
  })
}

const defaultSleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** 登记表原子写（tmp+rename，父目录递归建——pull 引导建表时 ~/.dsh 可能不存在） */
async function defaultWriteFile(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await fsMkdir(dirname(path), { recursive: true })
  await fsWriteFile(tmp, content)
  await fsRename(tmp, path)
}

// ---------- 五元语义（返回 {ok, message}——插件 OUTPUT 契约） ----------

/** pull 通道探测：一条命令列出在装的 CLI/后端（输出行即集合） */
const PULL_PROBE_CMD = 'for b in ollama hf huggingface-cli modelscope llama-server vllm; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done'
const PULL_PROBE_BINS = new Set(['ollama', 'hf', 'huggingface-cli', 'modelscope', 'llama-server', 'vllm'])
const PULL_PROBE_TIMEOUT_MS = 5000

/**
 * 语义工厂。注入面：readFile(path)→string（ENOENT 抛 code）、writeFileImpl(path,content)
 * （pull 登记写面；缺省 tmp+rename 原子写）、fetchImpl、
 * spawnImpl(cmd,timeoutMs)→{code,output,timedOut}、sleepImpl(ms)。缺省 Node 全套。
 */
export function createSemantics(opts = {}) {
  const registryPath = opts.registryPath ?? resolveRegistryPath()
  const doFetch = opts.fetchImpl ?? fetch
  const doSpawn = opts.spawnImpl ?? defaultSpawn
  const doSleep = opts.sleepImpl ?? defaultSleep
  const doReadFile = opts.readFileImpl ?? fsReadFile
  const doWriteFile = opts.writeFileImpl ?? defaultWriteFile

  const unavailable = () => ({
    ok: false,
    message:
      `local-llm 工具不可用：本机小模型登记表（${registryPath}）不存在。` +
      `本工具管理本机上的无头本地模型（端口/上下文窗口/启停命令登记在案），登记格式与迁移见插件 README。`,
  })

  /** 读+解析登记表：ENOENT → null（可用门）；损坏 → 带 path 的错误串 */
  async function readRegistry() {
    let text
    try {
      text = await doReadFile(registryPath)
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      return { error: `登记表不可读（${registryPath}）：${err instanceof Error ? err.message : String(err)}` }
    }
    let raw
    try {
      raw = parseRegistryYaml(text)
    } catch (err) {
      return { error: `登记表不是合法 YAML（${registryPath}）：${err instanceof Error ? err.message : String(err)}。修好后重试，无需重启。` }
    }
    for (let i = 0; i < raw.models.length; i++) {
      const bad = validateEntry(raw.models[i], i)
      if (bad) return { error: `登记表结构不合法（${registryPath}）：${bad}。每条须含 id/runtime/port，登记格式与迁移见插件 README。` }
    }
    return { entries: raw.models }
  }

  const apiBaseOf = (e) => (typeof e.apiBase === 'string' && e.apiBase.trim() !== '' ? e.apiBase.trim() : `http://127.0.0.1:${e.port}/v1`)

  /** GET /v1/models 探活：200 → up + 模型名清单；其余 → down + 原因短语 */
  async function probe(e) {
    try {
      const res = await doFetch(`${apiBaseOf(e)}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!res.ok) return { up: false, why: `HTTP ${res.status}` }
      const json = await res.json().catch(() => null)
      const models = Array.isArray(json?.data)
        ? json.data.map((m) => (typeof m?.id === 'string' ? m.id : null)).filter((s) => !!s).slice(0, 5)
        : undefined
      return { up: true, models }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { up: false, why: msg.toLowerCase().includes('refused') ? '连接拒绝（未启动？）' : msg.slice(0, 80) }
    }
  }

  const notFound = (entries, id) => ({
    ok: false,
    message: `登记表里没有 "${id}"。已登记：${entries.map((e) => e.id).join(', ') || '（空）'}。`,
  })

  async function list() {
    const reg = await readRegistry()
    if (reg === null) return unavailable()
    if (reg.error) return { ok: false, message: reg.error }
    const probed = await Promise.all(reg.entries.map(async (e) => ({ e, p: await probe(e) })))
    const lines = probed.map(({ e, p }) => {
      const bits = [p.up ? '● 在跑' : '○ 未跑', e.runtime, `127.0.0.1:${e.port}`]
      if (e.ctx) bits.push(`ctx=${e.ctx}`)
      bits.push(`model=${e.modelId ?? e.id}`)
      if (p.models?.length) bits.push(`探得:${p.models.join(',')}`)
      if (!p.up && p.why && p.why !== '连接拒绝（未启动？）') bits.push(`（${p.why}）`)
      if (e.note) bits.push(`—— ${e.note}`)
      return `- ${e.id}  ${bits.join(' | ')}`
    })
    const upCount = probed.filter((x) => x.p.up).length
    const header =
      `本地小模型登记表（${registryPath}）：${reg.entries.length} 条，${upCount} 个在跑` +
      (reg.entries.length === 0 ? '\n（登记表为空——把模型登记进去后本工具即可启停/问答，登记格式见插件 README）' : '')
    return {
      ok: true,
      message: `${header}\n${lines.join('\n')}\n启停：local-llm-start / local-llm-stop（id）；单段问答分包：local-llm-call（id + prompt）；拉模型：local-llm-pull（HF/魔搭地址）。`,
    }
  }

  /** 启停公共体：查条目 → 执行命令 → 探活复核 → 报告 */
  async function runLifecycle(raw, phase) {
    const reg = await readRegistry()
    if (reg === null) return unavailable()
    if (reg.error) return { ok: false, message: reg.error }
    const input = parseStartStopInput(raw)
    if (!input.ok) return { ok: false, message: input.message }
    const entry = reg.entries.find((e) => e.id === input.value.id)
    if (!entry) return notFound(reg.entries, input.value.id)
    const cmd = entry[phase]
    if (!cmd) {
      return { ok: false, message: `条目 "${entry.id}" 未登记 ${phase} 命令（登记表加 ${phase}: "..." 即可，登记格式见插件 README）。` }
    }
    const run = await doSpawn(cmd)
    if (run.timedOut) {
      return {
        ok: false,
        message: `${phase} 命令超 ${CMD_TIMEOUT_MS / 1000}s 已终止（${entry.id}）。命令：${cmd}\n输出尾部：\n${run.output || '（无输出）'}\n可能是拉镜像/加载权重超过窗口——确认后用 local-llm-list 复核状态。`,
      }
    }
    // 探活复核：start 等待冷加载窗口（多次重试）；stop 也留退出窗口
    // （pkill 发信号 → 进程清权重退出需数秒，立即探活必仍 200 误报「未生效」）
    let final = await probe(entry)
    const attempts = phase === 'start' ? START_PROBE_ATTEMPTS : STOP_PROBE_ATTEMPTS
    const interval = phase === 'start' ? START_PROBE_INTERVAL_MS : STOP_PROBE_INTERVAL_MS
    const wantUp = phase === 'start'
    if (final.up !== wantUp) {
      for (let i = 1; i < attempts; i++) {
        await doSleep(interval)
        final = await probe(entry)
        if (final.up === wantUp) break
      }
    }
    const cmdLine = `${phase}（${entry.id}）exit=${run.code}${run.output ? `\n命令输出：\n${run.output}` : ''}`
    if (phase === 'start') {
      return final.up
        ? { ok: true, message: `${cmdLine}\n探活：● 在跑（${apiBaseOf(entry)}${final.models?.length ? `，模型 ${final.models.join(',')}` : ''}）` }
        : { ok: true, message: `${cmdLine}\n探活：仍不可达（${final.why}）。命令成功但服务未监听——可能在加载权重/端口不符，稍后 local-llm-list 复核。` }
    }
    return final.up
      ? { ok: false, message: `${cmdLine}\n探活：仍在跑（${apiBaseOf(entry)}）——stop 命令可能未生效，检查登记表的 stop 命令。` }
      : { ok: true, message: `${cmdLine}\n探活：○ 已停` }
  }

  async function start(raw) { return runLifecycle(raw, 'start') }
  async function stop(raw) { return runLifecycle(raw, 'stop') }

  async function call(raw) {
    const reg = await readRegistry()
    if (reg === null) return unavailable()
    if (reg.error) return { ok: false, message: reg.error }
    const input = parseCallInput(raw)
    if (!input.ok) return { ok: false, message: input.message }
    const entry = reg.entries.find((e) => e.id === input.value.id)
    if (!entry) return notFound(reg.entries, input.value.id)
    const messages = [
      ...(input.value.system ? [{ role: 'system', content: input.value.system }] : []),
      { role: 'user', content: input.value.prompt },
    ]
    let res
    try {
      res = await doFetch(`${apiBaseOf(entry)}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: entry.modelId ?? entry.id, messages, max_tokens: input.value.maxTokens }),
        signal: AbortSignal.timeout(input.value.timeoutMs),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const hint = msg.toLowerCase().includes('refused')
        ? `连接拒绝——${entry.id} 可能没启动。先 local-llm-list 看状态，或 local-llm-start 启动。`
        : msg.includes('abort') || msg.includes('timeout') || msg.toLowerCase().includes('timed out')
          ? `请求超时（${input.value.timeoutMs}ms）——本地模型慢是常态，可加大 timeoutMs，或改把会话模型切到本地小模型。`
          : `请求失败：${msg.slice(0, 200)}`
      return { ok: false, message: hint }
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500)
      return { ok: false, message: `本地模型端点返回 HTTP ${res.status}（${apiBaseOf(entry)}）：\n${body}` }
    }
    const json = await res.json().catch(() => null)
    // 思考型模型（qwen3/minicpm5 系）紧 max_tokens 时 content 可为空、文本全在
    // message.reasoning（2026-10-14 真机冒烟实录）——reasoning 回退产出而非判异常
    const msg0 = json?.choices?.[0]?.message
    const content = typeof msg0?.content === 'string' ? msg0.content : ''
    const reasoning = typeof msg0?.reasoning === 'string' ? msg0.reasoning : ''
    if (content === '' && reasoning === '') {
      return { ok: false, message: `端点 200 但回复形状异常（无 choices[0].message.content）：${JSON.stringify(json ?? null).slice(0, 500)}` }
    }
    const finish = json?.choices?.[0]?.finish_reason
    const truncated = finish === 'length'
    const reply = content !== '' ? content : `（模型未产出正式回复（可能 max_tokens 太紧，思考已占满）——思考过程节选：）\n${reasoning}`
    const body = reply.length > REPLY_CAP ? `${reply.slice(0, REPLY_CAP)}\n…（回复截断至 ${REPLY_CAP} 字符）` : reply
    const lengthHint = truncated ? `\n（finish_reason=length：被 max_tokens=${input.value.maxTokens} 截断，需要完整回复可加大）` : ''
    const usage = json?.usage
    const usageLine = usage ? `\n\n---\n用量：prompt ${usage.prompt_tokens ?? '?'} / completion ${usage.completion_tokens ?? '?'} tokens` : ''
    return { ok: true, message: `${body}${lengthHint}${usageLine}` }
  }

  /** 下载失败提示（按通道分流：认证/镜像/网络） */
  function pullFailureHint(plan) {
    if (plan.kind === 'ollama-pull') return '排查：ollama serve 是否在跑、quant 标签是否存在于该仓库 GGUF 文件列表。'
    if (plan.cli === 'modelscope') return '排查：模型名是否正确（modelscope.cn 可搜）、网络可达性。'
    return '排查：HTTP 401/403 = 门控模型需 HF_TOKEN（export 后重试）；中国网络可加 mirror: true 走 hf-mirror.com。'
  }

  /**
   * local-llm-pull（236号）：解析 HF/魔搭模型源 → 通道探测 → CLI 下载（可续传）
   * → 自动登记（含 start/stop 生成）。写面：网络下载 + GB 级磁盘写 + 登记表写
   * ——面层过 ask 审批门。登记表不存在时可引导建表；损坏则拒绝写（不覆盖坏表）。
   */
  async function pull(raw) {
    const input = parsePullInput(raw)
    if (!input.ok) return { ok: false, message: input.message }
    const v = input.value
    let parsed
    try {
      parsed = parseModelSource(v.source)
    } catch (err) {
      return { ok: false, message: `source 解析失败：${err instanceof Error ? err.message : String(err)}` }
    }
    if (v.file) {
      try {
        const file = safeFilePath(v.file)
        parsed = { ...parsed, file }
      } catch (err) {
        return { ok: false, message: `file 不合法：${err instanceof Error ? err.message : String(err)}` }
      }
    }
    const reg = await readRegistry()
    if (reg !== null && reg.error) return { ok: false, message: `${reg.error}\npull 不覆盖损坏的登记表——修好后再拉。` }
    const entries = reg === null ? [] : reg.entries
    const id = v.id ?? deriveId(parsed.repo)
    // 纵深防御：parsePullInput 已过白名单，downloadDir/--local-dir/登记表 start 序列化
    // 前兜底再验（deriveId 回归或未来绕过 parsePullInput 的调用面，同样 fail-closed）
    try {
      safeSegment(id, 'id')
    } catch (err) {
      return { ok: false, message: `参数不合法：${err instanceof Error ? err.message : String(err)}` }
    }
    if (entries.some((e) => e.id === id)) {
      return { ok: false, message: `登记表已有 id "${id}"——pull 不覆盖既有条目：换 id，或先手工清理登记表。已登记：${entries.map((e) => e.id).join(', ')}。` }
    }
    const downloadDir = join(dirname(registryPath), 'models', id)
    let installed
    try {
      const probeRun = await doSpawn(PULL_PROBE_CMD, PULL_PROBE_TIMEOUT_MS)
      installed = new Set(probeRun.output.split('\n').map((x) => x.trim()).filter((x) => PULL_PROBE_BINS.has(x)))
    } catch (err) {
      return { ok: false, message: `通道探测失败：${err instanceof Error ? err.message : String(err)}` }
    }
    let plan
    try {
      plan = pickPullPlan(parsed, installed, { backend: v.backend, mirror: v.mirror, dir: downloadDir })
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    const run = await doSpawn(plan.cmd, v.timeoutMs)
    if (run.timedOut) {
      return {
        ok: false,
        message: `下载超 ${Math.round(v.timeoutMs / 1000)}s 已中断——大模型属常态，直接重跑本工具续传（${plan.kind === 'ollama-pull' ? 'ollama' : plan.cli} 支持断点续传），或加大 timeoutMs。\n命令：${plan.cmd}\n输出尾部：\n${run.output || '（无输出）'}`,
      }
    }
    if (run.code !== 0) {
      return {
        ok: false,
        message: `下载失败 exit=${run.code}（${plan.kind === 'ollama-pull' ? 'ollama pull' : plan.cli}）。\n输出尾部：\n${run.output || '（无输出）'}\n${pullFailureHint(plan)}`,
      }
    }
    // 条目装配：ollama=守护进程面（11434 固定）；llama-server=GGUF 文件 serve；vllm=整仓 serve
    const entry = { id, runtime: 'native', port: plan.serve === 'ollama' ? 11434 : (v.port ?? 8081) }
    if (plan.serve === 'ollama') {
      entry.modelId = plan.modelId
      entry.note = 'ollama 守护进程面（通常已自起，pull 即部署）'
    } else if (plan.serve === 'llama-server') {
      entry.modelId = parsed.file.split('/').pop()
      entry.start = `llama-server -m '${downloadDir}/${parsed.file}' --host 127.0.0.1 --port ${entry.port} -c 4096`
      entry.stop = `pkill -f 'llama-server.*--port ${entry.port}'`
    } else if (plan.serve === 'vllm') {
      entry.modelId = downloadDir
      entry.start = `vllm serve '${downloadDir}' --host 127.0.0.1 --port ${entry.port}`
      entry.stop = `pkill -f 'vllm serve.*--port ${entry.port}'`
    } else {
      entry.note = '未探测到推理后端（llama-server/vllm）——登记表补 start/stop 后可用 local-llm-start'
    }
    entry.source = parsed.canonical
    let text
    try {
      text = serializeRegistry([...entries, entry])
    } catch (err) {
      return { ok: false, message: `登记条目序列化失败（未写登记表）：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      await doWriteFile(registryPath, text)
    } catch (err) {
      return { ok: false, message: `登记表写入失败（下载内容已在 ${downloadDir}）：${err instanceof Error ? err.message : String(err)}` }
    }
    const dl = plan.kind === 'ollama-pull' ? 'ollama 已拉取并加载' : `已下载到 ${downloadDir}`
    const serveLine = plan.serve === 'ollama'
      ? 'ollama 守护进程在跑即可直接 local-llm-call'
      : plan.serve
        ? `已生成 start/stop（${plan.serve}）——local-llm-start ${id} 启动（过审批门）`
        : '未探测到推理后端——登记表补 start/stop 后可 local-llm-start'
    return {
      ok: true,
      message: `${dl}，已登记条目 "${id}"（source=${entry.source}${entry.modelId ? `，model=${entry.modelId}` : ''}，port ${entry.port}）。\n${serveLine}\n${plan.kind === 'ollama-pull' ? '命令' : '下载命令'}：${plan.cmd}${run.output ? `\n输出尾部：\n${run.output}` : ''}`,
    }
  }

  return { list, start, stop, call, pull, registryPath }
}
