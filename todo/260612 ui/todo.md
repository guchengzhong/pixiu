# 260612 Local UI TODO

## Goal

为 pixiu 增加一个实用性驱动的本地浏览器操作 UI，让用户可以通过浏览器完成 provider 配置、新建/继续对话、上传文件、批准工具权限、查看 agent 执行轨迹和打开生成产物。

这个 UI 的定位不是云服务、管理后台或营销页面，而是 `pixiu` CLI 的本地工作台：复用现有 runtime、agent loop、session、permission、sandbox、skills 和 MCP 能力，把终端里已经存在的能力变得更可见、更顺手。

## Product Principles

- Local-first: 默认只监听 `127.0.0.1`，不做远程多人协作和公网服务。
- CLI remains core: Web UI 是新的入口，不 fork 一套 agent loop。
- Practical first: 首版优先解决配置、对话、权限、文件、产物查看这些日常摩擦。
- Auditable: tool call、shell command、文件写入、web source、permission decision 都要可追踪。
- Explicit workspace semantics: UI 必须清楚展示当前项目根目录、session workspace、上传目录和 agent 实际执行目录。
- Safe by default: API key、shell/write/edit/web_fetch 等风险操作需要明确边界和确认。

## Technical Direction

默认技术方案先定为 TypeScript 端到端，后端复用 Bun runtime，前端使用 React + TypeScript 构建本地单页应用。原因是 pixiu 当前已经是 Bun-first TypeScript 项目，继续使用同一语言和类型系统可以最大化复用 `AgentEvent`、config、session、permission 等现有类型，减少跨语言 API 漂移。

- [x] Backend: Bun HTTP server + TypeScript
  - 复用 `buildRuntime`、`AgentRunner`、`JsonlSessionStore`、`StaticPermissionManager`、`PathGuard`。
  - CLI 只负责启动 server、打印 URL、处理参数和生命周期。
  - Server 层负责 HTTP routing、auth token、SSE、upload、pending permission registry。
  - 不在 UI server 中重新实现 agent loop。

- [x] Frontend: React + TypeScript
  - 用组件化方式实现 session sidebar、chat pane、trace pane、artifact pane、config view。
  - 前端只消费 server API，不直接读取本地文件系统。
  - API DTO 和 event 类型尽量从 shared UI contract 导入，避免手写重复类型。
  - 首版不引入重型状态管理库，优先使用 React state、context 和小型自定义 hooks。

- [x] Build tooling
  - 优先保持 Bun-first 工作流。
  - 如果使用 Vite，需要明确 `dev/build/test` 脚本，并保证 `bun run typecheck`、`bun test` 不被破坏。
  - 静态资源由本地 Bun server 提供，开发环境可代理到前端 dev server，生产/源码运行模式提供 build 后资源。

- [x] Streaming protocol: SSE first
  - Agent run 是单向事件流，SSE 比 WebSocket 更简单、更可测试。
  - `POST /api/runs` 创建 run，`GET /api/runs/:runId/events` 订阅事件。
  - 浏览器回填权限、取消 run、上传文件继续使用普通 HTTP API。
  - 只有后续需要双向实时协作时再考虑 WebSocket。

- [x] API contract
  - Server API 返回稳定 JSON DTO，不直接暴露内部 class 实例。
  - 错误响应统一形状: `{ ok: false, code, message, details? }`。
  - 成功响应统一形状: `{ ok: true, data }`，SSE event 除外。
  - 所有输入都要做 schema/shape 校验，不能假设前端一定传对。

- [x] Storage
  - Session 继续使用现有 JSONL store。
  - UI 自身的临时 run、pending permission 只保存在 server 进程内存。
  - 不为首版引入数据库。
  - 如果后续需要 UI preferences，可落到 `.pixiu/state/ui.json`。

## Engineering Standards

代码风格目标是大厂工程规范：模块边界清楚、类型严格、可测试、可观测、默认安全，而不是把 UI 快速堆成一坨。

- [x] Module boundaries
  - `src/ui/server/**`: HTTP server、routing、SSE、uploads、permission bridge。
  - `src/ui/shared/**`: 前后端共享 DTO、event mapping、redaction helpers。
  - `src/ui/client/**`: React UI、hooks、API client、components。
  - `src/cli/index.ts`: 只增加命令入口和参数解析，不承载 UI 业务逻辑。

- [x] Performance expectations
  - Run events 流式渲染，不等任务结束后一次性刷出。
  - 大文件上传和预览必须有大小限制。
  - 文件列表分页或限制数量，避免一次性扫描超大 workspace。
  - Trace 面板默认折叠大输出，只展示摘要和按需展开。
  - SSE client 断开时要清理 reader/listener，避免长任务泄漏。

- [x] Security expectations
  - 默认 loopback + local token。
  - 所有文件 API 必须走 `PathGuard`。
  - API key、Authorization header、常见 token 必须 redacted。
  - Upload 禁止路径穿越，不信任 filename。
  - `bypassPermissions` 在 UI 中必须有明显提示。

- [x] Reliability expectations
  - 每个 run 都要有明确生命周期: queued/running/waiting_permission/cancelled/error/done。
  - AbortSignal 要贯穿 LLM stream、tool execution 和 shell。
  - Server shutdown 时取消活跃 runs 并 close runtime/MCP clients。
  - Provider error、permission denied、max_steps、upload failure 都要能被 UI 清楚展示。

- [x] Test expectations
  - Server API 单元测试覆盖 status/config/sessions/runs/cancel/uploads。
  - SSE 测试覆盖 text event、tool event、error event、client disconnect。
  - Permission bridge 测试覆盖 pending ask、allow once、deny once、session similar allow。
  - Frontend 逻辑至少覆盖 API client、event reducer、permission state reducer。
  - 端到端 smoke 使用 fake provider，不在默认测试中调用真实 provider。

## Target Workflows

- 首次使用者打开本地 UI，填写 base URL、model、API key 或 API key env var，并确认 provider 可用。
- 用户新建一个对话，输入任务，让 agent 读写文件、执行命令或生成报告。
- 用户继续历史 session，看到之前的 workspace、消息、产物、来源和最近工具活动。
- 用户上传文件到当前 session，让 agent 分析或基于文件生成输出。
- agent 请求高风险工具时，用户在浏览器中批准一次、拒绝一次，或允许当前 session 内同类请求。
- 用户在任务结束后查看生成文件、web sources、shell commands 和 session evidence。

## MVP Scope

- [x] 增加 `pixiu ui` 或 `pixiu serve` 命令
  - [x] 启动本地 Bun HTTP server。
  - [x] 默认 host 为 `127.0.0.1`。
  - [x] 默认端口固定为 `2208`。
  - [x] 端口占用时给出清晰错误或自动选择下一个端口。
  - [x] 启动后打印浏览器 URL。
  - [x] 支持 `--host`、`--port`、`--no-open`。

- [x] 增加本地 UI server 安全边界
  - [x] 启动时生成一次性 local token。
  - [x] 页面请求需要携带 token，避免本机其他网页直接调用 pixiu API。
  - [x] 默认拒绝非 loopback host，除非用户显式传入 `--host 0.0.0.0`。
  - [x] API 响应中继续 redacted secrets。

- [x] Provider 配置页面
  - [x] 展示当前 base URL、model、credential 类型和 key/env var 状态。
  - [x] 支持选择 endpoint alias: `openai`、`siliconflow`、`deepseek`、自定义 URL。
  - [x] 支持写入 API key 或 env var 名称。
  - [x] 支持测试 provider 连通性。
  - [x] 保存后复用现有 config loader/writer 行为。
  - [x] 明确提示 `pixiu.jsonc` 可能在项目内，避免用户误提交明文 key。

- [x] Session 列表和新建对话
  - [x] 展示历史 session: title、updatedAt、model、workspace、finish status。
  - [x] 支持新建 session。
  - [x] 支持继续指定 session。
  - [x] 支持删除/隐藏 session 的设计先记录，不在首版实现物理删除。

- [x] Agent 对话运行视图
  - [x] 输入框支持普通消息和多行输入。
  - [x] 支持选择 permission mode: `default`、`acceptEdits`、`plan`、`bypassPermissions`。
  - [x] 通过 SSE 或 WebSocket 流式展示现有 `AgentEvent`。
  - [x] 展示 assistant final answer。
  - [x] 折叠展示 tool call、tool result、shell command、文件写入、web fetch/search。
  - [x] 展示 run 状态: running、cancelled、error、max_steps、done。
  - [x] 支持取消当前 run，并把 AbortSignal 传入 runner。

- [x] Permission Prompt UI
  - [x] 对 `ask` decision 创建 pending permission request。
  - [x] 浏览器弹出确认面板，显示 tool、cwd、risk、reason、input preview。
  - [x] 支持 allow once、deny once。
  - [x] 支持 allow similar for this session，映射到 chat session 内临时 permission rule。
  - [x] 记录 permission decision 到 tool metadata / session evidence。

- [x] 文件上传
  - [x] 支持上传到当前 session workspace 的 `uploads/` 目录。
  - [x] 上传后返回 workspace-relative path。
  - [x] UI 可以把上传文件路径插入 prompt。
  - [x] 限制单文件大小和总大小，错误信息要清晰。
  - [x] 避免上传路径穿越和覆盖敏感文件。

- [x] Artifacts / Evidence 面板
  - [x] 展示当前 session 的生成文件。
  - [x] 展示 web sources、search queries、fetched URLs、accessedAt。
  - [x] 展示最近 shell commands、exit code、duration、stdout/stderr byte count。
  - [x] 支持打开文本类产物预览: Markdown、txt、json、csv、log。
  - [x] 二进制文件首版只展示路径和大小。

- [x] Doctor / Status 面板
  - [x] 展示 provider key 是否可用。
  - [x] 展示 workspace mode、session store path、skills diagnostics、MCP status。
  - [x] 复用 runtime diagnostics，避免重新实现检查逻辑。

## Backend API Draft

- [x] `GET /api/status`
  - 返回版本、cwd、config summary、provider status、workspace status。

- [x] `GET /api/config`
  - 返回 redacted config 和 provider summary。

- [x] `POST /api/config/provider`
  - 保存 baseURL、model、apiKey 或 apiKeyEnv。

- [x] `POST /api/config/test-provider`
  - 发起最小 provider 测试，返回 ok/error。

- [x] `GET /api/sessions`
  - 返回 session 列表。

- [x] `POST /api/sessions`
  - 创建新 session 或预创建 session workspace。

- [x] `GET /api/sessions/:id`
  - 返回 session metadata、messages、evidence summary。

- [x] `POST /api/runs`
  - body: sessionId?、message、permissionMode。
  - 返回 runId。

- [x] `GET /api/runs/:runId/events`
  - SSE 推送 normalized run events。

- [x] `POST /api/runs/:runId/cancel`
  - 取消当前 run。

- [x] `POST /api/permissions/:requestId`
  - body: action=`allow|deny`，scope=`once|sessionSimilar`。

- [x] `POST /api/sessions/:id/uploads`
  - multipart upload，返回文件列表和 workspace-relative paths。

- [x] `GET /api/sessions/:id/files`
  - 返回当前 session workspace 中可展示文件列表。

- [x] `GET /api/sessions/:id/files/content?path=...`
  - 读取可预览文本文件，走 PathGuard。

## Frontend UI Draft

- [x] Layout
  - [x] 左侧: session 列表、新建按钮、配置入口、doctor/status。
  - [x] 中间: 对话消息和流式回答。
  - [x] 右侧: run trace、artifacts、evidence、workspace files。

- [x] Provider setup view
  - [x] 首次缺 key 时自动进入配置视图。
  - [x] 保存成功后回到新建对话。

- [x] Chat view
  - [x] 消息列表。
  - [x] 输入框。
  - [x] 文件上传按钮。
  - [x] permission mode selector。
  - [x] run/cancel button。

- [x] Trace view
  - [x] tool calls 默认折叠。
  - [x] shell/write/edit/web_fetch 使用不同图标或标签。
  - [x] failed tool result 醒目展示。

- [x] Artifact view
  - [x] 文本预览。
  - [x] 路径复制。
  - [x] `open in editor` / `open file` 记录为后续增强；首版只做安全的文本预览和路径复制。

## Architecture Notes

- Web server 应放在 `src/ui/server.ts` 或 `src/server/ui.ts`，CLI 命令只负责解析参数和启动。
- 前端静态资源可以先放在 `src/ui/client` 或 `web/`，构建产物由 Bun server 提供。
- 第一版优先少依赖。若使用 React/Vite，需要明确 build/test 命令和 Bun 兼容性。
- Agent 事件应尽量直接复用 `AgentEvent`，只在 UI 层做 presentation mapping。
- Permission ask 可以复用 `buildRuntime({ interactivePermissions: true, askPermission })`，后端把 ask Promise 挂起，等待浏览器回填。
- 不要让前端直接读写任意本地路径；所有文件访问都走 server API + PathGuard。

## Security And Secrets

- [x] 明确 API key 存储策略
  - 首版决策: API key 支持写入项目 `pixiu.jsonc` 以保证开箱即用，也支持只保存 env var 名称；UI 和文档明确提示推荐 env var 以避免误提交明文 key。
  - 选项 A: 继续写入 `pixiu.jsonc`，但 UI 强提示风险。
  - 选项 B: 写入 `.pixiu/secrets.json`，并确保 `.pixiu` 不被提交。
  - 选项 C: 只写 env var 名称，用户自行设置环境变量。
  - 待定: 首版采用哪一个默认方案。

- [x] Redaction
  - [x] config 输出 redacted。
  - [x] run trace 中 redacted provider key 和常见 token。
  - [x] doctor/status 不显示明文 secret。

- [x] Upload limits
  - [x] 单文件大小限制。
  - [x] 单 session 上传总量限制。
  - [x] 禁止 path traversal。

- [x] Network exposure
  - [x] 默认只允许 loopback。
  - [x] 非 loopback 需要显式 `--host 0.0.0.0`，其他非 loopback 默认拒绝。

## Open Product Questions

- [x] UI 中 agent 默认操作的是 session workspace，还是当前项目根目录？
  - 首版决策: UI 默认沿用 runtime 的 `sandbox.mode: "workspace"`，展示 session workspace；不在首版开放项目根浏览器。
  - 当前 runtime 默认 `sandbox.mode: "workspace"`，这对产物隔离友好。
  - Web UI 用户可能更自然期待 agent 能读写当前项目。
  - 需要决定是否提供显式模式: `Project mode` / `Workspace mode`。

- [x] API key 默认保存在哪里？
  - `pixiu.jsonc` 简单直接，但有误提交风险。
  - `.pixiu/secrets.json` 更安全一些，但要增加 secret loader。
  - 只存 env var 最安全，但首次使用体验差一点。

- [x] 首版是否支持项目文件浏览？
  - 首版决策: 不支持项目根浏览，只展示 session workspace、uploads、artifacts/evidence。
  - 如果支持，需要非常谨慎地限制范围和权限。
  - 如果不支持，先只展示 session workspace 和 generated artifacts。

- [x] 是否把 Skills/MCP 管理放入首版？
  - 首版决策: 只展示状态和 diagnostics；增删改 Skills/MCP 放到第二阶段。
  - 建议首版只展示状态。
  - 增删改 Skills/MCP 放到第二阶段。

- [x] 是否需要自动打开浏览器？
  - 默认可以自动打开，CI/远程环境通过 `--no-open` 关闭。

## Phase Plan

### Phase 1: Server Skeleton

- [x] 增加 `pixiu ui` 命令。
- [x] 启动本地 server。
- [x] 提供静态页面。
- [x] 实现 `/api/status`、`/api/config`、`/api/sessions`。
- [x] 补 CLI/server 单元测试。

### Phase 2: Provider Setup

- [x] 完成 provider 配置表单。
- [x] 完成 provider save/test API。
- [x] 完成缺 key 首次引导。
- [x] 确保 secrets redaction。

### Phase 3: Chat And Streaming Runs

- [x] 实现 session 新建/继续。
- [x] 实现 `POST /api/runs`。
- [x] 实现 SSE run events。
- [x] 实现取消 run。
- [x] 前端展示 final answer 和 trace。

### Phase 4: Permissions

- [x] 后端 pending permission registry。
- [x] 前端 permission prompt。
- [x] 支持 allow once / deny once / allow similar。
- [x] 测试 pending ask、allow、deny、cancel。

### Phase 5: Uploads And Artifacts

- [x] 实现上传 API。
- [x] 文件列表和文本预览。
- [x] Evidence/artifacts 面板。
- [x] 上传文件路径插入 prompt。

### Phase 6: Polish

- [x] 响应式布局。
- [x] 空状态和错误状态。
- [x] 长任务状态栏。
- [x] session summary 已展示；`/compact` 和 export 记录为后续增强，不进入首版。
- [x] 文档和 README 更新。

## Verification

- [x] `bun run typecheck`
- [x] `bun test`
- [x] `pixiu ui --port <test-port>` 能启动并返回 status。
- [x] 缺 provider key 时 UI 能引导配置。
- [x] fake provider 下能完成一次 text run。
- [x] fake provider 下能完成一次 tool write run。
- [x] permission ask 能在 UI 中批准和拒绝。
- [x] 上传文件不能逃逸 session workspace。
- [x] API 响应和 trace 不泄漏 provider key。
