# AutoResearch Swarm Dashboard Implementation Blueprint

> 说明
>
> 这份文档保留为 pre-harness 阶段的历史蓝图，主要用于代码考古和理解旧目录语言。
>
> 当前架构主线请以 `docs/aisa-harness-prd-v1.md`、`docs/aisa-harness-roadmap-v1.md` 和 `docs/decisions/` 为准。

本文档把当前 PRD 收敛成一个可直接开工的工程实现蓝图，面向 `Milestone 0` 和 `Milestone 1 / MVP`。

适用范围：

- 对应 PRD 的 `MVP` 边界
- 只覆盖单工作区、单团队内可运行版本
- 默认坚持“文件系统优先、可观察优先、可复盘优先”

## 1. 结论先行

推荐按下面的方式实现第一版：

1. 使用 `TypeScript` monorepo。
2. 前端使用 `Next.js` 做 `dashboard-ui`。
3. 后端使用单独的 `Node.js + Fastify` 进程承载 `control-api`，并在同一进程内运行 `orchestrator` 后台循环。
4. 运行期状态先落地到 `JSON + Markdown + NDJSON + 本地文件系统`，不要一开始引入 `Postgres`、消息队列或复杂调度基础设施。
5. 先实现一个可运行闭环：
   `goal -> planner -> branch spawn -> adapter dispatch -> writeback -> judge -> report update -> dashboard observe -> steer queue`

这条路线最符合 PRD 的核心定位：它先做 `orchestration control plane`，而不是先做聊天界面、底层 worker runtime 或复杂平台基建。

## 2. MVP 只做什么

第一版只做 PRD `23.1/23.2` 中最小正确闭环：

- 创建一个 `goal`
- 生成 `2-5` 个分支
- 通过 adapter 派发到外部 worker
- 收集日志、产物和回写
- 维护共享上下文板
- 支持人工 `steer`
- 对分支结果做 `judge`
- 在 dashboard 中展示分支状态、共享结论、报告和预算

明确不做：

- 企业权限体系
- 自动 issue 池
- 长期记忆图谱
- 复杂 merge automation
- 真正的多租户隔离
- 高复杂度 trigger engine

## 3. 推荐技术选型

### 3.1 为什么选 TypeScript

理由很直接：

- `dashboard-ui`、`control-api`、`orchestrator` 可以共享对象模型和协议类型。
- Adapter、事件、状态文件 schema 更适合用 `zod` 统一校验。
- 对接 CLI worker、SSE、文件系统监听都足够成熟。

### 3.2 具体建议

- Runtime: `Node.js 22+`
- Package manager: `pnpm`
- Frontend: `Next.js`
- API server: `Fastify`
- Validation: `zod`
- Tests: `vitest`
- E2E smoke: `playwright` 或最小 CLI 验证脚本
- Realtime: `SSE`

说明：

- `Dashboard` 与 `Control API` 在逻辑上分离。
- `Milestone 0` 可以先部署为两个应用、一个仓库；不需要拆成多服务集群。
- `Milestone 0` 不建议引入 `Redis`、`Kafka`、`Temporal`、`BullMQ`。

## 4. 推荐仓库结构

```text
.
├── apps/
│   ├── dashboard-ui/
│   └── control-api/
├── packages/
│   ├── domain/
│   ├── planner/
│   ├── orchestrator/
│   ├── worker-adapters/
│   ├── context-manager/
│   ├── judge/
│   ├── state-store/
│   ├── event-log/
│   └── report-builder/
├── docs/
├── plans/
├── state/
├── events/
├── artifacts/
├── reports/
└── tests/
```

各目录职责：

- `apps/dashboard-ui`: 控制面 UI，只做展示、用户操作和页面状态。
- `apps/control-api`: HTTP API、SSE 推流、命令入口、查询入口。
- `packages/domain`: 核心对象模型、schema、状态枚举、事件类型。
- `packages/planner`: `goal -> plan.md / branch_specs.json / eval_spec.json`。
- `packages/orchestrator`: 生命周期管理、调度、重试、预算控制。
- `packages/worker-adapters`: 外部 worker 适配层。
- `packages/context-manager`: 共享板、分支上下文、快照构建、steer 应用。
- `packages/judge`: 分支评估和推荐动作。
- `packages/state-store`: JSON 文件读写、索引、乐观并发控制。
- `packages/event-log`: NDJSON 事件追加和查询。
- `packages/report-builder`: 维护 `current best report`。
- `plans`: 计划产物，来源于 planner。
- `state`: 结构化状态快照。
- `events`: 系统事件事实流。
- `artifacts`: worker 原始产物、日志、附件。
- `reports`: 对人可读的阶段性报告。

## 5. 运行期产物布局

建议使用下面的文件布局，而不是把所有内容混在一个目录里：

```text
plans/
└── goals/
    └── goal_001/
        ├── plan.md
        ├── branch_specs.json
        └── eval_spec.json

state/
└── goals/
    └── goal_001/
        ├── goal.json
        ├── branches/
        │   ├── branch_001.json
        │   └── branch_002.json
        ├── worker-runs/
        │   └── run_001.json
        └── steers/
            └── steer_001.json

events/
└── goals/
    └── goal_001.ndjson

artifacts/
└── goals/
    └── goal_001/
        ├── context/
        │   ├── shared_facts.md
        │   ├── open_questions.md
        │   ├── constraints.md
        │   ├── context_snapshot.json
        │   └── branch_notes/
        │       └── branch_001.md
        └── branches/
            └── branch_001/
                ├── task-spec.json
                ├── stdout.log
                ├── stderr.log
                ├── writeback.json
                └── output/

reports/
└── goals/
    └── goal_001/
        ├── current.md
        └── history/
            └── 2026-03-20T23-00-00.md
```

这个布局满足 PRD 中对以下能力的要求：

- `State Store`
- `Event Log`
- `Artifact Store`
- `Shared Context Board`
- `Report Streaming`
- `任务历史与复盘`

## 6. 核心对象与最小 schema

第一版先把对象模型固定下来，再写执行逻辑。

### 6.1 Goal

```json
{
  "id": "goal_001",
  "title": "Compare implementation paths for the dashboard MVP",
  "description": "Define a practical implementation plan and produce a running prototype",
  "success_criteria": [
    "Can spawn multiple branches",
    "Can observe branch status in dashboard",
    "Can accept steer and update next round"
  ],
  "constraints": [
    "File-first runtime",
    "No heavy infra in M0"
  ],
  "owner_id": "user_001",
  "status": "running",
  "budget": {
    "tokens": 2000000,
    "time_minutes": 180,
    "max_concurrency": 3
  }
}
```

### 6.2 Branch

```json
{
  "id": "branch_001",
  "goal_id": "goal_001",
  "parent_branch_id": null,
  "hypothesis": "A separate control API process keeps orchestration logic cleaner",
  "assigned_worker": "codex",
  "status": "queued",
  "score": null,
  "context_snapshot_id": "ctx_20260320_01"
}
```

### 6.3 Worker task spec

```json
{
  "goal_id": "goal_001",
  "branch_id": "branch_001",
  "task_type": "research",
  "objective": "Compare three implementation options for the MVP",
  "success_criteria": [
    "Provide tradeoff analysis",
    "Reference evidence"
  ],
  "constraints": [
    "Do not modify unrelated files",
    "Stay within budget"
  ],
  "context_snapshot_ref": "ctx_20260320_01",
  "writeback_targets": [
    "shared_facts",
    "branch_notes",
    "artifacts"
  ]
}
```

### 6.4 Worker writeback

`findings[].type` 只允许 `fact`、`hypothesis`、`risk`。

`artifacts` 必须是对象数组，不能直接写成字符串路径。最小对象形状是 `{ "type": "patch", "path": "..." }`，`type` 使用 `patch`、`command_result`、`test_result`、`report`、`log`、`screenshot` 之一。

```json
{
  "branch_id": "branch_001",
  "findings": [
    {
      "type": "fact",
      "content": "SSE is enough for live event streaming in M0",
      "evidence": [
        "local-test-run"
      ]
    }
  ],
  "questions": [
    "Should branch merge happen automatically in M1?"
  ],
  "artifacts": [
    {
      "type": "report",
      "path": "artifacts/goals/goal_001/branches/branch_001/output/report.md"
    }
  ],
  "recommended_next_steps": [
    "Keep the branch and compare against a second implementation path"
  ]
}
```

### 6.5 Event schema

```json
{
  "event_id": "evt_001",
  "ts": "2026-03-20T23:20:00+08:00",
  "goal_id": "goal_001",
  "branch_id": "branch_001",
  "run_id": "run_001",
  "type": "worker.finished",
  "payload": {
    "adapter": "codex",
    "exit_code": 0,
    "artifact_count": 3
  }
}
```

事件类型最少覆盖：

- `goal.created`
- `plan.generated`
- `branch.spawned`
- `branch.queued`
- `worker.started`
- `worker.stdout.appended`
- `worker.writeback.received`
- `context.updated`
- `judge.completed`
- `report.updated`
- `steer.queued`
- `steer.applied`
- `branch.discarded`
- `goal.completed`

## 7. 模块边界和实现建议

### 7.1 Dashboard UI

只做控制面，不放调度逻辑。

页面优先级：

1. Goal 列表
2. Goal 详情
3. Branch 树
4. Shared Board
5. Live Report
6. Events 时间线
7. Steer 面板
8. Budget 面板

第一版关键点：

- Goal 详情页必须可同时看到 branch 状态、最新共享结论、当前报告。
- 实时更新优先通过 `SSE`。
- Branch tree 一开始不必做复杂图编辑器，普通树视图即可。

### 7.2 Control API

建议接口：

- `POST /goals`
- `GET /goals`
- `GET /goals/:goalId`
- `POST /goals/:goalId/plan`
- `POST /goals/:goalId/steers`
- `POST /goals/:goalId/branches/:branchId/stop`
- `GET /goals/:goalId/events`
- `GET /goals/:goalId/report`
- `GET /goals/:goalId/context`
- `GET /stream/goals/:goalId`

关键原则：

- API 只接收命令和返回读模型。
- 长任务不在 HTTP 请求周期内执行完成。
- 创建命令成功后立即返回，由 orchestrator 异步推进状态。

### 7.3 Orchestrator

第一版实现成单进程内后台循环即可，职责包括：

- 拉取可执行 branch
- 根据预算和并发限制调度
- 调用 adapter 启动 worker
- 监听完成和失败
- 驱动 `writeback -> judge -> report update`
- 在任务边界应用 steer

不建议第一版就做：

- 分布式锁
- 多实例 orchestrator leader election
- 复杂持久化队列

### 7.4 Planner

第一版 planner 不需要很“聪明”，但输出必须稳定。

最低要求：

- 根据 goal 生成 `plan.md`
- 生成 `2-5` 个 branch specs
- 为每个 branch 指定 hypothesis、worker 类型、成功标准
- 生成 `eval_spec.json`

输出必须可落地成文件，不要只保存在内存里。

### 7.5 Worker Adapters

第一版建议实现三个 adapter：

1. `mock`
2. `codex`
3. `pi`

其中：

- `mock` 用于本地集成测试和演示，保证系统在没有外部 agent 时也能跑通。
- `codex` 是最先接入的真实 adapter。
- `pi` 若本地环境尚未稳定，可放到 `Milestone 1` 补齐，但接口层要预留。

统一 adapter 接口：

```ts
interface WorkerAdapter {
  type: string
  startTask(taskSpecPath: string): Promise<{ runId: string }>
  pollStatus(runId: string): Promise<{ state: string }>
  injectContext(runId: string, steerPath: string): Promise<void>
  stopTask(runId: string): Promise<void>
  collectArtifacts(runId: string): Promise<string[]>
  normalizeOutput(runId: string): Promise<string>
}
```

### 7.6 Context Manager

这是 MVP 的核心，不应该被弱化成“拼 prompt”。

至少实现这些动作：

- 从 `goal + branch + global rules + latest steer` 生成 `context_snapshot.json`
- 把 worker writeback 合并到 `shared_facts.md`、`open_questions.md`、`branch_notes/<branch_id>.md`
- 标注哪些内容是 `fact`，哪些是 `hypothesis`，哪些是 `unverified`
- 控制上下文裁剪，避免无限膨胀

### 7.7 Judge

第一版 judge 不要复杂化，建议两层：

1. 规则打分
2. 可选的 LLM judge

规则打分先覆盖：

- Relevance
- Evidence Quality
- Actionability
- Cost Efficiency

输出：

- `score`
- `dimension_scores`
- `confidence`
- `recommendation`
- `rationale`

### 7.8 Report Builder

每次 `branch` 执行结束或 `judge` 完成后，更新一次 `reports/goals/<goal_id>/current.md`。

报告结构固定为：

1. Executive Summary
2. Current Best Answer
3. Evidence Table
4. Competing Branches
5. Open Questions
6. Recommended Next Steps

## 8. 实现顺序

## 8.1 Milestone 0: 跑通闭环

目标：

- 单 goal
- 2 个并行 branch
- `mock + codex` 两种 worker
- 文件系统上下文板
- 简易 dashboard

执行顺序：

1. 初始化 monorepo 和基础工程配置
2. 实现 `packages/domain`
3. 实现 `packages/state-store` 和 `packages/event-log`
4. 实现 `packages/planner`
5. 实现 `packages/worker-adapters/mock`
6. 实现 `packages/orchestrator`
7. 实现 `packages/context-manager`
8. 实现 `packages/judge`
9. 实现 `packages/report-builder`
10. 实现 `apps/control-api`
11. 实现 `apps/dashboard-ui`
12. 再接入 `codex` adapter

每一步都应具备最小验证：

- domain: schema fixture 测试
- state/event: 文件写入和重放测试
- planner: 输入 goal 输出三个工件
- orchestrator: 可以把 branch 从 `queued` 推到 `judging`
- adapter: 可以产出 writeback.json
- API: 可以创建 goal 并返回状态
- dashboard: 能看到 branch 变化和报告更新

## 8.2 Milestone 1: 对齐 PRD MVP

在 `Milestone 0` 之上追加：

- `pi` adapter
- steer queue
- budget panel
- 更完整的 branch tree
- 更完整的 judge recommendation
- report streaming

这时再补：

- `WaitingSteer` 等状态展示
- 低分支淘汰策略
- 失败恢复与手动 rerun

## 9. 第一批代码应该长什么样

如果现在开始写代码，第一批提交建议只做下面这些：

1. `pnpm workspace` 初始化
2. `apps/dashboard-ui` 和 `apps/control-api` 空应用
3. `packages/domain` 中定义 `Goal / Branch / WorkerRun / Steer / Event`
4. `packages/state-store` 中定义文件路径约定和 repository API
5. `packages/event-log` 中定义 NDJSON append/query API
6. 一个 `tests/fixtures` 目录，放最小 goal、branch、writeback 样例
7. 一个 CLI smoke 脚本，演示从创建 goal 到生成 plan 文件

不要第一批就做的事情：

- 复杂 UI 细节
- 真正的多用户体系
- 多 provider 配置中心
- 自动触发系统
- 数据库存储迁移

## 10. 风险与控制

最需要提前防住的不是“功能不够多”，而是下面四个问题：

1. 把 dashboard 做成 chat UI，失去 control plane 的价值。
2. 把 orchestrator 逻辑散落到前端和 adapter 中，导致后续不可维护。
3. 不先定义事件和对象模型，后面状态恢复会很痛苦。
4. 不区分 `steer` 和 `stop`，会让用户误判系统行为。

对应控制手段：

- 任何关键动作先写事件。
- 任何状态推进都通过 orchestrator 完成。
- 任何 worker 接入都必须走统一 adapter 接口。
- 任何上下文写入都先分层、分事实与假设。

## 11. 推荐的下一步

最合理的下一步不是直接铺满所有模块，而是：

1. 先建立 monorepo 和 `domain/state/event` 三个基础包。
2. 然后跑通 `mock adapter + orchestrator + control-api`。
3. 再接 `dashboard-ui` 做真实观测。
4. 最后把 `codex/pi` 接到统一协议上。

如果后续要继续推进实现，建议下一次直接从 `Milestone 0` 的第一批代码开始，而不是继续扩展 PRD。
