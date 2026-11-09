// dsh-local-llm — 本机无头本地 LLM 的登记/探活/启停/问答/拉取五元工具 dsh 插件
// （V1：+ 设置页 Web 桥 + provider 注册——部署后的本地模型进入 Composer 模型选择）。
//
// 语义核在本包 core.js（登记表真源读取/子集解析/探活/启停命令执行护栏/问答截断/
// HF·魔搭模型源解析与拉取登记）；host-service.js 提供 V1 的 adapter（OpenAI 兼容
// wire）+ 探活缓存 + /api/dsh-local-llm 桥 + 登记表 watcher。零宿主包 import。
//
// 审批门（写面 ask）：local-llm-start / local-llm-stop / local-llm-pull 每次
// 人工批准（agent 路径）；UI 路径的授权 = 用户在设置页的点击 + 每次下载前的
// 确认框（client.js），不经会话审批面。list/call 免审。

import { createSemantics, resolveRegistryPath } from './core.js'
import { createLocalLlmService, PROVIDER_ID } from './host-service.js'

export const name = 'dsh-local-llm'
export const inject = ['tools']

// Config：不声明 schema（裸函数不是 Loader 期望的 schemastery 面，激活即崩——已实测）。
// registryPath 的校验在 apply 内完成：非字符串/空串按缺省处理；用户经设置页
// setModelsDir 写入的值来自原生目录选择器且再经目录存在性校验。

/** 需过审批门的写面实名（start/stop 执行登记的启停 shell 命令；pull 网络下载+登记写）。 */
const GATED_TOOLS = new Set(['local-llm-start', 'local-llm-stop', 'local-llm-pull'])

/** 审批门文案（实名 → 中英 reason） */
const GATE_COPY = {
  'local-llm-start': {
    zh: '启动登记表里的本地小模型（执行其登记的 shell 启停命令，影响本机进程）',
    en: 'Start a registered local LLM (runs its shell start/stop command). Approve?',
  },
  'local-llm-stop': {
    zh: '停掉登记表里的本地小模型（执行其登记的 shell 启停命令，影响本机进程）',
    en: 'Stop a registered local LLM (runs its shell start/stop command). Approve?',
  },
  'local-llm-pull': {
    zh: '从 HF/魔搭下载模型到本机（网络下载+GB 级磁盘写入）并自动写入登记表',
    en: 'Download a model from Hugging Face / ModelScope (network + multi-GB disk write) and register it. Approve?',
  },
}

/** 审批门决策核（纯函数，keyless 单测面）：start/stop/pull 一律 ask；list/call 不干预。 */
export function decideLocalLlmGate(exec) {
  if (typeof exec?.name !== 'string' || !GATED_TOOLS.has(exec.name)) return null
  const copy = GATE_COPY[exec.name]
  return {
    kind: 'ask',
    reason: `dsh-local-llm: ${copy.zh}`,
    displayReason: { en: copy.en },
  }
}

/** 五工具 canonical value 的输出面（ok/message 双字段 + 文本渲染）。 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
    required: ['ok', 'message'],
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

/** 实名 → 语义方法（一一对应，无泛化面）。 */
const OP_OF = {
  'local-llm-list': 'list',
  'local-llm-start': 'start',
  'local-llm-stop': 'stop',
  'local-llm-call': 'call',
  'local-llm-pull': 'pull',
}

/** 改变目录状态的操作（成功后广播 llm/models-updated，Composer/设置页即时重载）。 */
const MUTATING_OPS = new Set(['start', 'stop', 'pull'])

/** @param {Context} ctx @param {unknown} config */
export function apply(ctx, config) {
  const cfg = (typeof config === 'object' && config !== null) ? config : {}
  const cfgPath = typeof cfg.registryPath === 'string' && cfg.registryPath.trim() !== '' ? cfg.registryPath.trim() : undefined
  const registryPath = resolveRegistryPath(cfgPath)
  const sem = createSemantics({ registryPath })
  const svc = createLocalLlmService({ ctx, registryPath })

  ctx.on('tools/pre-execute', async (exec, next) => {
    return decideLocalLlmGate(exec) ?? next()
  })

  const registerTool = (name, description, parameters) => {
    ctx.tools.register({
      name,
      description,
      parameters,
      output: OUTPUT,
      async execute(args) {
        const result = await sem[OP_OF[name]](args)
        if (result?.ok === true && MUTATING_OPS.has(OP_OF[name])) {
          // agent 侧启停/拉取成功同样驱动模型目录刷新（选择器/设置页重载）
          try { await svc.afterMutation() } catch { /* 目录广播失败不影响工具结果 */ }
          // start/stop 后模型加载/退出都超过探活窗口——短周期复核让徽标及时翻转
          if (OP_OF[name] === 'start') {
            try { svc.schedulePostStartReprobe?.() } catch { /* 复核失败不影响工具结果 */ }
          }
          if (OP_OF[name] === 'stop') {
            try { svc.schedulePostStopReprobe?.() } catch { /* 复核失败不影响工具结果 */ }
          }
        }
        return result
      },
    })
  }

  registerTool('local-llm-list',
    '查看本机登记的无头本地小模型清单与实时状态：谁在跑、端口、上下文窗口、docker 还是原生、API 模型名。数据源是登记表 ~/.dsh/local-models.yaml（端口/启停命令等登记在案——忘记端口或怎么起的先查这里）。只读免审。',
    { type: 'object', properties: {}, additionalProperties: false })

  registerTool('local-llm-start',
    '启动登记表里的一个本地小模型（执行其登记的 start 命令，如 docker run / nohup serve），启动后自动探活确认。写面过审批门。快速切换 = stop 当前 + start 目标。',
    {
      type: 'object',
      properties: { id: { type: 'string', description: '登记表条目 id（local-llm-list 给出）' } },
      required: ['id'],
      additionalProperties: false,
    })

  registerTool('local-llm-stop',
    '停掉登记表里的一个本地小模型（执行其 stop 命令，如 docker rm -f），停后探活确认。写面过审批门。',
    {
      type: 'object',
      properties: { id: { type: 'string', description: '登记表条目 id（local-llm-list 给出）' } },
      required: ['id'],
      additionalProperties: false,
    })

  registerTool('local-llm-call',
    '把一段 prompt 发给登记表里的本地小模型（OpenAI 兼容 chat/completions），拿回文本回复——大模型编排、小模型干活的廉价分包面（整理文档/初步 review/分类摘要等）。长任务不要用它轮询续跑：把会话模型直接切到本地小模型（Composer 模型选择里的「Local models」组，或设置页 API 配置 baseURL 指向本地端口）更合适。',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: '登记表条目 id（local-llm-list 给出）' },
        prompt: { type: 'string', description: '要发给本地模型的完整 prompt（1-32768 字符）' },
        system: { type: 'string', description: '可选 system 提示' },
        maxTokens: { type: 'number', description: '回复 token 上限（默认 2048，上限 16384）' },
        timeoutMs: { type: 'number', description: '超时毫秒（默认 120000，上限 600000）——本地模型慢可加大' },
      },
      required: ['id', 'prompt'],
      additionalProperties: false,
    })

  registerTool('local-llm-pull',
    '从 Hugging Face / 魔搭社区(ModelScope) 拉取模型到本机并自动登记：解析模型地址（URL / hf:org/name / ms:org/name 简写 / hf.co/org/name:Q4_K_M ollama 形态），按已装工具自动选下载通道（GGUF→ollama pull，整仓→hf / modelscope CLI），完成后写登记表并按探测到的推理后端（llama-server/vllm/ollama）生成启停命令。下载超时可重跑续传；中国网络可 mirror:true 走 hf-mirror.com。写面过审批门。',
    {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'HF/魔搭地址或模型 id：huggingface.co/hf.co/hf-mirror.com/modelscope.cn 的 URL（含 /resolve/ 单文件链接）、"hf:org/name"、"ms:org/name"、ollama 形态 "hf.co/org/name:Q4_K_M"；裸 "org/name" 默认按 HF' },
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', description: '登记表条目 id（缺省由模型名派生，如 org/name → org-name；仅限字母/数字/._- 且首字符为字母数字——禁空格、shell 元字符与路径穿越，含非法字符会被拒绝）' },
        file: { type: 'string', description: '仓库内单文件路径（如 GGUF 权重，可含子目录）；URL 已含 /resolve/ 文件路径时无需重复' },
        backend: { type: 'string', enum: ['ollama', 'hf', 'modelscope'], description: '下载通道覆盖（缺省自动探测：GGUF+ollama→ollama，否则按站点选 hf/modelscope CLI）' },
        port: { type: 'number', description: '生成 start 命令用的服务端口（缺省 8081；ollama 路径固定 11434）' },
        mirror: { type: 'boolean', description: 'HF 下载走 hf-mirror.com 镜像（HF_ENDPOINT 前缀；仅 hf CLI 通道）' },
        timeoutMs: { type: 'number', description: '下载超时毫秒（默认 600000，上限 3600000）——超时中断可重跑续传' },
      },
      required: ['source'],
      additionalProperties: false,
    })

  // ---------- V1：provider 注册（Composer「Local models」组） ----------
  // registerAdapter 内部把释放挂在其宿主 fiber 上；本插件卸载也须释放——
  // 双主：disposer 再挂进本插件 effect（practices: registrations have owners）。
  const llm = ctx.get('llm')
  if (llm) {
    const handle = llm.registerAdapter([PROVIDER_ID], svc.adapter)
    ctx.effect(() => handle)
    // V2：原生目录条目 + 端点发现面（设置-模型 的「Local models」行）
    ctx.effect(svc.registerDirectory(llm))
    // 启动即探活一次，然后广播目录（badge 初始态就位）
    void svc.initialProbe().then(() => {
      try { ctx.emit('llm/models-updated', PROVIDER_ID) } catch { /* 广播失败不致命 */ }
    })
    // V2：运行条目 60s 周期复核——推理服务在外部崩溃/被停时 badge 翻转并广播
    ctx.effect(() => {
      const timer = setInterval(() => { void svc.reprobeRunning() }, 60_000)
      return () => clearInterval(timer)
    })
  }

  // ---------- V1：设置页 Web 桥（无 webServer 的宿主自动降级为纯工具形态） ----------
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: svc.WEB_PATH,
      handler: svc.handleRequest,
    })
    ctx.effect(() => disposeRoute)
  }

  // ---------- V1：登记表 watcher（任何写面变更 → 目录刷新广播） ----------
  ctx.effect(svc.watchRegistry)
}
