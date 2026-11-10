# dsh-local-llm

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件，让你把跑在自己电脑上的本地大模型接入 dsh：登记模型、查看状态、启动/停止推理服务、直接提问、下载新模型，并且在 Web 界面里管理和使用这些模型。

## 它能做什么

装好插件后，dsh 会多出五个工具，Agent 可以直接使用：

| 工具 | 作用 | 是否需要确认 |
| --- | --- | --- |
| `local-llm-list` | 查看本机登记了哪些模型、谁在运行 | 不需要 |
| `local-llm-call` | 向某个本地模型发一段提问，拿回回复 | 不需要 |
| `local-llm-start` | 启动一个本地模型的推理服务 | 每次需要你批准 |
| `local-llm-stop` | 停止一个正在运行的推理服务 | 每次需要你批准 |
| `local-llm-pull` | 从 Hugging Face 或魔搭社区下载模型到本机 | 每次需要你批准 |

需要批准的操作，在 Agent 里会弹窗让你确认；在 Web 界面里则是你亲手点击按钮，所以不会再额外弹窗。

除了工具，插件还会做这些事：

- **模型接入对话**：插件把已登记的本地模型注册成 dsh 的模型来源。部署（启动）一个本地模型后，它会出现在 Web 界面的模型选择列表和「设置 → 模型」页面里，可以直接在对话中使用。没在运行的模型会标成灰色「未运行」，状态变化会实时刷新。
- **「设置 → 本地模型」页面**：在 Web 界面里选择模型文件的存放目录、粘贴 Hugging Face / 魔搭的模型地址下载新模型、查看每个模型的运行状态、一键部署或停止。
- **状态自动刷新**：正在运行的模型每 60 秒重新检测一次。如果推理服务在外面被关掉了，界面上的状态会自动更新。

## 安装

在 dsh 里安装本插件（要求 dsh 0.2.1-alpha.1 及以上、0.3.0 以下）：

```sh
dsh plugin install github:FAKE0704/dsh-local-llm
```

## 快速上手

1. 打开 dsh Web 界面，进入「设置 → 本地模型」。
2. 选择一个目录用来存放模型文件。
3. 粘贴一个模型地址（例如 `hf:org/name` 或魔搭地址），确认后开始下载。
4. 下载完成后点「部署」，模型就会出现在对话的模型选择列表里。

也可以不用界面，直接让 Agent 操作，比如对它说：「帮我把 qwen3:4b 拉下来并部署」。

## 模型登记表

所有登记过的模型保存在一个 YAML 文件里，查找顺序为：

1. 插件设置里的自定义路径（「设置 → 本地模型」页可改）
2. 环境变量 `DSH_LOCAL_MODELS_REGISTRY`
3. 默认位置 `~/.dsh/local-models.yaml`

## 环境说明

「设置 → 本地模型」页面通过官方 Typert Remote 通道（宿主侧 `typert` 注册清单 + 客户端 `ctx.remote` 挂命名空间）与宿主通信，desktop 应用与 `dsh web` 均可用；web 宿主上另保留 `/api/dsh-local-llm` 精确路由作为兜底桥。两条通道都不可用时自动降级为纯工具形态——五个工具照常可用，只是没有设置页面。

要求 `dsh >= 0.2.1-alpha.1 <0.3.0`（见 engines 字段）。客户端半边改动需重启宿主后才会到达已打开的页面；每次客户端变更都会递增插件版本号以失效模块缓存。

## 社区与支持

- 问题与建议请提交到 [GitHub Issues](https://github.com/FAKE0704/dsh-local-llm/issues)。
- 欢迎给仓库加上 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 主题方便其他人发现。

## License

[MIT](LICENSE)
