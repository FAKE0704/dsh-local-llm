# dsh-local-llm

本机无头本地 LLM 的登记/探活/启停/问答/拉取五元工具 dsh 插件 + **V1 设置页与 provider 注册**。

在 [FAKE0704/dsh-local-llm](https://github.com/FAKE0704/dsh-local-llm)（真源 = Genshu monorepo 镜像）五工具基础上新增：

- **provider 注册**：插件把登记表里的模型经自有 adapter（OpenAI 兼容 wire）接入 Host `llm` 服务——部署后的本地模型出现在 **Composer 模型选择**（「Local models」组）与 **设置 → 模型** 页脚；未运行的模型带 warning 色的「未运行 / Not running」badge，状态变化经 `llm/models-updated` 即时同步。
- **V2 原生目录行**：`registerConfigurableProviders` 注册 whole-section 目录条目（`settingsNs: dsh-local-llm`）——设置 → 模型 页出现「Local models」原生 provider 行；`registerModelDiscovery` 提供端点发现（草稿带 baseURL 时直接问端点，否则按登记表作答）；provider 卡内扩展（keyed）渲染运行状态与部署/停止按钮（页面未为本 family 出卡片时自动不渲染）。
- **运行态周期复核**：运行中条目每 60s 复探一次——推理服务在外部崩溃/被停时 badge 翻转并广播。
- **设置 → 本地模型 页**：选择权重存放目录（写回插件 `config.registryPath`）；粘贴 HF/魔搭地址 → 解析确认（每次下载弹一次确认框，显示来源/通道/目标/条目 id）→ 下载登记；已登记模型列表带探活状态与「部署 / 停止」。
- **Web 桥**：Host 半在 `/api/dsh-local-llm` 挂认证路由（同源守卫），Client 半经 `fetch` 调用。无 `webServer` 的宿主自动降级为纯工具形态。

工具面与审批门不变：`local-llm-start` / `local-llm-stop` / `local-llm-pull` 过审批门（agent 路径每次人工批准；UI 路径授权 = 用户点击 + 下载确认框）；`local-llm-list` / `local-llm-call` 免审。登记表格式、路径覆盖（`config.registryPath` ＞ `DSH_LOCAL_MODELS_REGISTRY` ＞ `~/.dsh/local-models.yaml`）与五工具用法见上游 README。

## 本包相对上游的文件

| 文件 | 作用 |
| --- | --- |
| `host-service.js` | adapter（OpenAI 兼容 SSE → StreamChunk）+ 探活缓存 + Web 桥 + 登记表 watcher |
| `index.js` | 五工具注册 + adapter/路由/watcher 挂载（上游 index.js 的超集） |
| `client.js` | 设置页 / 模型页页脚 / 分区图标 |
| `core.js` | 上游语义核，未改动 |

环境限制：设置页 Web 桥面向 Web GUI（页面由本地 HTTP 服务提供）；Electron `file://` 面未适配。
