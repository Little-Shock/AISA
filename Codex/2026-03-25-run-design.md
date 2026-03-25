# AISA Run 设计草案

日期 `2026-03-25`

## 目的

这份文档只解决一件事，先把 `run` 设计清楚。

当前仓库里的事实模型还是偏 `goal + branch + worker-run + report + context`。这会导致真相分散，很多派生视图被误当成一等概念。接下来要把系统重心收回到 `run`，所以要先明确 run 到底是什么，最小应该包含哪些东西，哪些东西不该再被单独抬成核心组件。

## 一句话定义

`run` 是一次任务的唯一事实源。

它保存这次任务的契约、推进历史、原始证据和当前判断。其它大部分我们今天看到的对象，都应该能映射成 run 的一部分或 run 的派生视图。

## Run 最小模型

一个 run 只保留四层信息。

### 1. Contract

这是任务契约，也就是这次任务要成为什么。

最小字段建议如下。

- `id`
- `title`
- `description`
- `success_criteria`
- `constraints`
- `workspace_root`
- `budget`
- `owner_id`
- `created_at`
- `updated_at`

这一层尽量稳定。除非用户明确修改任务定义，否则不要反复覆盖。

### 2. Attempts

这是 run 的推进历史。系统每做一次尝试，就追加一个 attempt。

当前阶段只需要两种 `attempt_type`。

- `research`
- `execution`

每个 attempt 的最小字段建议如下。

- `id`
- `run_id`
- `attempt_type`
- `status`
- `worker`
- `objective`
- `success_criteria`
- `workspace_root`
- `started_at`
- `ended_at`
- `input_context_ref`
- `result_ref`
- `evaluation_ref`

这里最关键的是，attempt 是执行原语，未来的 `branch` 不再是一等事实源。如果还需要 branch 这个词，它也应该只是某类 attempt 的展示名称。

### 3. Evidence

这是世界里真实留下的东西。

最小范围包括：

- `stdout.log`
- `stderr.log`
- `writeback.json`
- `patch.diff`
- `files/`
- `commands.json`
- `verify.json`

不是每次 attempt 都会有全部证据，但至少要有足够原始的痕迹，能支撑后续 verifier 和人类复盘。

### 4. Current Decision

这是系统当前时刻对 run 的压缩判断。

它不是源事实，而是从 contract、attempts 和 evidence 里派生出来的当前视图。

最小字段建议如下。

- `run_status`
- `best_attempt_id`
- `latest_attempt_id`
- `recommended_next_action`
- `recommended_attempt_type`
- `summary`
- `blocking_reason`
- `waiting_for_human`
- `updated_at`

## Run 目录落地

最小文件布局建议直接围绕 run 收拢，不再平铺 `state/`、`events/`、`artifacts/`、`reports/` 四套并行真相。

建议目录：

```text
runs/
  run_001/
    contract.json
    current.json
    journal.ndjson
    report.md
    steers/
      steer_001.json
    attempts/
      att_001/
        meta.json
        context.json
        result.json
        evaluation.json
        stdout.log
        stderr.log
        artifacts/
          patch.diff
          verify.json
          files/
```

这里的角色分工很清楚。

`contract.json` 是任务契约。

`journal.ndjson` 是追加事实流，记录 run 的关键事件，比如创建 run、追加 steer、创建 attempt、attempt 完成、evaluation 完成、current decision 更新。

`current.json` 是当前压缩视图，给 loop 和 GUI 快速读取。

`report.md` 是给人读的当前高层视图。

`attempts/*` 是真实执行现场。

## Context 在 Run 里的位置

`context` 不再独立成长为系统级真相，而是 attempt 级的冻结切片。

每个 attempt 都有自己的 `context.json`。它表示这次尝试实际看到了什么。

这个 context 建议分成两层。

公共层：

- 当前 contract
- 当前有效 steer
- 当前 current decision
- 最相关的前序 evidence

角色层：

- research attempt 的研究焦点和证据要求
- execution attempt 的动作边界、工作目录和 verify 要求

这样设计的好处是，所有 agent 共享同一个 run 真相，但每次 attempt 都有自己明确、可复盘的上下文切片。

## Evaluator 在 Run 里的位置

`evaluator` 的输出不该漂在外面，而应该落回 attempt。

每次 attempt 结束后，都应该产生一个 `evaluation.json`。这是 evaluator 对这次尝试的判断结果。

最小字段建议如下。

- `attempt_id`
- `goal_progress`
- `evidence_quality`
- `verification_status`
- `recommendation`
- `rationale`
- `missing_evidence`
- `created_at`

这里最重要的不是精细分数，而是 recommendation 和 rationale 是否能真正支撑 loop 做下一步判断。

## State、Report、Plan 各自的位置

这三个词都保留，但都降级。

`state` 是 `current.json`

`report` 是 `report.md`

`plan` 是 current decision 里对“下一步最值得做什么”的判断

它们都不是事实源。真正的事实源只有 run 目录里的 contract、attempt 历史和 evidence。

## 当前仓库对象如何映射到 Run

当前代码里的对象不需要马上删除，但要逐步在心智上收进 run。

映射建议如下。

- `Goal` -> `Run.contract`
- `Branch` -> `Attempt.meta`
- `WorkerRun` -> `Attempt` 的执行记录字段
- `Steer` -> `runs/<id>/steers/*.json`
- `ContextSnapshot` -> `Attempt.context.json`
- `EvalResult` -> `Attempt.evaluation.json`
- `Report` -> `Run.report.md`
- `GoalStatus / BranchStatus` -> `Run.current` 和 `Attempt.meta.status`

## Run 不应该包含什么

为了避免 run 再次长胖，下面这些东西不要先做成一等事实源。

- 独立的 context board 真相
- 独立的 report history 真相
- 独立的 event store 真相
- 独立的 planner artifact 真相
- 过早结构化到很细的 evidence schema
- verification branch 这种未来能力

这些能力如果以后有必要，都应该优先从 run 派生，而不是先变成平级顶层目录。

## 第一阶段最小实现建议

run 设计落地时，不建议一口气推翻现有目录。更稳的做法是分三步。

第一步，在 `domain` 中引入 `Run`、`Attempt`、`CurrentDecision` 这三个最小 schema。

第二步，在 `state-store` 旁边增加 run-centered 的读写能力，让新数据先能落到 `runs/` 目录。

第三步，让 `orchestrator` 开始优先围绕 run 工作，同时旧的 `goal/branch` 接口先保留兼容，等 GUI 切过去后再继续收缩。

## 当前结论

`run` 的核心不是状态机，而是任务现场。

我们接下来不该继续问“还需要哪些模块”，而该问“这是不是 run 的一部分”。只要这个问题问清楚，很多复杂度会自己掉下去。
