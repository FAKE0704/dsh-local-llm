# dsh-local-llm

本机无头本地 LLM 的登记/探活/启停/问答/拉取五元工具，以 dsh 自包含插件供给——
把跑在你自己机器上的小模型（vLLM/ollama/llama.cpp serve 等，OpenAI 兼容端点）接入
agent 会话：查清单（`local-llm-list`）、启停（`local-llm-start` / `local-llm-stop`）、
单段问答（`local-llm-call`）、从 Hugging Face / 魔搭社区拉模型并自动登记
（`local-llm-pull`），大模型编排、小模型干活的廉价分包面。

真源 = [Genshu monorepo](https://github.com/FAKE0704/Genshu) 的
`packages/dsh-plugins/dsh-local-llm`（本仓为镜像，经 `scripts/publish-dsh-local-llm.sh`
幂等组装推送）。

## 它解决什么问题

本地小模型是「机器级资产」：哪个端口在跑哪个模型、docker 还是原生进程、怎么起
怎么停——这些散在历史命令里。本插件把它们登记成一张表，让 agent 会话能够：

- **list**：并行探活 `/v1/models`，回报谁在跑/端口/上下文窗口/探得的模型名；
- **start / stop**：执行登记在案的 shell 启停命令，启停后自动探活复核
  （start 内置冷加载重试窗口，vLLM 类慢启动不会误报失败）；
- **call**：向登记条目发一段 prompt（chat/completions），拿回文本回复——
  整理文档/初步 review/分类摘要等廉价分包活；
- **pull**：给一个 HF/魔搭地址，解析→按已装工具选通道下载→自动登记
  （含生成启停命令），一条命令完成「下载并部署」的前半程。

## 五工具一览

| 工具 | 作用 | 审批 |
| --- | --- | --- |
| `local-llm-list` | 清单 + 实时探活状态 | 免审（只读） |
| `local-llm-call` | 单段问答（OpenAI 兼容） | 免审（烧本机算力，可调面被登记表收窄） |
| `local-llm-start` | 执行登记的 start 命令并探活复核 | 过审批门 |
| `local-llm-stop` | 执行登记的 stop 命令并探活复核 | 过审批门 |
| `local-llm-pull` | HF/魔搭地址→下载→自动登记 | 过审批门（网络下载+GB 级磁盘写+登记表写） |

start/stop 会执行登记表里的 shell 命令（影响本机进程）、pull 有网络下载与
登记表写面，所以每次都需要人工批准；无人值守场景无应答者时 fail-closed 拒绝，
绝不静默执行。

## 从 HF / 魔搭拉模型（local-llm-pull）

```bash
# agent 调用示意（参数见工具 schema）
local-llm-pull { source: "hf:Qwen/Qwen3-4B" }
local-llm-pull { source: "https://modelscope.cn/models/iic/Qwen3-0.6B" }
local-llm-pull { source: "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M" }  # ollama 形态
```

**地址形态**（source 参数）：huggingface.co / hf.co / hf-mirror.com / modelscope.cn
的 URL（含 `/resolve/`、`/blob/` 单文件链接）；`hf:org/name`、`ms:org/name` 简写；
ollama 形态 `hf.co/org/name:Q4_K_M`；裸 `org/name` 默认按 HF（魔搭请加 `ms:`）。
模型名只允许字母/数字/`._-`（禁 shell 元字符，越界 fail-closed）。

**通道自动探测**（一次 `command -v`，可用 `backend` 参数覆盖）：

| 形态 | 首选 | 次选 |
| --- | --- | --- |
| GGUF（有 quant 标签或 .gguf 文件） | `ollama pull`（需标签） | hf / modelscope CLI 单文件下载 |
| HF 整仓 | `hf download`（legacy `huggingface-cli` 兜底） | — |
| 魔搭整仓/文件 | `modelscope download` | — |

三者皆未安装 → fail-closed 返回安装指引（不落表不半登记）。

**下载与登记**：文件落 `~/.dsh/models/<id>/`（登记表同目录的 `models/` 子目录）；
完成后自动追加登记条目（带 `source` 来源字段），并按探测到的推理后端生成启停：

- ollama 路径：port 固定 11434、modelId=`hf.co/<repo>:<tag>`——ollama 守护进程
  在跑即可直接 `local-llm-call`（start/stop 留空，守护进程面通常已自起）；
- llama-server 在装（GGUF 单文件）：生成 `llama-server -m '<文件>' --port <port>`
  与对应 stop（缺省端口 8081，`port` 参数可覆盖）；
- vllm 在装（整仓）：生成 `vllm serve '<目录>' --port <port>` 与对应 stop；
- 都没探测到：start/stop 留空 + note 提示补充。

条目 id 缺省由模型名派生（如 `org-name`）；手填 id 仅限字母/数字/`._-`（首字符
须字母数字）——id 会拼进下载目录与登记的启停命令，含 shell 元字符/空白/`..`
穿越时 fail-closed 拒绝（不静默清洗）。与既有条目撞车时同样拒绝
（pull 不覆盖既有条目）。登记表不存在时可引导建表；损坏的登记表拒绝写入。

**超时与续传**：同步下载，`timeoutMs` 缺省 10 分钟、上限 1 小时——超时即中断，
**重跑同一命令自动续传**（ollama/hf/modelscope CLI 均支持断点续传）。大模型
（>10GB）建议分段续传；门控模型需先 `export HF_TOKEN=...`；中国网络拉 HF 可加
`mirror: true`（走 hf-mirror.com，仅 hf CLI 通道）。

## 安装（github 直装法）

```bash
# dsh 桌面壳插件直装（github: 前缀，与 npm: 同形；npm 发布前的 git 源直装）
dsh install github:FAKE0704/dsh-local-llm
```

你的桌面壳若无 `dsh install` 面（以你的桌面壳文档为准），手动等价法：

```bash
git clone https://github.com/FAKE0704/dsh-local-llm.git ~/.dsh/plugins/dsh-local-llm
```

然后在 dsh 配置（cordis patch，如 `~/.dsh/patches/` 下的挂载补丁）里挂载：

```yaml
- id: dsh-local-llm
  name: dsh-local-llm
  config: {}
```

可选 config：`registryPath`（登记表路径覆盖，见下）。想在公共仓本地跑测试：
`cd ~/.dsh/plugins/dsh-local-llm && bun test`（测试 keyless，零网络零真命令零真文件）。

## 登记表格式

登记表是唯一真源：必填 `id` / `runtime` / `port`，可选 `ctx` / `modelId` /
`apiBase` / `start` / `stop` / `note` / `source`：

```yaml
# ~/.dsh/local-models.yaml
models:
  - id: qwen3-4b                      # 条目 id（1-64 字符，start/stop/call 用它点名）
    runtime: docker                   # docker | native
    port: 8081                        # 1-65535 整数（缺省 apiBase 据此拼 http://127.0.0.1:<port>/v1）
    ctx: 32768                        # 可选：上下文窗口
    modelId: "qwen3:4b"               # 可选：API 侧模型名（缺省用 id）
    apiBase: http://127.0.0.1:8081/v1 # 可选：OpenAI 兼容端点（含 /v1）
    start: "docker run -d --name qwen4b -p 8081:80 vllm/qwen"   # 可选：启停命令（过审批门）
    stop: "docker rm -f qwen4b"
    note: 备注自由文本                 # 可选：≤500 字符
    source: "hf:Qwen/Qwen3-4B"        # 可选：模型来源（local-llm-pull 自动写入）
  - id: native-serve                  # 最小条目：id + runtime + port 即可
    runtime: native
    port: 8090
```

解析子集（零依赖手写解析器，不支持即显式报错不猜）：顶层仅 `models:` 一个键，
条目为 `- key: value` 平铺标量；支持注释、引号串、整数。**不支持**锚点（`&`/`*`）、
流式（`|`/`>`）、嵌套结构、行内列表、裸 YAML 布尔（true/false 请加引号）——
越子集的登记表会带行号报错，修好即生效，无需重启。

## 路径与覆盖

登记表路径三档优先级：插件 `config.registryPath` ＞ 环境变量
`DSH_LOCAL_MODELS_REGISTRY` ＞ 缺省 `~/.dsh/local-models.yaml`。登记表不存在时
list/start/stop/call 统一返回不可用文案（pull 例外：可引导建表）；损坏/结构
不合法返回带路径与行号的错误（pull 对损坏登记表拒绝写入）。

## 审批门

`local-llm-start` / `local-llm-stop` 执行登记表里的任意 shell 命令（docker run/rm、
nohup serve……），`local-llm-pull` 有网络下载 + GB 级磁盘写 + 登记表写面——插件经
pre-execute 钩子对这三个实名一律 `ask`（人工批准），审批 reason 前缀
`dsh-local-llm:`。`local-llm-list` / `local-llm-call` 免审。启停命令超时 120s
终止并回显输出尾部（pull 的下载窗口独立可调，见上节）；单机自用场景，登记表
请只写你本人审过的命令。

## 从旧版迁移

早期版本把登记表放在旧的 home 子目录下、环境变量叫旧名。迁到新路径一条命令
（文件名不变，搬目录即可）：

```bash
mkdir -p ~/.dsh && mv ~/.genshu/local-models.yaml ~/.dsh/local-models.yaml
```

（若你设过旧名环境变量，同步改为 `DSH_LOCAL_MODELS_REGISTRY`。）

## npm（待发布）

```bash
npm install dsh-local-llm   # 占位：npm 发布另行拍板，当前请用上方 git 直装
```

`package.json` 已预留 `engines.dsh` 声明（发布时钉具体兼容范围）。License MIT。
