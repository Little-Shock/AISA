# Architecture

这份文档不追求把所有源码文件逐个解释，而是给出 AISA 当前的主结构和模块边界。

最短版理解:

- `control-api` 暴露正式 surface。
- `dashboard-ui` 把运行事实变成 operator 能读的界面。
- `orchestrator` 推进主循环。
- `state-store` 保存事实和工件。
- `judge` / reviewer pipeline 负责评价和收口。
- `worker-adapters` 负责把执行落到具体 runtime。

## 四层结构

```text
operator surface
  -> control plane
  -> orchestration + evaluation
  -> truth artifacts + adapters
```

### 1. Operator Surface

面向人类的入口，核心是:

- `apps/dashboard-ui`

职责:

- 把 run 列表、triage 信号、detail panel、handoff 和 verification 证据展示给 operator
- 支持 steer / approve / resume 等控制动作
- 优先暴露“下一步该做什么”，而不是把所有原始 JSON 直接摊给人

### 2. Control Plane

对外稳定 surface，核心是:

- `apps/control-api`

职责:

- 创建 / 启动 / 读取 / steer `run`
- 暴露 run detail、attempt 信息、preflight summary、handoff summary 等正式接口
- 作为 dashboard、脚本和外部 automation 的统一入口

### 3. Orchestration + Evaluation

决定“系统怎么推进下一步”，核心包括:

- `packages/orchestrator`
- `packages/judge`
- planner / reviewer / synthesizer 相关能力

职责:

- 根据 `CurrentDecision` 推进下一轮 attempt
- 组织 preflight、dispatch、runtime verify、review、handoff
- 在需要时把多 reviewer 结论压成统一 synthesis

### 4. Truth Artifacts + Adapters

保存真实状态，并把执行接到外部 runtime，核心包括:

- `packages/state-store`
- `packages/domain`
- `packages/worker-adapters`
- `runs/<run_id>/...` 落盘工件

职责:

- 以稳定 schema 保存 run / attempt / artifact
- 保持 handoff、working context、review packet 等产物可回放
- 把执行适配到实际 agent/runtime，而不是把实现细节耦合进 dashboard

## 关键模块说明

| Module | Responsibility |
| --- | --- |
| `packages/domain` | 领域模型、schema、状态枚举、failure class |
| `packages/state-store` | run / attempt / artifact 读写与派生读取 |
| `packages/orchestrator` | 主循环、决策推进、恢复、handoff 编排 |
| `packages/judge` | reviewer / synthesizer / evaluation 逻辑 |
| `packages/worker-adapters` | 不同执行后端的统一接入层 |
| `scripts` | verify、bootstrap、fixture、排障入口 |

## 数据怎么流动

一个简化的数据流如下:

```text
operator/dashboard
  -> control-api
  -> orchestrator
  -> worker adapter / judge / state-store
  -> artifacts on disk
  -> control-api read model
  -> dashboard
```

这里最重要的一条原则是:

- source of truth 在正式 schema 和 artifacts，不在前端临时拼装状态。

dashboard 应该消费被整理过的正式 surface，而不是自己重新猜业务状态。

## 当前仍在推进的收敛点

当前 phase 主要继续往这几个方向收:

- preflight evaluation / handoff summary surface
- handoff-first auto-resume 与 degraded path
- working-context preservation 与 active snapshot surfacing
- shadow dispatch 与 verifier readiness fail-closed
- operator brief、failure class 和 adversarial verifier gate

这些方向的共同目标只有一个: 让 operator 打开系统时，看到的是“可决策的真相”，而不是一堆难以判断的原始执行噪音。

## 你应该先看哪层

- 想快速理解产品入口: 先看根 [`README.md`](../README.md)
- 想理解运行主链: 看 [`run-lifecycle.md`](./run-lifecycle.md)
- 想理解术语: 看 [`glossary.md`](./glossary.md)
- 想知道怎么验证: 看 [`verify-cookbook.md`](./verify-cookbook.md)
