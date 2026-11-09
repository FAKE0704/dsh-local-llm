# dsh-local-llm

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that connects large language models running on your own machine to dsh: register models, check their status, start and stop inference services, chat with them directly, and download new models — all manageable from the Web UI.

## What it does

Once installed, the plugin adds five tools that any dsh agent can use:

| Tool | What it does | Confirmation |
| --- | --- | --- |
| `local-llm-list` | List registered local models and which are running | Not required |
| `local-llm-call` | Send a prompt to a local model and get its reply | Not required |
| `local-llm-start` | Start a local model's inference service | Confirmation each time |
| `local-llm-stop` | Stop a running inference service | Confirmation each time |
| `local-llm-pull` | Download a model from Hugging Face or ModelScope | Confirmation each time |

For tools that need confirmation, the agent asks you to approve each action. In the Web UI, you trigger these actions yourself by clicking buttons, so no extra confirmation appears.

Beyond the tools, the plugin also provides:

- **Chat integration**: registered local models are registered as model sources in dsh. Once a model is deployed (started), it shows up in the model picker in the Web UI and on the "Settings → Models" page, ready to use in conversations. Models that are not running are marked "Not running" in a muted color, and their status updates in real time.
- **"Settings → Local Models" page**: pick the directory where model files are stored, paste a Hugging Face / ModelScope address to download a new model, see each model's running status, and deploy or stop with one click.
- **Automatic status refresh**: running models are re-checked every 60 seconds. If an inference service is stopped from outside, the status in the UI updates automatically.

## Install

Install the plugin in dsh (requires dsh 0.2.1-alpha.1 or above, below 0.3.0):

```sh
dsh plugin install github:FAKE0704/dsh-local-llm
```

## Quick start

1. Open the dsh Web UI and go to "Settings → Local Models".
2. Choose a directory to store model files.
3. Paste a model address (for example `hf:org/name` or a ModelScope address), confirm, and the download starts.
4. Once the download finishes, click "Deploy" and the model appears in the conversation model picker.

You can also skip the UI and just ask the agent, for example: "Pull and deploy qwen3:4b for me".

## Model registry

All registered models are kept in a YAML file, resolved in this order:

1. The custom path set in plugin settings (editable on the "Settings → Local Models" page)
2. The `DSH_LOCAL_MODELS_REGISTRY` environment variable
3. The default location `~/.dsh/local-models.yaml`

## Environment notes

The "Settings → Local Models" page and chat integration rely on the dsh Web UI (served over a local HTTP server). If your host has no web server, the plugin falls back to tools-only mode — all five tools still work, just without the settings page.

## Community and support

- Report issues and suggestions in [GitHub Issues](https://github.com/FAKE0704/dsh-local-llm/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

## License

[MIT](LICENSE)
