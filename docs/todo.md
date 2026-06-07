# minicode TODO

## 目标

构建一个精简但可扩展的本地智能体框架，最终走向类似 Manus 的开源产品雏形：能理解任务、规划步骤、读写工作区、执行代码、调用外部能力，并把过程沉淀为可审计的 session。

minicode 的内核不应该预置一堆垂直领域工具。天气、新闻、论文检索这类能力更适合由临时脚本、Skill、MCP server 或插件提供。核心要稳定的是 agent loop、文件系统、shell/code execution、权限、sandbox、session、skills 和 MCP。

## 原则

- 核心链路优先：用户输入 -> LLM stream -> 工具调用 -> 工具结果回填 -> 继续推理 -> 最终回答。
- 默认工具保持小而通用：读文件、搜索文件、写文件、编辑文件、执行命令。
- 遇到实时信息或垂直任务时，agent 应先检查已有工具/skills；没有可靠工具时，创建 `.minicode/tmp/` 下的临时脚本或 shell 命令完成任务。
- 临时脚本的结果要可追溯：记录数据来源 URL、访问时间、命令或脚本路径。
- MCP、Skills、Sandbox 是一等模块，不当作边角插件处理。
- 每个模块都要有明确验收方式，不能只写完代码不验证。

## 当前进度

- 2026-05-30：阶段 0 已完成项目骨架、最小 CLI、基础配置、错误类型、ID 生成、日志工具和单元测试。
- 2026-05-30：已完成一版最小闭环：
  - LLM adapter：OpenAI-compatible streaming，provider 失败会返回结构化 `error` event。
  - Session：Memory + JSONL store，支持 session list/show 和 JSONL resume。
  - Tools：`read`、`grep`、`glob`、`shell`、`write`、`edit`、`patch`、`todo`。
  - Permission：`allow/ask/deny`，非交互 ask 默认拒绝，`--yes` 可自动批准。
  - Sandbox：workspace path guard、外部路径权限触发、shell timeout/env/output 截断、git worktree sandbox。
  - Agent Harness：工具调用闭环、maxSteps、事件流、JSON 输出、compaction。
  - MCP：stdio + HTTP JSON-RPC list/call tools，并转换为内部工具。
  - Skills：本地 `SKILL.md` 扫描、加载、相对路径保护和 `skill` 工具。
  - SkillHub：Skills API provider、搜索、安装计划、安装到本地 skills；真实 SkillHub search 需要 `SKILLHUB_API_KEY`，默认不暴露给 agent 自动调用。
  - CLI：`run/chat/session/config/tool/skill/mcp` 子命令，`run --session` 支持 session resume，Ctrl+C signal 会传入 LLM/tool。
- 2026-06-04：产品方向收敛：
  - 移除用户可见的离线启发式 agent 模式；`run/chat` 必须使用真实 provider。
  - 移除内置天气、新闻、论文、网页搜索等垂直联网工具。
  - 默认 agent 工具收敛为核心文件与执行能力。
  - `.minicode/tmp/` 作为临时脚本和一次性任务代码的默认落点，并加入 `.gitignore`。
- 2026-06-05：Harness 升级：
  - 新增真实 CLI subprocess harness，隔离 HOME、项目目录、provider 配置和 session workspace。
  - 新增 OpenAI-compatible fake LLM server，支持请求匹配、tool/text/http error、raw SSE、stream error、delay、reset 和 hang。
  - 新增 scenario harness，可断言 stdout/stderr、JSONL events、workspace 文件、LLM 请求内容，并在失败时写出取证信息。
  - 已覆盖普通 run、`--json`、workspace 写入、session resume、provider error、天气式写文件场景、请求匹配、stream parse error、provider hang timeout 和并发 workspace 隔离。
  - 已补强 fake LLM 观测接口、完整 evidence bundle 内容和安全 spawn handle，避免测试失败时泄漏子进程。
- 2026-06-05：Skills 第一阶段升级：
  - 本地 Skills 目标从“可扫描/可加载”提升为“可诊断、可搜索、可安全读取参考文件”的 instruction layer。
  - `skill search` 规划为本地搜索，`skill search --remote` 才显式访问 SkillHub。
  - `skill` 工具会返回主说明、参考文件列表和 source metadata，并允许通过安全相对路径读取 skill 内参考文件。
- 2026-06-05：Skills 第二阶段升级：
  - SkillHub install 改为 review-first：未加 `--yes` 只展示安装计划，不写文件。
  - 远程文件路径在写入前会拒绝空路径、绝对路径、NUL 字节和 `..` 路径穿越。
  - 确认安装后会写入 `.source.json` provenance manifest，记录远程来源、安装时间、目标目录、文件大小和 SHA-256 摘要。
- 2026-06-05：MCP 第一阶段升级：
  - 新增 MCP server 状态模型：`connected`、`failed`、`disabled`。
  - `minicode mcp list` 会展示状态、工具数量和错误摘要，`--json` 输出结构化状态。
  - stdio MCP 会捕获 stderr、在退出/错误/超时时清理 pending 请求，并在 close 时终止子进程。
  - MCP tool import 会 sanitize 名称、检测冲突，并把缺失或无效 input schema 归一成 object schema。
- 2026-06-05：Live provider smoke 最小闭环：
  - 新增 opt-in `bun run smoke:live`，默认 `bun test` 不触发真实 provider。
  - 覆盖纯文本、工具写文件、临时脚本/证据文件三类真实 provider smoke。
  - smoke 会生成 Markdown 报告，记录 provider/model、session id、tool calls、产物文件和 pass/fail。
  - 脚本自身有 fake provider 回归测试，覆盖成功报告、失败报告和缺 key fail-fast。
- 2026-06-05：Sandbox / Permission 第二阶段硬化：
  - Permission decision 会记录 matched rule index/tool/pattern/action，并保留 auto-approved/denied ask 的 original action。
  - Tool result metadata 会带上 permission action/reason/rule；shell 会额外带风险分类和命令审计信息。
  - Shell 审计记录 command、cwd、exit code、timeout、duration、stdout/stderr byte count 和 truncation flags。
  - 增加 shell 风险分类：read 低风险，write/delete/network/package/git 提升风险。
  - 增加显式测试：shell redirection 写出 workspace 被阻止、`.minicode/tmp` 可写、env allowlist 不暴露 provider key。
  - Live smoke 增加 per-case timeout，并对 report 做 secret redaction。
- 2026-06-05：Workspace / Container 第一阶段计划：
  - 下一阶段准备抽象 `WorkspaceBackend`，把 session 文件位置和 shell/code 执行位置拆开。
  - 当前 `sandbox.mode: "workspace"` 会作为默认 backend 保持不变，继续使用 `workspace/<session-id>`。
  - 计划引入 optional `container` backend 的配置形状，但默认测试不依赖 Docker/Podman。
  - 默认测试会先用 fake container runner 验证 backend 逻辑；真实容器 smoke 必须 opt-in。
  - 计划补 workspace status / cleanup 雏形，记录 backend、workspace path、cleanup 状态和失败取证。
- 2026-06-05：Skills CLI ergonomics：
  - 新增 `minicode skill init <name>`，从命令行创建本地 `SKILL.md`。
  - 新增 `minicode skill path list/add/remove`，可直接维护项目 `minicode.jsonc` 里的 `skills.paths`。
  - 新增 `minicode skill doctor`，汇总 skills paths、已发现 skills 和诊断信息。
- 2026-06-05：MCP CLI configuration lifecycle：
  - 新增 `minicode mcp add stdio <name> -- <command> [args...]` 和 `minicode mcp add http <name> <url>`。
  - 新增 `minicode mcp enable/disable/remove <name>`，可直接维护项目 `minicode.jsonc` 里的 MCP server。
  - 新增 `minicode mcp doctor [--json]`，汇总 configured/connected/failed/disabled，并在有 failed server 时返回非零退出码。
  - `mcp add` 支持 `--json`、`--yes`、`--timeout-ms`、stdio `--env` 和 http `--header`，默认避免误覆盖已有 server。
- 2026-06-05：Online CLI smoke：
  - 使用真实 SiliconFlow provider 跑通 `minicode run`、skills CLI、MCP CLI、Python 写文件/执行、skill 加载行程规划和 MCP 工具调用。
  - 冒烟测试暴露并修复 stdio MCP client 生命周期问题：metadata CLI 命令不会再因 MCP 子进程挂住，agent run 完成后会关闭 MCP client。
  - 新增回归测试覆盖配置 MCP 后 `skill list/tool list` 能退出，以及 `run` 完成后能释放 stdio MCP client。

当前验证要求：

- `bun run typecheck` 通过。
- `bun test` 通过。
- 真实 provider 测试必须显式 opt-in，避免误扣费。
- 涉及真实网络的数据任务默认由 agent 通过 shell/临时脚本完成，并在产物中记录来源。

## 目录规划

```text
src/
  cli/
  agent/
  llm/
  session/
  tools/
  mcp/
  skills/
  sandbox/
  permission/
  workspace/
  config/
  runtime/
  shared/
```

## 阶段 1：真实 LLM Adapter

### 要做

- 定义统一模型接口：`LLMClient.stream(input)`。
- 支持 OpenAI-compatible provider。
- 支持 system messages、普通文本消息、工具定义、tool choice。
- 将 provider stream 归一成内部事件：
  - `text_start`
  - `text_delta`
  - `text_end`
  - `tool_call`
  - `tool_result`
  - `reasoning_delta`
  - `finish`
  - `error`

### 验证

- 用一个简单 prompt 能拿到流式文本。
- 模型请求失败时返回结构化错误，而不是直接崩溃。
- 流式输出不会丢 token，不会重复拼接。
- 测试中可以用脚本化 LLM fixture 复现 text 和 tool call 事件，但该 fixture 不作为产品功能暴露。

## 阶段 2：Session 和 Message Store

### 要做

- 定义 message schema：
  - user message
  - assistant message
  - tool call part
  - tool result part
  - reasoning part
  - error part
- 实现 `MemorySessionStore`。
- 实现 `JsonlSessionStore`，每个 session 一个 JSONL 文件。
- 支持创建 session、追加消息、读取历史、列出 session。

### 验证

- 创建 session 后能写入用户消息和助手消息。
- 进程重启后，JSONL session 能被重新读取。
- 损坏的 JSONL 行不会导致整个项目无法启动，应给出可理解错误。
- 单元测试覆盖 append/read/list。

## 阶段 3：核心工具

### 要做

- 定义工具接口：`name`、`description`、`inputSchema`、`execute`。
- 实现工具注册表。
- 默认工具：
  - `read`
  - `grep`
  - `glob`
  - `shell`
  - `write`
  - `edit`
  - `patch`
  - `todo`
- 工具执行上下文包含 session、cwd、abort signal、permission ask、metadata update。

### 验证

- 每个工具都有输入 schema。
- 模型传入非法参数时，返回可让模型修正的错误。
- `read/grep/glob` 对不存在路径有清晰错误。
- `write/edit/patch` 能生成变更摘要。
- `shell` 支持超时、取消和输出截断。

## 阶段 4：临时脚本工作流

### 要做

- 将 `.minicode/tmp/` 作为临时任务脚本默认目录。
- system prompt 明确：没有可靠专用工具时，使用 shell 或临时脚本完成任务。
- 文档给出“查询武汉天气并写 Markdown”的示例。
- 后续可增加 `scratch` 或 `tmp_script` 辅助工具，但第一版先复用 `write` + `shell`。

### 验证

- agent 能为一次性任务创建脚本、执行脚本、读取输出，并写入目标文件。
- 临时脚本不会被默认提交。
- 外部信息任务的产物包含来源 URL、访问时间和必要的解析说明。
- 失败时保留可排查的脚本路径和命令输出。

## 阶段 5：Permission

### 要做

- 实现规则：`allow`、`ask`、`deny`。
- 支持按 tool name 和 pattern 匹配。
- 支持 session 级权限和全局默认权限。
- 非交互模式下 `ask` 默认拒绝或可通过 `--yes` 自动批准。

### 验证

- deny 规则能阻止工具执行。
- allow 规则能跳过确认。
- ask 规则能产生 permission request。
- 非交互模式下不会无限等待用户输入。
- shell/edit/write 这类高风险工具默认需要确认。

## 阶段 6：Agent Harness

### 要做

- 实现 agent runner 主循环。
- 支持最大 step 限制。
- 支持工具调用后把结果回填给模型。
- 支持中断、取消、错误恢复。
- 支持事件输出，供 CLI 渲染或测试断言。
- 支持 agent 配置：name、system prompt、model、tools、maxSteps。

### 验证

- 文本问答能正常结束。
- 模型请求工具时，工具执行结果能进入下一轮模型上下文。
- 连续多次工具调用不会丢状态。
- 达到 maxSteps 时能停止并给出明确提示。
- 脚本化 LLM fixture 能覆盖 runner 的完整闭环。

## 阶段 7：Sandbox 和执行边界

### 要做

- 实现 path guard：默认只允许访问 workspace 内路径。
- 访问外部目录时触发 permission。
- shell runner 支持 cwd、timeout、env 白名单、输出截断。
- 实现 git worktree sandbox：
  - 创建隔离 worktree
  - 在 sandbox 中运行 agent
  - 清理 sandbox
- 标记高风险目录，避免扫描系统隐私目录。

### 验证

- 工具无法静默读取 workspace 外文件。
- shell 命令默认在指定 cwd 中运行。
- 超时命令会被终止。
- worktree sandbox 创建后不污染原工作区。
- 删除 sandbox 后相关目录和分支被清理。

## 阶段 8：MCP

### 要做

- 支持 local MCP server。
- 支持 remote MCP server。
- 将 MCP tools 转换为内部 ToolDefinition。
- 支持 MCP 工具超时和错误包装。
- 预留 OAuth/auth 接口，第一版可先只支持 header/token。

### 验证

- 能启动一个本地 MCP server 并列出 tools。
- MCP tool 能被 agent 调用。
- MCP server 不可用时，不影响内置工具启动。
- MCP 工具超时能返回结构化错误。
- MCP tool schema 能正确暴露给 LLM。

## 阶段 9：Skills 和 SkillHub

### 要做

- 支持扫描 `skills/**/SKILL.md`。
- 解析 skill metadata：name、description。
- 在 system prompt 中列出可用 skills。
- 实现 `skill` 工具，按需加载完整 skill 内容。
- skill 内容中相对路径基于 skill 根目录解析。
- 支持 SkillHub 搜索和安装到本地目录。
- SkillHub 默认通过 CLI 手动使用；只有用户在配置中显式加入时，agent 才能自动调用远程搜索/安装工具。
- 记录 skill 来源、版本或更新时间，方便之后升级和审计。

### 验证

- 能发现本地 skill。
- 缺少 name/description 的 skill 有清晰错误。
- agent 能调用 skill 工具并把内容注入上下文。
- 不存在的 skill 返回可理解错误，并列出可用 skill。
- 远程 skill 安装前展示来源和将写入的路径。

## 阶段 10：Config

### 要做

- 设计最小配置 schema：
  - default model
  - providers
  - agents
  - tools
  - permissions
  - mcp
  - skills paths
  - skillhub
  - sandbox policy
- 支持项目配置文件：`minicode.jsonc`。
- 支持环境变量覆盖 API key。
- 支持 config validate 命令。

### 验证

- 无配置时能用合理默认值启动 metadata 命令。
- `run/chat` 没有真实 provider key 时明确失败。
- 配置错误时指出具体字段。
- 环境变量能覆盖 provider key。
- `minicode config validate` 能检查配置。

## 阶段 11：CLI 和渲染

### 要做

- `minicode run "message"`：单轮非交互运行。
- `minicode chat`：简单交互模式。
- `minicode session list/show`。
- `minicode mcp list/test`。
- `minicode skill list/show/search/install`。
- `minicode tool list`。
- 默认输出人类可读，同时支持 `--json` 输出事件流。

### 验证

- CLI 能完成一次端到端 agent run。
- `--json` 每行输出合法 JSON。
- 非 TTY 环境不会使用交互确认。
- Ctrl+C 能取消当前 run 并保存已产生消息。

## 阶段 12：Compaction 和长期上下文

### 要做

- 统计历史消息 token 或近似长度。
- 超出阈值时生成摘要。
- 保留最近 N 轮原文。
- 保留工具调用关键结果，截断过长输出。

### 验证

- 长 session 不会无限增长到模型上下文溢出。
- compaction 后仍能继续对话。
- 最近几轮用户意图不应被摘要覆盖。
- 工具输出过长时有明确截断说明。

## 完成定义

第一版完成的最低标准：

- 可以通过 CLI 发起一次真实 provider 的 agent run。
- 支持 OpenAI-compatible provider。
- 支持 read、grep、glob、shell、write、edit、patch。
- 有 permission 和 path guard。
- 有 JSONL 或内存 session store。
- 有脚本化 LLM fixture 覆盖 agent runner 测试。
- 文档说明如何配置 provider、如何运行、如何使用临时脚本完成一次性任务。

第二版完成的最低标准：

- MCP 可用。
- Skills 可用。
- SkillHub 搜索和按需安装可用。
- Git worktree sandbox 可用。
- 支持 session resume。
- 支持 compaction。
- 有端到端测试覆盖工具调用闭环。

第三版完成的最低标准：

- 临时脚本工作流稳定，能处理常见实时信息任务。
- 常用能力可以沉淀为 skills、MCP servers 或插件。
- 外部信息回答默认带来源、时间和链接。
- 有简单任务面板或 TUI，能展示步骤、工具调用、文件产物和失败原因。

## 暂不做

- 在内核中硬编码天气、新闻、论文、网页搜索等垂直工具。
- Desktop app。
- Web app。
- OpenAPI/SDK 生成。
- 多用户同步。
- 远程分享 session。
- 企业账号体系。
- 复杂 telemetry。
- 自动全量安装或全量加载远程 skills。

这些能力可以以后加，但不进入 minicode 的内核第一阶段。
