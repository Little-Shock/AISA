# Getting Started

这份文档给第一次进入 AISA 仓库的人用。目标只有 3 个:

1. 知道这个项目是什么。
2. 在本地把控制面跑起来。
3. 知道下一步该看哪份文档、跑哪类验证。

## AISA 是什么

AISA 是一套给长周期 AI 开发任务使用的 control plane。

它不把 AI 当作一次性聊天窗口，而是把持续推进拆成一条可追踪的 `run`，并把每一轮推进收成一个 `attempt`。系统关心的不是“模型刚说了什么”，而是:

- 当前到底卡在哪。
- 有没有足够证据证明这轮尝试真的完成了。
- 失败时该自动恢复、重新派发，还是让人类接球。
- 下一轮 AI 或人类接手时，最小真相包是否已经齐了。

## 仓库里的核心模块

| Path | Role |
| --- | --- |
| `apps/control-api` | 对外暴露 run / attempt / control surface |
| `apps/dashboard-ui` | operator dashboard，给人看状态、看证据、做 steer |
| `packages/orchestrator` | 推进 `run -> attempt -> verify -> next step` 主循环 |
| `packages/state-store` | 落盘运行事实、工件和派生视图 |
| `packages/judge` | reviewer / synthesizer / evaluation 管线 |
| `packages/worker-adapters` | 执行适配层，当前以 Codex CLI 为主 |
| `scripts` | verify、bootstrap、fixture、运维辅助脚本 |

## 环境准备

建议本地至少准备:

- Node.js 20+
- `pnpm`
- 可用的 OpenAI 兼容模型配置
- 可运行的 worker adapter 环境

常见环境变量见根 [`README.md`](../README.md)。第一次只要把 dashboard、control-api 和 worker adapter 跑通即可，不必一开始配完所有外部能力。

## 5 分钟跑起来

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动本地控制面

```bash
pnpm dev
```

默认本地地址:

- Dashboard: `http://127.0.0.1:3000`
- Control API: `http://127.0.0.1:8787`

### 3. 单独启动某一侧

```bash
pnpm --filter @autoresearch/control-api dev
pnpm --filter @autoresearch/dashboard-ui dev
```

### 4. 跑最常用验证

```bash
pnpm typecheck
pnpm verify:run-api
pnpm verify:runtime
pnpm verify:run-loop
```

如果你要验证 judge/evals 或自举链路，再继续看 [`verify-cookbook.md`](./verify-cookbook.md)。

## 第一次应该怎么理解界面

建议把 dashboard 当作 “AI 项目值班台” 来看:

- 首页先看哪条 run 在等人。
- 详情页先看 `run brief`、`preflight`、`handoff summary`。
- 再判断是继续 dispatch、人工 steer、还是因为 gate 失败暂停。

如果你更关心 operator 视角，先看 [`operator-guide.md`](./operator-guide.md)。

## 外部项目最短路径

如果目标不是让 AISA 开发自己，而是先接一个陌生仓库，最短路径直接走 project-first。

### 1. 先 attach 项目

```bash
curl -X POST http://127.0.0.1:8787/projects/attach \
  -H 'content-type: application/json' \
  -d '{
    "workspace_root": "/abs/path/to/your-repo",
    "owner_id": "you"
  }'
```

这一步会先生成 project profile、baseline snapshot、capability snapshot，还有默认 stack pack 和 task preset 推荐。

### 2. 从 attached project 直接建第一条 run

```bash
curl -X POST http://127.0.0.1:8787/projects/<project_id>/runs \
  -H 'content-type: application/json' \
  -d '{
    "owner_id": "you"
  }'
```

如果你已经知道要走哪条任务预设，也可以在这里显式传 `stack_pack_id` 和 `task_preset_id`。

### 3. 发车

```bash
curl -X POST http://127.0.0.1:8787/runs/<run_id>/launch
```

### 4. 在 dashboard 上按这个顺序看

- 先看 `先看项目上下文`
- 再看 `先看发车前结果`
- 再看 `先看交接说明`
- 中断后先看 `恢复路径` 和 `项目能力与恢复`

如果这条 run 来自外部项目，run detail 现在会先把项目画像、默认 pack、能力状态和恢复路径抬到首屏，不需要先翻 artifacts 才知道该不该继续。

## 推荐阅读顺序

1. 根 [`README.md`](../README.md)
2. [`operator-guide.md`](./operator-guide.md)
3. [`verify-cookbook.md`](./verify-cookbook.md)
4. [`run-lifecycle.md`](./run-lifecycle.md)
5. [`architecture.md`](./architecture.md)
6. [`glossary.md`](./glossary.md)

## 常见误区

- 这不是一个“聊天 UI”项目。
- dashboard 不是用来展示模型花哨输出，而是用来快速判断 run 当前状态和下一步动作。
- `attempt` 不等于“模型说了一段话”，而是一轮带 contract、验证和 review 证据的正式尝试。
- handoff bundle 和 working context 不是一回事。前者负责交接，后者负责保留现场。

这两个概念的区别见 [`run-lifecycle.md`](./run-lifecycle.md) 和 [`glossary.md`](./glossary.md)。
