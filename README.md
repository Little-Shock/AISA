# AutoResearch Swarm Dashboard

这是 `AutoResearch Swarm Dashboard` 的可运行 MVP。

当前实现遵循 PRD 的主线：

- `dashboard`
- `orchestrator`
- `shared context`
- `steer`
- `eval / judge`

当前版本的关键约束：

- 底层 worker 统一使用 `Codex CLI`
- worker 默认以 `read-only` 模式分析目标工作区
- 运行时状态优先落地到文件系统，而不是数据库和消息队列
- `control-api` 在同一进程内托管 `orchestrator`，用于跑通 MVP 闭环
- dashboard 默认通过同源 `/api/control/*` 代理访问本机 `control-api`，方便后续只暴露一个安全入口

## 当前能力

- 创建 goal
- 生成分支计划
- 启动 Codex branch worker
- 维护共享上下文板
- 记录事件和 worker artifacts
- 进行规则型评分和推荐
- 聚合 current report
- 在 dashboard 中查看 goal、branch、context、report、events
- 在 dashboard 中查看 run、attempt 契约、回放验证和日志尾部
- 队列 steer，并支持 branch rerun

## 目录

- `apps/dashboard-ui`
- `apps/control-api`
- `packages/domain`
- `packages/state-store`
- `packages/event-log`
- `packages/planner`
- `packages/worker-adapters`
- `packages/context-manager`
- `packages/judge`
- `packages/report-builder`
- `packages/orchestrator`

运行期产物目录：

- `state/`
- `events/`
- `artifacts/`
- `reports/`
- `plans/`

## 配置

复制 [.env.example](E:/00.Lark_Projects/36_team_research/.env.example) 为 `.env` 后再启动。

统一 worker / API 配置从同一个 `.env` 读取，重点变量：

- `CONTROL_API_HOST`
- `CONTROL_API_PORT`
- `NEXT_PUBLIC_CONTROL_API_URL`
- `CODEX_CLI_COMMAND`
- `CODEX_MODEL`
- `CODEX_PROFILE`
- `CODEX_SANDBOX`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

说明：

- `control-api` 会把这些配置透传给底层 `codex exec`
- 所有 branch worker 共用同一套 API provider 配置

## 启动

```bash
pnpm install
pnpm dev
```

默认启动后：

- Dashboard: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- Control API: [http://127.0.0.1:8787](http://127.0.0.1:8787)

说明：

- 浏览器默认只访问 dashboard 自己的 `/api/control/*` 路径。
- dashboard 服务端再把请求转发到本机 `control-api`。
- 这样后续做 Cloudflare Tunnel 时，只需要暴露 dashboard，一个入口就能在手机或其他机器上看运行状态。

如果只想启动后端：

```bash
pnpm --filter @autoresearch/control-api dev
```

如果只想启动前端：

```bash
pnpm --filter @autoresearch/dashboard-ui dev
```

## 使用

1. 打开 dashboard。
2. 填写 goal 标题、描述、success criteria、constraints、workspace root。
3. 点击 `Create Goal`。
4. 在 goal 详情中点击 `Launch`。
5. 等待 Codex branches 依次执行。
6. 在 `Live Report`、`Shared Context`、`Event Timeline` 中查看收敛过程。
7. 需要人工干预时，填写 steer 并点击 `Queue Steer`。
8. 若需要下一轮验证，可对某个 branch 点击 `Rerun Branch`。

## 验证

基础校验：

```bash
pnpm typecheck
pnpm smoke
```

说明：

- `pnpm smoke` 会生成一个 sample goal、plan、state 和 event 文件
- 真实 branch 执行由 `control-api` 内的 orchestrator 驱动

## 当前限制

- worker 现在默认是只读分析型，不做多 branch 并发代码改写
- dashboard 目前通过轮询读取 goal 详情，还没有 SSE
- `judge` 目前是规则评分，不是多 jury / LLM judge
- `trigger engine`、复杂 stop / merge、长期记忆、企业权限尚未实现
