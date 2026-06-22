<p align="center">
  <img src="assets/mimo-agent-icon.png" alt="MiMo Logo" width="128" height="128">
</p>

<h1 align="center">MiMo Agent</h1>

<p align="center">
  <strong>  VS Code coding assistant optimized for Xiaomi MiMo LLM (OpenAI-compatible).</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=mimo-agent.mimo-agent">
    <img src="https://img.shields.io/visual-studio-marketplace/v/mimo-agent.mimo-agent.svg?label=VS%20Code%20Marketplace" alt="VS Code Marketplace">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=mimo-agent.mimo-agent">
    <img src="https://img.shields.io/visual-studio-marketplace/i/mimo-agent.mimo-agent.svg" alt="Installs">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  </a>
  <a href="https://github.com/YSP0Github/MIMO-Agent">
    <img src="https://img.shields.io/github/stars/YSP0Github/MIMO-Agent?style=social" alt="GitHub Stars">
  </a>
</p>

<p align="center">
  <strong>🇨🇳 中文</strong> | <a href="#english">🇬🇧 English</a> | <a href="CHANGELOG.md">📋 Changelog</a> | <a href="https://yshome.top/HTML/mimo/mimo.html">🌐 Website</a>
</p>

---

## 🤖 MiMo Agent 是什么

MiMo Agent 是一个运行在 VS Code 内的本地 AI 编程助手。它可以阅读项目、搜索代码、编辑文件、运行命令、查看 Git diff、管理多轮任务，并通过 OpenAI 兼容 API 调用小米 MiMo、DeepSeek、OpenAI 或自定义模型端点。

如果 MiMo Agent 使用体验觉得还不错的朋友，希望能点个小星星⭐哦！🙏

当前版本：`v1.7.9`。

## ✨ 当前核心能力

### 🛠️ 编程代理

- 读取、创建、编辑文件，并在任务结束时展示本轮改动摘要和 diff。
- 全局搜索代码、按 glob 查找文件、读取文件元信息和目录结构。
- 执行 PowerShell/Bash 命令，用于安装项目依赖、运行测试、构建和本地验证。
- 使用 Git 工具查看状态、diff、日志和提交；对 push/commit 类任务有收敛检测，避免在已完成后反复检查。
- 在复杂任务中自动维护可视化待办清单，并在必要时拆分任务、推断依赖和安排执行顺序。

### 🔀 多模型与路由

- 支持小米 MiMo、DeepSeek、OpenAI、通义千问、智谱 GLM、Moonshot/Kimi、火山方舟、硅基流动、百度千帆、腾讯混元、OpenRouter、Groq、Google Gemini、Mistral AI、xAI Grok 和自定义 OpenAI-compatible endpoint。
- 设置页提供模型卡片：每个模型配置可以保存 provider、API Key、Base URL、默认模型和模型列表。
- `MiMo: Switch Model` 可以快速切换 API 配置和模型。
- 内部使用 endpoint-aware route，即 `endpoint_id + model`，同名模型可以安全存在于不同 API 地址下。
- 对 MiMo 系列模型提供能力识别和自动切换保护，例如图片输入时切换到已配置的视觉模型。

### 🧩 多模态 MCP

MiMo Agent 默认内置 `mimo_multimodal` MCP server，让文本/Pro 模型可以先调用多模态模型处理媒体，再继续做代码推理。

内置工具包括：

| 工具                    | 能力                                    |
| ----------------------- | --------------------------------------- |
| 🖼️`analyze_image`   | 分析图片、截图、UI 状态、可见文字或代码 |
| 🎧`analyze_audio`     | 理解音频内容，包括语音和非语音信息      |
| 🎬`analyze_video`     | 总结视频画面、动作、字幕和音频信息      |
| 📝`transcribe_audio`  | 转写语音音频                            |
| 🔊`synthesize_speech` | 生成语音文件并保存到本地                |

默认多模态模型为 `mimo-v2.5`，默认 TTS 模型为 `mimo-v2.5-tts`，默认 ASR 模型为 `mimo-v2.5-asr`。可通过 `MIMO_OMNI_MODEL`、`MIMO_TTS_MODEL`、`MIMO_ASR_MODEL` 覆盖；如需关闭内置多模态 server，可在 `~/.mimo/settings.json` 设置 `"mcp": { "builtin_multimodal": false }`。

### 🎯 工作模式

| 模式        | 图标 | 说明                                                                | 适合场景                         |
| ----------- | ---- | ------------------------------------------------------------------- | -------------------------------- |
| Auto        | 🔄   | 默认模式。根据任务自动判断是否需要工具、编辑和验证。                | 日常编码、修 Bug、解释项目       |
| Polling     | ⏩   | 更持续地推进任务，并在需要时保留确认流程。                          | 较长任务、连续检查               |
| Plan        | 📋   | 先只读分析并生成计划，确认后再执行。计划会保存到 `.mimo/plans/`。 | 大改动、架构调整、风险较高的任务 |
| Adversarial | ⚔️ | 构建者和审查者分离，迭代发现问题并收敛。                            | 代码审查、安全/质量检查          |
| Infinite    | ♾️ | 面向长任务的持续推进模式，带更高轮次预算、停滞保护和上下文压缩。    | 大型迁移、长时间探索             |

### 🧠 任务编排

- `schedule_tasks`：拆分多任务请求，估算复杂度、依赖关系和优先级。
- `update_todos`：更新聊天界面中的任务清单。
- `run_workflow`：执行顺序/并行混合工作流。
- Sub-agent：支持只读 Explore 子代理和可执行 General 子代理，减少主对话上下文污染。

### 🧭 上下文、记忆与恢复

- 自动上下文压缩：长对话会压缩旧消息，保留近期上下文和摘要。
- 本地记忆：可以从明确偏好和成功验证命令中学习，保存在本地 `.mimo` 数据目录。
- 推理循环检测：识别重复 Thought 或停滞状态，并触发 fresh model recovery。
- 任务完成门：复杂任务不会只凭口头判断结束，通常需要文件、命令或 Git 证据。
- 历史记录：按工作区保存会话，支持搜索、加载、删除、导出 Markdown/JSON。
- 多窗口隔离：VS Code 多窗口运行态、记忆和 token 统计相互隔离，历史记录按工作区持久化。

### 🔒 安全执行

- Safe Mode 是默认本地受保护执行方式，包含命令检查、工作区路径边界、超时、输出截断和命令审计。
- Docker Mode 可选，使用容器隔离执行命令，需要 Docker Desktop。
- Git 自动快照默认关闭；启用后会在破坏性命令前创建可回滚提交。
- 项目依赖安装可自动处理；系统软件安装默认需要确认或会被策略阻止。
- Web fetch/search 结果、文件内容和命令输出都被视为数据，不会覆盖系统/用户指令。

### 🎨 界面体验

- 中文/英文界面切换。
- 图片粘贴输入。
- 语音输入。
- 现代模型选择器、模式选择器、推理强度控制。
- 长任务消息队列：可以编辑、移除或立即运行排队消息。
- Thought、工具调用、workflow、diff 和已编辑文件卡片均支持折叠/复盘。

## 🚀 快速开始

### 1. 📦 安装扩展

在 VS Code Marketplace 搜索 **MiMo**，或使用命令面板/扩展页安装：

[![Install](https://img.shields.io/badge/Install-MiMo-blueviolet?style=for-the-badge&logo=visual-studio-code)](vscode:extension/mimo-agent.mimo-agent)

### 2. 🔑 配置 API

1. 打开命令面板：`Ctrl+Shift+P` / `Cmd+Shift+P`
2. 运行 `MiMo: Settings`
3. 添加一个模型配置，填写 API Key、Base URL 和模型 ID
4. 点击 Save and Apply

MiMo Token Plan 官方默认地址：

```text
https://token-plan-cn.xiaomimimo.com/v1
```

常见模型示例：

```text
mimo-v2.5-pro
mimo-v2.5
mimo-v2-pro
mimo-v2.5-tts
```

也可以从设置页选择 DeepSeek、OpenAI、通义千问、智谱 GLM、Moonshot/Kimi、火山方舟、硅基流动、百度千帆、腾讯混元、OpenRouter、Groq、Google Gemini、Mistral AI、xAI Grok 等预设，或配置任何 OpenAI 兼容服务。

### 3. 💬 开始使用

- `MiMo: Open Chat`：打开聊天视图。
- `MiMo: New Chat Window`：创建新的聊天窗口。
- 在聊天输入框选择模型、模式和推理强度。
- 选中代码后可从右键菜单或命令面板运行解释、审查、重构。

## 💡 使用示例

| 场景          | 你可以这样说                       | MiMo Agent 会做什么                  |
| ------------- | ---------------------------------- | ------------------------------------ |
| 🧭 项目理解   | 分析这个项目的结构和主要入口       | 搜索目录、读取关键文件、总结架构     |
| 🐞 Bug 修复   | 测试失败了，帮我定位并修复         | 运行测试、读报错、编辑文件、再次验证 |
| ♻️ 重构     | 把这个模块整理得更清晰，不要改行为 | 读相关代码、做小步改动、跑编译/测试  |
| 📚 文档       | 根据当前功能重写 README            | 从代码和配置反推功能，更新文档       |
| 🖼️ 图片问题 | 粘贴一张报错截图                   | 调用视觉模型提取信息，再给出修复路径 |
| 🧵 长任务     | 把配置页模型管理体验完整优化一遍   | 拆任务、更新 todo、分阶段执行和验证  |
| 🔍 审查       | 审查这次改动是否有安全或回归风险   | 进入审查姿态，优先列出问题和证据     |

## 🔧 命令面板

| 命令                           | 说明                    |
| ------------------------------ | ----------------------- |
| 💬`MiMo: Open Chat`          | 打开当前聊天视图        |
| 🪟`MiMo: New Chat Window`    | 新建聊天窗口            |
| ⚙️`MiMo: Settings`         | 打开设置界面            |
| 🔀`MiMo: Switch Model`       | 快速切换 API 配置和模型 |
| 🧹`MiMo: Clear Conversation` | 清空当前对话            |
| 📖`MiMo: Explain Code`       | 解释选中的代码          |
| 🔍`MiMo: Review Code`        | 审查选中的代码          |
| ♻️`MiMo: Refactor Code`    | 重构选中的代码          |

## ⚙️ 配置

MiMo Agent 同时支持 VS Code 设置和本地配置文件：

- VS Code 设置：`mimo.apiKey`、`mimo.baseUrl`、`mimo.model` 等。
- 本地配置：`~/.mimo/settings.json`，优先级高于环境变量和 VS Code 设置。
- 环境变量：`MIMO_API_KEY`、`MIMO_BASE_URL`、`MIMO_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 等。

配置优先级：

```text
~/.mimo/settings.json > environment variables > VS Code settings > defaults
```

常用 `~/.mimo/settings.json` 示例：

```json
{
  "api": {
    "active_provider_profile": "mimo",
    "active_route": {
      "endpoint_id": "mimo",
      "model": "mimo-v2.5-pro"
    },
    "provider_profiles": [
      {
        "id": "mimo",
        "name": "MiMo",
        "provider": "mimo",
        "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
        "api_key": "YOUR_API_KEY",
        "model": "mimo-v2.5-pro",
        "models": ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-mini"]
      }
    ]
  },
  "agent": {
    "max_tokens": 8192,
    "max_rounds": 0,
    "temperature": 0.7,
    "top_p": 0.95,
    "enable_thinking": false,
    "reasoning_effort": "balanced"
  },
  "sandbox": {
    "enabled": false,
    "mode": "safe",
    "git_snapshot": false,
    "logging": true,
    "network_disabled": true
  },
  "context": {
    "auto_compress": true,
    "summarize_at_percent": 70,
    "summarize_at_messages": 48,
    "keep_recent_messages": 18,
    "max_summary_tokens": 1200
  },
  "memory": {
    "enabled": true,
    "learn_from_explicit_preferences": true,
    "max_items": 120,
    "max_injected": 8
  },
  "dependency_install": {
    "enabled": true,
    "project_mode": "auto",
    "system_mode": "confirm",
    "long_timeout_sec": 600
  },
  "mcp": {
    "builtin_multimodal": true,
    "servers": []
  }
}
```

常用配置项：

| 配置项                              | 说明                                                     | 默认值               |
| ----------------------------------- | -------------------------------------------------------- | -------------------- |
| `api.provider_profiles`           | API/模型配置列表                                         | `[]`               |
| `api.active_provider_profile`     | 当前启用的 provider profile ID                           | 自动推断             |
| `api.active_route`                | 当前调用路由 `{ endpoint_id, model }`                  | 当前 profile + model |
| `agent.max_tokens`                | 单次响应最大 token                                       | `8192`             |
| `agent.max_rounds`                | 最大工具调用轮次，`0` 表示由当前推理模式自动管理预算   | `0`                |
| `agent.reasoning_effort`          | `turbo` / `fast` / `balanced` / `deep` / `max` | `balanced`         |
| `safety.max_output_len`           | 工具输出截断长度                                         | `5000`             |
| `safety.command_timeout`          | 普通命令超时秒数                                         | `120`              |
| `sandbox.mode`                    | `safe` 或 `docker`                                   | `safe`             |
| `mcp.servers`                     | 外部 MCP server 列表                                     | `[]`               |
| `memory.enabled`                  | 是否启用本地记忆                                         | `true`             |
| `dependency_install.project_mode` | 项目依赖安装策略：`auto` / `confirm` / `disabled`  | `auto`             |
| `dependency_install.system_mode`  | 系统软件安装策略：`confirm` / `disabled`             | `confirm`          |

## 🔌 MCP 配置

除内置 `mimo_multimodal` 外，也可以在 `~/.mimo/settings.json` 配置外部 MCP server：

```json
{
  "mcp": {
    "servers": [
      {
        "name": "example",
        "command": "node",
        "args": ["path/to/server.js"],
        "env": {},
        "timeoutMs": 30000
      }
    ]
  }
}
```

外部 MCP 工具会以 `mcp_<server>_<tool>` 的形式暴露给模型，并进行基础风险审计。

## 🧰 项目指令与技能

### 📌 项目指令

MiMo Agent 会读取项目或用户级指令文件：

1. 当前工作区：`MIMO.md` > `Agent.md` > `claude.md`
2. 用户目录：`~/.mimo/MIMO.md`

这些指令会作为偏好注入，但不能覆盖安全策略、工具边界或当前用户请求。

### 🧪 Skills

内置技能位于 `skills/*.md`：

- `debug`
- `doc`
- `explain`
- `git`
- `refactor`
- `review`
- `test`

用户自定义技能可以放在：

```text
~/.mimo/skills/<name>.md
```

聊天界面也支持技能列表、保存和删除。

## 📋 系统要求

- VS Code `1.85.0` 或更高版本。
- Node.js 环境用于扩展开发。
- API Key：MiMo、DeepSeek、OpenAI 或其他 OpenAI-compatible endpoint。
- Docker Desktop 可选，仅 Docker sandbox 模式需要。

## 🧑‍💻 本地开发

```bash
git clone https://github.com/YSP0Github/MIMO-Agent.git
cd MIMO-Agent
npm install
npm run compile
```

常用脚本：

| 命令                | 说明                           |
| ------------------- | ------------------------------ |
| `npm run compile` | 编译 TypeScript 并构建 webview |
| `npm run watch`   | TypeScript watch 模式          |
| `npm test`        | 编译并运行测试                 |
| `npm run package` | 生成 VSIX 发布包               |

发布前建议：

1. 更新 `package.json` 和 `package-lock.json` 版本。
2. 更新 `CHANGELOG.md`。
3. 运行 `npm run compile` 和 `npm test`。
4. 运行 `npm run package`。
5. 将 VSIX 放入 `releases/`。

## 📜 版本记录

详细版本记录见 [CHANGELOG.md](CHANGELOG.md)。

`v1.7.8` 重点：

- 修复纯方案/规划/分析任务已经交付并等待用户确认时，Auto 模式仍继续触发验证补充和重复完成总结的问题。
- 长方案自动另存文件名现在优先从用户需求生成，例如 `mimo-plan-*`，不再使用助手寒暄句作为文件名。
- 中文长回复自动另存提示改为 `已另存为:`。

`v1.7.6` 重点：

- 新增 AI 电脑管家工具：多 Agent 任务编排系统，支持代码、文件、系统、浏览器四类 Agent 自动调度。
- 修复 Webview 消息组件中字符编码问题和类型安全检查。
- 新增任务变更编辑计数和确认输入 i18n 翻译键。

`v1.7.5` 重点：

- 输入框支持 `#` 和 `+` 快捷引用项目文件，文件以 inline token 显示并在发送时转换为完整路径。
- 修复 MiMo 多轮工具调用中 `reasoning_content` 被压缩后继续发送，可能导致 400 请求体格式错误的问题。
- 优化历史 Thought 回放、输入历史恢复、Diff 计数、旧 Diff 卡片和长输出性能，降低卡顿与误导性 UI。
- 思考内容隐藏提示不再暴露内部协议字段，实时运行保护长草稿，历史记录仍可展开查看已保存过程。

`v1.7.4` 重点：

- 修复 VS Code Remote WSL 中系统代理注入 `PROXY 127.0.0.1:7890` 时 MiMo API 请求失败的问题。
- 为 WSL loopback 代理场景加入直接 socket 请求路径，并修复 SSE 流式响应等待连接关闭导致耗时过长的问题。
- Bash 工具卡片在命令完成后默认保持 Hide/折叠，长命令输入和输出需要手动 Show 查看。

`v1.7.0` 重点：

- 回复底部新增复制、重试、继续和反馈等轻量操作按钮，旧回复悬停显示，减少界面跳动。
- 标题栏新增上下文占用百分比和完整 token 提示，便于判断长对话风险。
- 输出总结中的 URL 和本地文件路径会渲染为可点击链接，本地路径可直接在 VS Code 中打开。
- 增强 MIMO 系列模型识别、错误归因和中断恢复提示，尽量区分 Agent、模型、API、本地环境和用户操作原因。
- Safe Mode 放宽普通公开下载，保留 SSRF/内网目标拦截；workspace 外文件默认可读，写改删前会更谨慎并备份。

`v1.6.9` 重点：

- Shell 命令和 workflow 子任务会输出更明确的执行目的与阶段进度，减少只有 Bash 卡片但缺少说明的情况。
- 项目/用户指令校验降低误报和重复警告，同时仍会拦截会破坏 agent 能力的指令。
- 中断恢复和停止保护摘要会补充验证状态、已检查文件、已改文件和下一步。

## 🤝 反馈与贡献

- Issues: [https://github.com/YSP0Github/MIMO-Agent/issues](https://github.com/YSP0Github/MIMO-Agent/issues)
- Repository: [https://github.com/YSP0Github/MIMO-Agent](https://github.com/YSP0Github/MIMO-Agent)
- Website: [https://yshome.top/HTML/mimo/mimo.html](https://yshome.top/HTML/mimo/mimo.html)
- License: [MIT](LICENSE)

---

<h2 id="english">English</h2>

## 🤖 What Is MiMo Agent

MiMo Agent is a local AI coding assistant for VS Code. It can inspect your workspace, search code, edit files, run commands, review Git diffs, manage long-running tasks, and call Xiaomi MiMo, DeepSeek, OpenAI, or custom OpenAI-compatible endpoints.

Current version: `v1.7.8`.

## 1.7.8 Highlights

- Fixed Auto mode continuing into extra verification after planning-only analysis had already been delivered and was waiting for user confirmation.
- Long saved planning summaries now use task-derived filenames such as `mimo-plan-*` instead of assistant chatter.
- Chinese long-response save notices now use `已另存为:`.

## 1.7.6 Highlights

- Added the AI Butler tool: a local multi-agent task orchestration system for code, file, system, and browser agents.
- Fixed Webview message encoding issues and added safer message-copy type checks.
- Added task-change edit counts and confirmation-input i18n keys.

## 1.7.4 Highlights

- Fixed MiMo API requests in VS Code Remote WSL when the system proxy injects `PROXY 127.0.0.1:7890`.
- Added a direct socket request path for WSL loopback-proxy bypass and fixed slow SSE completion by resolving on `data: [DONE]`.
- Bash tool cards now remain hidden/collapsed by default after command completion; click Show to inspect command input and output.

## 1.7.0 Highlights

- Added assistant reply actions for copy, retry, contextual continue, and feedback with hover-only archived controls.
- Added a live context-usage badge in the header with staged colors and exact token totals on hover.
- Made final summaries more actionable by hyperlinking safe URLs and local Windows file paths.
- Improved MiMo-model error attribution and interruption recovery so failures explain whether the likely source is the agent, model, API, local environment, or user action.
- Refined Safe Mode networking: normal public downloads are allowed after URL checks, while unsafe/internal network targets remain blocked.
- Allowed opening files outside the workspace for read-oriented navigation while keeping external mutation paths guarded by backup behavior.

## ✨ Highlights

- 🛠️ Workspace-aware coding agent with file read/write/edit, regex search, glob search, shell execution, Git status/diff/log/commit, web search, and URL fetch.
- 🔀 OpenAI-compatible provider profiles with endpoint-aware model routing and presets for common domestic/international providers.
- 🧩 Built-in `mimo_multimodal` MCP server for image, audio, video, transcription, and text-to-speech workflows.
- 🎯 Five work modes: Auto, Polling, Plan, Adversarial, and Infinite.
- 🧠 Task scheduling, visible todos, sequential/parallel workflow execution, and focused sub-agents.
- 🧭 Context compression, local memory, reasoning-loop recovery, completion gates, and workspace-level history.
- 🔒 Safe Mode command checks by default, optional Docker sandbox, optional Git snapshots, and dependency-install policy controls.
- 🎨 Chinese/English UI, image paste, voice input, queue controls, rich tool cards, Thought replay, and diff review cards.

## 🚀 Quick Start

1. Install **MiMo** from the VS Code Marketplace.
2. Run `MiMo: Settings` from the Command Palette.
3. Add a provider profile with API Key, Base URL, and model ID.
4. Run `MiMo: Open Chat` or `MiMo: New Chat Window`.

Default MiMo endpoint:

```text
https://token-plan-cn.xiaomimimo.com/v1
```

Common MiMo models:

```text
mimo-v2.5-pro
mimo-v2.5
mimo-v2-pro
mimo-v2-mini
```

## 🔧 Commands

| Command                        | Description                       |
| ------------------------------ | --------------------------------- |
| 💬`MiMo: Open Chat`          | Open the current chat view        |
| 🪟`MiMo: New Chat Window`    | Create a new chat window          |
| ⚙️`MiMo: Settings`         | Open the settings UI              |
| 🔀`MiMo: Switch Model`       | Switch provider profile and model |
| 🧹`MiMo: Clear Conversation` | Clear the current conversation    |
| 📖`MiMo: Explain Code`       | Explain selected code             |
| 🔍`MiMo: Review Code`        | Review selected code              |
| ♻️`MiMo: Refactor Code`    | Refactor selected code            |

## ⚙️ Configuration

MiMo Agent supports VS Code settings, environment variables, and `~/.mimo/settings.json`.

Priority:

```text
~/.mimo/settings.json > environment variables > VS Code settings > defaults
```

Common local settings are under `api`, `agent`, `sandbox`, `context`, `memory`, `dependency_install`, and `mcp`. See the Chinese configuration section above for a complete example.

## 🧑‍💻 Development

```bash
git clone https://github.com/YSP0Github/MIMO-Agent.git
cd MIMO-Agent
npm install
npm run compile
npm test
```

Useful scripts:

| Script              | Description                              |
| ------------------- | ---------------------------------------- |
| `npm run compile` | Compile TypeScript and build the webview |
| `npm run watch`   | Start TypeScript watch mode              |
| `npm test`        | Compile and run tests                    |
| `npm run package` | Build a VSIX package                     |

## 📜 Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Website

[https://yshome.top/HTML/mimo/mimo.html](https://yshome.top/HTML/mimo/mimo.html)

## 📄 License

[MIT](LICENSE)
