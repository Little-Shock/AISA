# AISA

`AISA` 是一个 run-centered 的 agent orchestration control plane。

它不是新的底层模型，也不是新的单体 coding agent。当前实现的目标，是围绕一个 `run` 持续推进 `research -> execution -> evaluation -> next attempt` 这条闭环，让系统能自举式地继续开发自己。

当前仓库里同时存在两条线：

- 旧的 `goal / branch / judge / report` MVP 骨架
- 新的 `run / attempt / current decision / review packet` 主链

现在真正优先发展的，是新的 run-centered 主链。

## 当前状态

当前这版已经具备下面这些能力：

- `control-api` 提供 `run` 的创建、启动、steer、详情读取
- `dashboard` 可以观察 run、attempt、review packet、runtime 状态和错误
- `orchestrator` 会围绕 `CurrentDecision` 持续推进下一次 attempt
- `Codex CLI` 作为当前 worker adapter
- execution attempt 会在独立 managed worktree 中运行，而不是直接污染源工作区
- execution 会留下 replayable verification contract、runtime verification、review packet 和工件清单
- runtime 改到 live 源码时，会显式要求重启，避免旧内存继续派发
- `bootstrap:self` 可以创建 self-bootstrap run，并把 runtime health snapshot 带进自举入口

这意味着它已经不只是一个展示状态的原型，而是一套能自己跑 runtime 回归、自己继续开发自己的最小工作台。

## 核心对象

新的主链围绕这几个对象组织：

- `Run`
- `Attempt`
- `CurrentDecision`
- `AttemptEvaluation`
- `AttemptReviewPacket`
- `RunSteer`
- `RunJournalEntry`

运行时真相主要落在：

- `runs/<run_id>/contract.json`
- `runs/<run_id>/current.json`
- `runs/<run_id>/journal.ndjson`
- `runs/<run_id>/report.md`
- `runs/<run_id>/artifacts/runtime-health-snapshot.json`
- `runs/<run_id>/attempts/<attempt_id>/`

## 仓库结构

- `apps/control-api`
- `apps/dashboard-ui`
- `packages/domain`
- `packages/orchestrator`
- `packages/worker-adapters`
- `packages/judge`
- `packages/state-store`
- `packages/planner`
- `packages/context-manager`
- `packages/event-log`
- `packages/report-builder`
- `scripts`
- `runs`
- `state`
- `events`
- `artifacts`
- `reports`
- `plans`

## 本地启动

先安装依赖：

```bash
pnpm install
```

启动整套本地控制面：

```bash
pnpm dev
```

默认地址：

- dashboard: `http://127.0.0.1:3000`
- control-api: `http://127.0.0.1:8787`

如果只想跑后端：

```bash
pnpm --filter @autoresearch/control-api dev
```

如果只想跑前端：

```bash
pnpm --filter @autoresearch/dashboard-ui dev
```

## 配置

运行时主要从 `.env` 读取统一配置。常用变量：

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

- `control-api` 会把 worker 相关配置透传给底层 `codex exec`
- dashboard 默认通过同源 `/api/control/*` 代理访问本机 `control-api`
- 如果没有额外 provider 覆盖，当前环境会直接使用本机已有的 CLI / API 配置

## 常用验证

类型检查：

```bash
pnpm typecheck
```

runtime 主回归：

```bash
pnpm verify:runtime
```

run loop 回归：

```bash
pnpm verify:run-loop
```

self-bootstrap 回归：

```bash
pnpm verify:self-bootstrap
```

本地自举入口：

```bash
pnpm bootstrap:self
```

不经过 control-api，直接在本地推进某个 run：

```bash
pnpm drive:run -- --run-id <run_id>
```

## 协作开发

当前远端约定：

- `origin`: 个人 fork
- `upstream`: 共享仓库 `https://github.com/Little-Shock/AISA.git`

如果要把当前 `main` 推到共享仓库：

```bash
git push upstream HEAD:main
```

如果是新同事直接拿共享仓库开始：

```bash
git clone https://github.com/Little-Shock/AISA.git
cd AISA
pnpm install
```

## 同机 worktree 协作

如果你和朋友在同一台机器上并行开发，不要共用一个工作区。直接从已有 clone 拉一个新的 worktree：

```bash
git fetch upstream main
git worktree add ../AISA-friend -b friend/<name> refs/remotes/upstream/main
cd ../AISA-friend
pnpm install
```

建议约定：

- 每个人各自占用一个 worktree，不要在同一个工作目录里混改
- 每个 run 只绑定自己的工作区
- execution 产生的 managed worktree 会继续落在 `~/.aisa-run-worktrees/`
- 同机同时跑两套服务时，给每个 worktree 单独配置端口

例如第二个 worktree 可以这样启动：

```bash
export CONTROL_API_PORT=8788
export NEXT_PUBLIC_CONTROL_API_URL=http://127.0.0.1:8788
export PORT=3001
pnpm dev
```

这样就不会和主 worktree 的 `3000 / 8787` 冲突。

## 当前限制

- evaluator 现在还是单一 `AttemptEvaluation`，还没升级成多 reviewer / synthesizer pipeline
- 旧的 `goal / branch` 逻辑还在 orchestrator 里保留兼容，没有彻底剥离
- dashboard 已经能看 run detail，但体验上还没有完全围绕 run page 收口
- provider 可用性仍然会直接影响自举 run 的连续性
- 更复杂的 trigger、长期记忆、多实例治理和自动 merge 还没进入当前主线

## 现在最重要的开发方向

当前主线不是继续堆外围平台能力，而是把 run-centered runtime 打磨硬：

- replayable verification contract
- execution 隔离现场
- review packet 完整落盘
- runtime source drift 护栏
- self-bootstrap 主链
- 更可靠的 evaluator / reviewer pipeline

只要这条链足够硬，AISA 才能真的成为一个能长期自推进的工作台。
