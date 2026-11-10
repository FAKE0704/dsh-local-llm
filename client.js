// dsh-local-llm — V1 Client 半：「设置 → 本地模型」页 + 「设置 → 模型」页脚摘要 + 分区图标。
//
// 槽位契约（已对照运行时核实）：
//   settings.section       list  — 一节一页（id/order/label，label 可为函数）
//   settings.section.icon  list  — 与 section 同 id 寻址；组件收 { size, active }
//   settings.models.footer list  — 模型页 provider 行之后的加法区
// 样式只用 --dsw-alias-* / --dsw-state-* / --dsw-specific-* 主题 token；不 import
// 任何 Harness Client 包；组件内 <style> 随卸载移除。桥：POST api/dsh-local-llm。

window.__ModuleLoader__.load({
  id: 'dsh-local-llm',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    // ---------- 文案（快照取 locale，双字典兜底） ----------
    const STRINGS = {
      zh: {
        section: '本地模型',
        pageLead: '本机小模型：登记、下载（Hugging Face / 魔搭）、部署。部署后出现在 Composer 的模型选择（「Local models」组）与下方「模型」页。',
        pathTitle: '存放路径',
        pathDesc: '模型权重下载到该目录（登记表 local-models.yaml 与 models/ 同级存放）。',
        pick: '选择目录…',
        picking: '等待目录选择…',
        dlTitle: '从 HF / 魔搭下载',
        dlDesc: '粘贴模型地址（hf:org/name、ms:org/name、网站 URL、hf.co/org/name:Q4_K_M），解析后确认一次再下载。',
        dlPlaceholder: '例如 hf:Qwen/Qwen3-4B 或 https://huggingface.co/Qwen/Qwen3-4B',
        preview: '解析并确认…',
        previewing: '解析中…',
        dlBtn: '下载并登记',
        downloading: '下载中…大文件可持续数分钟到数十分钟；关闭此页下载仍会在本机继续，完成后模型出现在列表。',
        confirmTitle: '确认下载',
        fSource: '来源', fChannel: '通道', fTarget: '目标目录', fId: '条目 id',
        channelNone: '未探测到可用下载通道（需 ollama / hf CLI / modelscope CLI 其一）',
        confirmBtn: '确认下载', cancel: '取消',
        listTitle: '已登记模型',
        refresh: '刷新',
        deploy: '部署', stopping: '停止',
        running: '运行中', stopped: '未运行',
        noStart: '该条目未登记 start 命令——登记表补 start 后可部署',
        noStop: '该条目未登记 stop 命令',
        emptyMissing: '尚未选择登记表，或登记表不存在。选择上方目录后可用下载自动建表。',
        emptyError: '登记表读取失败：',
        emptyNone: '登记表为空——用上方下载面板拉第一个模型。',
        footerTitle: '本地模型',
        footerHint: '在「本地模型」页管理与部署。',
        footerEmpty: null,
        lastResult: '上次操作结果',
        scanTitle: '目录里的模型',
        scanDesc: '扫描所选目录（深度 3，只读）：识别 *.gguf（同目录分片归组）、HF 整仓目录（config.json + safetensors）与 ~/.ollama/models 模型库（权重 blob 按标准 GGUF 直接用 llama-server 起，同一权重的多个 tag 折叠为一条）。条目按钮直接把它跑起来：未登记 → 登记并部署；已登记 → 部署；运行中置灰。停止/重新部署用下方列表。',
        scanBtn: '扫描',
        scanning: '扫描中…',
        scanNone: '未发现可识别的模型文件——支持 *.gguf、HF 整仓目录（config.json + safetensors）与 ~/.ollama 模型库。',
        scanFail: '扫描失败：',
        kindGguf: 'GGUF',
        kindHf: 'HF 整仓',
        kindOllama: 'Ollama',
        embedBadge: '嵌入模型',
        regDeploy: '登记并部署',
        regDeploying: '登记并部署中…',
        deploying: '部署中…',
        extraTags: (n) => `同权重另有 ${n} 个 tag`,
        ollamaNote: 'ollama 权重 blob 直接起 llama-server；若对话模板异常可去掉 --jinja',
        shards: (n) => `${n} 个分片`,
        noServe: '未探测到推理后端——登记后命令用裸名，需自行确保 PATH 可用',
      },
      en: {
        section: 'Local models',
        pageLead: 'Local small models: registry, download (Hugging Face / ModelScope), deploy. Deployed models appear in the composer model picker (the "Local models" group) and on the Models page below.',
        pathTitle: 'Storage location',
        pathDesc: 'Model weights download into this directory (the local-models.yaml registry sits beside models/).',
        pick: 'Choose directory…',
        picking: 'Waiting for directory…',
        dlTitle: 'Download from HF / ModelScope',
        dlDesc: 'Paste a model address (hf:org/name, ms:org/name, a site URL, hf.co/org/name:Q4_K_M); it is parsed and confirmed once before downloading.',
        dlPlaceholder: 'e.g. hf:Qwen/Qwen3-4B or https://huggingface.co/Qwen/Qwen3-4B',
        preview: 'Parse and confirm…',
        previewing: 'Parsing…',
        dlBtn: 'Download and register',
        downloading: 'Downloading… large files take minutes; closing this page keeps the download running on this machine, and the model appears in the list when it finishes.',
        confirmTitle: 'Confirm download',
        fSource: 'Source', fChannel: 'Channel', fTarget: 'Target directory', fId: 'Entry id',
        channelNone: 'No download channel detected (needs one of: ollama / hf CLI / modelscope CLI)',
        confirmBtn: 'Download', cancel: 'Cancel',
        listTitle: 'Registered models',
        refresh: 'Refresh',
        deploy: 'Deploy', stopping: 'Stop',
        running: 'Running', stopped: 'Not running',
        noStart: 'This entry has no start command — add start to the registry to deploy',
        noStop: 'This entry has no stop command',
        emptyMissing: 'No registry selected, or it does not exist yet. Choose a directory above; a download will create it.',
        emptyError: 'Registry failed to load: ',
        emptyNone: 'The registry is empty — pull a first model with the download panel above.',
        footerTitle: 'Local models',
        footerHint: 'Manage and deploy on the Local models page.',
        footerEmpty: null,
        lastResult: 'Last operation',
        scanTitle: 'Models in the directory',
        scanDesc: 'Scans the chosen directory (depth 3, read-only): *.gguf files (shards grouped), HF repo directories (config.json + safetensors), and the ~/.ollama/models store (weight blobs are plain GGUF served directly with llama-server; multiple tags of the same weights are folded into one row). Each row gets the model running: not registered → register & deploy; registered → deploy; dimmed while running. Stop / re-deploy from the list below.',
        scanBtn: 'Scan',
        scanning: 'Scanning…',
        scanNone: 'No recognizable model files found — supports *.gguf, HF repo directories (config.json + safetensors), and the ~/.ollama store.',
        scanFail: 'Scan failed: ',
        kindGguf: 'GGUF',
        kindHf: 'HF repo',
        kindOllama: 'Ollama',
        embedBadge: 'Embedding',
        regDeploy: 'Register & deploy',
        regDeploying: 'Registering & deploying…',
        deploying: 'Deploying…',
        extraTags: (n) => `${n} more tag(s), same weights`,
        ollamaNote: 'ollama weight blobs run under llama-server directly; drop --jinja from start if the chat template misbehaves',
        shards: (n) => `${n} shards`,
        noServe: 'No inference backend detected — the registered command uses the bare name; make sure PATH resolves it',
      },
    }

    function makeT(ctx) {
      let lang = 'en'
      try {
        // LocaleSnapshot 字段名跨版本不稳（active/locale/id/current…）——多字段
        // 探测 + getLocale/getSnapshot 双方法兜底，命中任一 zh* 即中文。
        const svc = ctx.get('locale')
        const snap = svc?.getLocale?.() ?? svc?.getSnapshot?.()
        const cands = [snap?.active, snap?.locale, snap?.id, snap?.current, snap?.resolved, snap?.language]
        if (cands.some((c) => typeof c === 'string' && c.toLowerCase().startsWith('zh'))) lang = 'zh'
      } catch { /* 继续探测浏览器语言 */ }
      if (lang !== 'zh') {
        try {
          const nav = Array.isArray(navigator?.languages) && navigator.languages.length > 0 ? navigator.languages[0] : navigator?.language
          if (typeof nav === 'string' && nav.toLowerCase().startsWith('zh')) lang = 'zh'
        } catch { /* 缺省英文 */ }
      }
      return (key) => {
        const v = STRINGS[lang][key] ?? STRINGS.en[key] ?? key
        return typeof v === 'function' ? v : String(v)
      }
    }

    /** locale 切换时的强制重渲染 tick（订阅 locale/change 广播） */
    function makeLocaleTick(ctx) {
      return function useLocaleTick() {
        const [tick, setTick] = useState(0)
        useEffect(() => {
          try {
            const off = ctx.on('locale/change', () => setTick((n) => n + 1))
            return off
          } catch { return undefined }
        }, [])
        return tick
      }
    }

    // ---------- RPC 传输（官方 Typert Remote 通道；范本 dsh-fabric-memory） ----------
    const identity = (value) => value
    const codec = (typeSymbol) => ({
      mode: 'strict',
      typeSymbol,
      create: () => ({ parse: identity }),
    })
    const descriptor = (method, hasParams = true) => ({
      id: `dsh-local-llm#localLlm/${method}`,
      service: 'localLlm',
      namespace: 'localLlm',
      method,
      invocation: { kind: 'direct' },
      parameters: hasParams ? [{ name: 'params', wire: 'params', source: 'json', codec: codec(`dsh-local-llm#${method}Params`) }] : [],
      result: codec('dsh-local-llm#RpcResult'),
    })
    const CONTRIBUTION = {
      package: 'dsh-local-llm',
      descriptors: [
        descriptor('list', false), descriptor('preview'), descriptor('pull'),
        descriptor('deploy'), descriptor('stop'), descriptor('setModelsDir'),
        descriptor('scan'), descriptor('registerEntry'),
      ],
    }
    const rpcTransport = {
      ctx: null,
      mountPromise: null,
      bind(ctx) {
        this.ctx = ctx
        try {
          const remote = ctx.get('remote')
          this.mountPromise = remote?.$mount?.(CONTRIBUTION) ?? Promise.reject(new Error('ctx.remote 不可用'))
        } catch (err) {
          this.mountPromise = Promise.reject(err)
        }
        this.mountPromise.catch(() => { /* 延迟到调用面报错 */ })
      },
      async call(method, args) {
        try {
          await this.mountPromise
          const ns = this.ctx?.get?.('remote.localLlm')
          if (!ns || typeof ns[method] !== 'function') {
            return { ok: false, message: `remote.localLlm.${method} 不可用（命名空间未挂载）` }
          }
          const hasParams = method !== 'list'
          const result = await ns[method](...(hasParams ? [args ?? {}] : []))
          if (result?.ok === true) return result.value ?? { ok: false, message: 'empty value' }
          const failure = result?.error
          const msg = failure ? `${failure.code || 'REMOTE'}: ${failure.message || ''}` : 'rpc 调用失败'
          return { ok: false, message: msg.slice(0, 300) }
        } catch (err) {
          return { ok: false, message: `rpc ${method} 异常：${err instanceof Error ? err.message.slice(0, 200) : String(err)}` }
        }
      },
    }

    function apiCall(method, args) {
      return rpcTransport.call(method, args)
    }

    function StatusDot({ up }) {
      return h('span', {
        className: `dshllm-dot ${up ? 'dshllm-dot-up' : 'dshllm-dot-down'}`,
        role: 'img',
        'aria-label': up ? 'running' : 'not running',
      })
    }

    function SourceLine({ entry }) {
      const bits = []
      bits.push(`127.0.0.1:${entry.port}`)
      if (entry.ctx) bits.push(`ctx ${entry.ctx}`)
      if (entry.source) bits.push(entry.source)
      return h('div', { className: 'dshllm-meta' }, bits.join(' · '))
    }

    // ---------- 「本地模型」设置页 ----------
    function makePage(ctx, t) {
      const pickDirectory = () => ctx.get('uiWorkspace')?.pickDirectory?.()
      const useLocaleTick = makeLocaleTick(ctx)

      function formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return ''
        const gb = bytes / 1073741824
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`
      }

      function Page() {
        useLocaleTick()
        const [data, setData] = useState(null)
        const [loadError, setLoadError] = useState(null)
        const [loading, setLoading] = useState(false)
        const [busyId, setBusyId] = useState(null)
        const [picking, setPicking] = useState(false)
        const [source, setSource] = useState('')
        const [previewing, setPreviewing] = useState(false)
        const [confirm, setConfirm] = useState(null)
        const [downloading, setDownloading] = useState(false)
        const [result, setResult] = useState(null) // { ok, text }
        const [scan, setScan] = useState(null)
        const [scanning, setScanning] = useState(false)
        const [regBusy, setRegBusy] = useState(null)
        const cancelRef = useRef(null)

        const refresh = useCallback(async () => {
          setLoading(true)
          const res = await apiCall('list')
          setLoading(false)
          if (res.available === true) {
            setData(res)
            setLoadError(null)
          } else if (res.error) {
            setData(null)
            setLoadError(`${t('emptyError')}${res.error}`)
          } else if (res.ok === false && res.message) {
            // 传输层失败（rpc/HTTP）必须可见，不能伪装成「登记表不存在」
            setData(null)
            setLoadError(`list 调用失败：${res.message}`)
          } else {
            setData({ models: [], registryPath: res.registryPath ?? '' })
            setLoadError(t('emptyMissing'))
          }
        }, [t])

        useEffect(() => { void refresh() }, [refresh])

        // 扫描所选目录（服务端缺省取 registryPath 所在目录）；列表就绪后自动扫一次
        const runScan = useCallback(async () => {
          setScanning(true)
          try {
            setScan(await apiCall('scan', {}))
          } finally {
            setScanning(false)
          }
        }, [])

        const scannedRef = useRef(false)
        useEffect(() => {
          if (data !== null && !scannedRef.current) {
            scannedRef.current = true
            void runScan()
          }
        }, [data, runScan])

        // Host 广播的目录变更（agent 侧 pull / watcher）→ 页面刷新
        useEffect(() => {
          try {
            const off = ctx.on('llm/models-updated', () => { void refresh() })
            return off
          } catch { return undefined }
        }, [refresh])

        async function onPick() {
          setPicking(true)
          try {
            let dir
            try {
              dir = await pickDirectory()
            } catch (err) {
              // 目录选择器异常必须可见——静默吞掉表现为「点了没反应」
              setResult({ ok: false, text: `${t('pick')} failed: ${err instanceof Error ? err.message : String(err)}` })
              return
            }
            if (!dir) {
              setResult({ ok: false, text: `${t('pick')} → null（目录选择器不可用或已取消）` })
              return
            }
            scannedRef.current = false // 目录变了，重扫
            const res = await apiCall('setModelsDir', { dir })
            setResult({ ok: res.ok === true, text: res.ok ? String(res.registryPath ?? dir) : String(res.message ?? 'failed') })
            await refresh()
            void runScan()
          } finally {
            setPicking(false)
          }
        }

        // 扫描卡按钮：登记 + 立即部署（一步到「运行中」）；已登记的条目直接部署。
        // 端口由服务端自动分配（避开登记表其他条目与本机现有监听）——客户端不写死。
        async function onRegisterAndDeploy(candidate) {
          setRegBusy(candidate.path)
          try {
            const reg = await apiCall('registerEntry', { candidate })
            setResult({ ok: reg.ok === true, text: String(reg.message ?? '') })
            if (reg.ok !== true) return
            await refresh()
            const dep = await apiCall('deploy', { id: reg.id })
            setResult({ ok: dep.ok === true, text: `${String(reg.message ?? '')}\n部署：${String(dep.message ?? '')}` })
            await refresh()
          } finally {
            setRegBusy(null)
          }
        }

        async function onPreview() {
          if (source.trim() === '') return
          setPreviewing(true)
          try {
            const res = await apiCall('preview', { source: source.trim() })
            if (res.ok === true) setConfirm(res)
            else setResult({ ok: false, text: String(res.message ?? 'parse failed') })
          } finally {
            setPreviewing(false)
          }
        }

        async function onDownload() {
          const target = confirm
          setConfirm(null)
          if (!target) return
          setDownloading(true)
          setResult(null)
          try {
            const res = await apiCall('pull', { source: source.trim(), timeoutMs: 1_800_000 })
            setResult({ ok: res.ok === true, text: String(res.message ?? '') })
            if (res.ok === true) setSource('')
            await refresh()
          } finally {
            setDownloading(false)
          }
        }

        async function onLifecycle(id, method) {
          setBusyId(id)
          try {
            const res = await apiCall(method, { id })
            setResult({ ok: res.ok === true, text: String(res.message ?? '') })
            await refresh()
          } finally {
            setBusyId(null)
          }
        }

        // Escape 关闭确认框；打开时焦点落取消键
        useEffect(() => {
          if (confirm) cancelRef.current?.focus?.()
        }, [confirm])

        const models = Array.isArray(data?.models) ? data.models : []

        return h('div', { className: 'dshllm-page' },
          h('style', null, PAGE_CSS),
          h('p', { className: 'dshllm-lead' }, t('pageLead')),

          // —— 存放路径 ——
          h('section', { className: 'dshllm-card' },
            h('h3', { className: 'dshllm-h' }, t('pathTitle')),
            h('p', { className: 'dshllm-desc' }, t('pathDesc')),
            h('div', { className: 'dshllm-row' },
              h('code', { className: 'dshllm-path' }, data?.registryPath ?? '—'),
              h('button', {
                className: 'dshllm-btn', type: 'button',
                disabled: picking || downloading,
                onClick: () => { void onPick() },
              }, picking ? t('picking') : t('pick')))),

          // —— 目录里的模型（扫描识别 + 一键登记） ——
          h('section', { className: 'dshllm-card' },
            h('div', { className: 'dshllm-row' },
              h('h3', { className: 'dshllm-h' }, t('scanTitle')),
              h('button', {
                className: 'dshllm-btn', type: 'button',
                disabled: scanning || downloading,
                onClick: () => { void runScan() },
              }, scanning ? t('scanning') : t('scan'))),
            h('p', { className: 'dshllm-desc' }, t('scanDesc')),
            scanning
              ? null
              : scan && scan.ok === false
                ? h('p', { className: 'dshllm-note' }, `${t('scanFail')}${scan.message ?? ''}`)
                : Array.isArray(scan?.candidates) && scan.candidates.length > 0
                  ? h('ul', { className: 'dshllm-list' },
                      scan.candidates.map((c) => {
                        const entry = models.find((m) => m.id === c.id)
                         const running = entry?.up === true
                         const rowBusy = regBusy === c.path || busyId === c.id
                         const label = rowBusy
                           ? (entry ? t('deploying') : t('regDeploying'))
                           : running ? t('running') : entry ? t('deploy') : t('regDeploy')
                        return h('li', { className: 'dshllm-item', key: c.path },
                          h('div', { className: 'dshllm-item-main' },
                            h('div', { className: 'dshllm-item-line' },
                              h('span', { className: 'dshllm-badge' },
                                c.kind === 'gguf' ? t('kindGguf') : c.kind === 'ollama' ? t('kindOllama') : t('kindHf')),
                              h('span', { className: 'dshllm-name' }, c.name),
                              c.sizeBytes ? h('span', { className: 'dshllm-meta' }, formatSize(c.sizeBytes)) : null,
                              c.shardCount > 1 ? h('span', { className: 'dshllm-meta' }, t('shards')(c.shardCount)) : null,
                               Array.isArray(c.extraTags) && c.extraTags.length > 0
                                 ? h('span', { className: 'dshllm-meta', title: c.extraTags.join('、') }, t('extraTags')(c.extraTags.length))
                                 : null,
                              c.embedding ? h('span', { className: 'dshllm-badge dshllm-badge-warn' }, t('embedBadge')) : null,
                              !c.serveBin ? h('span', { className: 'dshllm-badge dshllm-badge-warn' }, t('noServe')) : null),
                            h('div', { className: 'dshllm-meta' }, c.path)),
                          h('div', { className: 'dshllm-item-actions' },
                            h('button', {
                              className: running || entry ? 'dshllm-btn' : 'dshllm-btn dshllm-btn-primary',
                              type: 'button',
                              disabled: rowBusy || regBusy !== null || busyId !== null || running,
                              title: !entry && c.kind === 'ollama' ? t('ollamaNote') : undefined,
                              onClick: () => { void (entry ? onLifecycle(c.id, 'deploy') : onRegisterAndDeploy(c)) },
                            }, label)))
                      }))
                  : h('p', { className: 'dshllm-note' }, t('scanNone'))),

          // —— 下载 ——
          h('section', { className: 'dshllm-card' },
            h('h3', { className: 'dshllm-h' }, t('dlTitle')),
            h('p', { className: 'dshllm-desc' }, t('dlDesc')),
            h('div', { className: 'dshllm-row' },
              h('input', {
                className: 'dshllm-input',
                type: 'text',
                value: source,
                placeholder: t('dlPlaceholder'),
                disabled: downloading || previewing,
                onChange: (e) => setSource(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') void onPreview() },
                'aria-label': t('dlTitle'),
              }),
              h('button', {
                className: 'dshllm-btn dshllm-btn-primary', type: 'button',
                disabled: downloading || previewing || source.trim() === '',
                onClick: () => { void onPreview() },
              }, previewing ? t('previewing') : t('preview'))),
            downloading
              ? h('p', { className: 'dshllm-note dshllm-note-warn' }, t('downloading'))
              : null),

          // —— 确认下载（模态） ——
          confirm
            ? h('div', {
                className: 'dshllm-overlay', role: 'presentation',
                onKeyDown: (e) => { if (e.key === 'Escape') setConfirm(null) },
              },
              h('div', { className: 'dshllm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('confirmTitle') },
                h('h3', { className: 'dshllm-h' }, t('confirmTitle')),
                h('dl', { className: 'dshllm-facts' },
                  h('dt', null, t('fSource')), h('dd', null, confirm.canonical),
                  h('dt', null, t('fChannel')),
                  h('dd', null, confirm.plan ? (confirm.plan.kind === 'ollama-pull' ? 'ollama pull' : String(confirm.plan.cli ?? '')) : t('channelNone')),
                  h('dt', null, t('fId')), h('dd', null, confirm.id),
                  h('dt', null, t('fTarget')), h('dd', null, confirm.downloadDir)),
                confirm.planError
                  ? h('p', { className: 'dshllm-note dshllm-note-warn' }, confirm.planError)
                  : null,
                confirm.plan
                  ? h('pre', { className: 'dshllm-cmd' }, String(confirm.plan.cmd ?? ''))
                  : null,
                h('div', { className: 'dshllm-row dshllm-row-end' },
                  h('button', { className: 'dshllm-btn', type: 'button', ref: cancelRef, onClick: () => setConfirm(null) }, t('cancel')),
                  h('button', {
                    className: 'dshllm-btn dshllm-btn-primary', type: 'button',
                    disabled: !confirm.plan,
                    onClick: () => { void onDownload() },
                  }, t('confirmBtn')))))
            : null,

          // —— 列表 ——
          h('section', { className: 'dshllm-card' },
            h('div', { className: 'dshllm-row' },
              h('h3', { className: 'dshllm-h' }, t('listTitle')),
              h('button', { className: 'dshllm-btn', type: 'button', disabled: loading || downloading, onClick: () => { void refresh() } }, t('refresh'))),
            loadError
              ? h('p', { className: 'dshllm-note' }, loadError)
              : models.length === 0
                ? h('p', { className: 'dshllm-note' }, t('emptyNone'))
                : h('ul', { className: 'dshllm-list' },
                    models.map((entry) => h('li', { className: 'dshllm-item', key: entry.id },
                      h('div', { className: 'dshllm-item-main' },
                        h('div', { className: 'dshllm-item-line' },
                          h(StatusDot, { up: entry.up === true }),
                          h('span', { className: 'dshllm-name' }, entry.id),
                          h('span', { className: 'dshllm-badge' }, entry.up ? t('running') : t('stopped')),
                          entry.invalid ? h('span', { className: 'dshllm-badge dshllm-badge-warn' }, entry.invalid) : null),
                        h(SourceLine, { entry })),
                      h('div', { className: 'dshllm-item-actions' },
                        h('button', {
                          className: 'dshllm-btn', type: 'button',
                          disabled: busyId !== null || downloading || !entry.hasStart,
                          title: entry.hasStart ? undefined : t('noStart'),
                          onClick: () => { void onLifecycle(entry.id, 'deploy') },
                        }, t('deploy')),
                        h('button', {
                          className: 'dshllm-btn', type: 'button',
                          disabled: busyId !== null || downloading || !entry.hasStop,
                          title: entry.hasStop ? undefined : t('noStop'),
                          onClick: () => { void onLifecycle(entry.id, 'stop') },
                        }, t('stopping'))))))),

          result
            ? h('section', { className: 'dshllm-card' },
                h('h3', { className: 'dshllm-h' }, t('lastResult')),
                h('pre', { className: `dshllm-result ${result.ok ? 'dshllm-result-ok' : 'dshllm-result-bad'}` }, result.text))
            : null)
      }

      return Page
    }

    // ---------- 「设置 → 模型」页脚摘要 ----------
    function makeFooter(ctx, t) {
      function Footer() {
        const [models, setModels] = useState(null)

        const refresh = useCallback(async () => {
          const res = await apiCall('list')
          setModels(Array.isArray(res?.models) ? res.models : null)
        }, [])

        useEffect(() => { void refresh() }, [refresh])
        useEffect(() => {
          try {
            const off = ctx.on('llm/models-updated', () => { void refresh() })
            return off
          } catch { return undefined }
        }, [refresh])

        if (!models || models.length === 0) return null
        return h('div', { className: 'dshllm-footer' },
          h('style', null, PAGE_CSS),
          h('div', { className: 'dshllm-footer-head' }, t('footerTitle')),
          h('div', { className: 'dshllm-chips' },
            models.map((m) => h('span', { className: 'dshllm-chip', key: m.id },
              h(StatusDot, { up: m.up === true }),
              h('span', null, m.id)))),
          h('div', { className: 'dshllm-meta' }, t('footerHint')))
      }
      return Footer
    }

    // ---------- 「设置 → 模型」provider 卡内扩展（keyed：entryKey = 本插件 ns） ----------
    // 卡片是否渲染取决于页面是否为本 family 出目录行；本组件完全防御式：
    // 无行/无模型 → null；有模型 → 状态 chips + 部署/停止。
    function makeProviderCard(ctx, t) {
      function ProviderCard() {
        const [models, setModels] = useState(null)
        const [busyId, setBusyId] = useState(null)

        const refresh = useCallback(async () => {
          const res = await apiCall('list')
          setModels(Array.isArray(res?.models) ? res.models : null)
        }, [])

        useEffect(() => { void refresh() }, [refresh])
        useEffect(() => {
          try {
            const off = ctx.on('llm/models-updated', () => { void refresh() })
            return off
          } catch { return undefined }
        }, [refresh])

        async function onLifecycle(id, method) {
          setBusyId(id)
          try { await apiCall(method, { id }); await refresh() } finally { setBusyId(null) }
        }

        if (!models || models.length === 0) return null
        return h('div', { className: 'dshllm-cardext' },
          h('style', null, PAGE_CSS),
          models.map((m) => h('div', { className: 'dshllm-cardext-row', key: m.id },
            h(StatusDot, { up: m.up === true }),
            h('span', { className: 'dshllm-name' }, m.id),
            h('span', { className: 'dshllm-badge' }, m.up ? t('running') : t('stopped')),
            h('button', {
              className: 'dshllm-btn', type: 'button',
              disabled: busyId !== null || !m.hasStart,
              title: m.hasStart ? undefined : t('noStart'),
              onClick: () => { void onLifecycle(m.id, 'deploy') },
            }, t('deploy')),
            h('button', {
              className: 'dshllm-btn', type: 'button',
              disabled: busyId !== null || !m.hasStop,
              title: m.hasStop ? undefined : t('noStop'),
              onClick: () => { void onLifecycle(m.id, 'stop') },
            }, t('stopping')))))
      }
      return ProviderCard
    }

    // ---------- 分区图标（收 { size, active }） ----------
    function SectionIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 1.5 }),
        h('rect', { x: 3, y: 13, width: 18, height: 7, rx: 1.5 }),
        h('line', { x1: 7, y1: 7.5, x2: 7.01, y2: 7.5, strokeWidth: 2.6 }),
        h('line', { x1: 7, y1: 16.5, x2: 7.01, y2: 16.5, strokeWidth: 2.6 }))
    }

    // 只引用主题 token；组件卸载随 <style> 移除
    const PAGE_CSS = `
.dshllm-page { display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
.dshllm-lead { margin: 0; color: var(--dsw-alias-label-secondary); }
.dshllm-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dshllm-h { margin: 0; font-size: 1em; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshllm-desc { margin: 0; color: var(--dsw-alias-label-secondary); }
.dshllm-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshllm-row-end { justify-content: flex-end; }
.dshllm-path { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.dshllm-input { flex: 1 1 260px; min-width: 0; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dshllm-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: var(--dsw-alias-brand-primary); }
.dshllm-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dshllm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dshllm-btn:disabled { opacity: 0.45; cursor: default; }
.dshllm-btn-primary { border-color: var(--dsw-alias-brand-primary); }
.dshllm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dshllm-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshllm-item:first-child { border-top: none; }
.dshllm-item-main { min-width: 0; }
.dshllm-item-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshllm-item-actions { display: flex; gap: 8px; flex-shrink: 0; }
.dshllm-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.dshllm-dot-up { background: var(--dsw-alias-state-success-primary); }
.dshllm-dot-down { background: var(--dsw-alias-state-idle-primary); }
.dshllm-name { color: var(--dsw-alias-label-primary); font-weight: 500; overflow-wrap: anywhere; }
.dshllm-badge { font-size: 0.85em; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dshllm-badge-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dshllm-meta { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dshllm-note { margin: 0; color: var(--dsw-alias-label-secondary); }
.dshllm-note-warn { color: var(--dsw-alias-state-warn-primary); }
.dshllm-result { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; padding: 8px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dshllm-result-ok { color: var(--dsw-alias-label-primary); }
.dshllm-result-bad { color: var(--dsw-alias-state-error-primary); }
.dshllm-overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent); display: flex; align-items: center; justify-content: center; z-index: 60; }
.dshllm-dialog { width: min(560px, calc(100vw - 48px)); max-height: 80vh; overflow: auto; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 12px 40px color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent); }
.dshllm-facts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.dshllm-facts dt { color: var(--dsw-alias-label-secondary); }
.dshllm-facts dd { margin: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshllm-cmd { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dshllm-footer { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.dshllm-footer-head { font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshllm-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.dshllm-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.dshllm-cardext { display: flex; flex-direction: column; gap: 8px; padding: 10px 0 2px; border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; }
.dshllm-cardext-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
`

    return {
      // remote：官方 Remote 传输；locale：语言服务（不在 inject 里受限上下文拿不到）
      inject: ['slots', 'remote', 'locale'],
      apply(ctx) {
        const t = makeT(ctx)
        rpcTransport.bind(ctx)
        const Page = makePage(ctx, t)
        const Footer = makeFooter(ctx, t)
        const ProviderCard = makeProviderCard(ctx, t)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-local-llm', order: 60, label: () => t('section'),
        }, Page))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'dsh-local-llm',
        }, SectionIcon))
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer', id: 'dsh-local-llm', order: 90, label: 'Local models',
        }, Footer))
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card', key: 'dsh-local-llm',
        }, ProviderCard))
      },
    }
  },
})
