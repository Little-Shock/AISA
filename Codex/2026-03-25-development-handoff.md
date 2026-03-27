# AISA 开发交接文档

这份文档给下一位接手开发的同事。

目标不是讲一堆背景，而是让人接过来以后，能快速知道现在系统处在哪，哪些东西已经改了，哪些地方还只是过渡态，下一步应该先做什么。

## 1. 现在这条开发线在做什么

当前这条线的核心目标，是把 AISA 从旧的 `goal / branch / judge / report` 原型，往新的最小架构收。

我们已经达成的架构共识是：

- 最小核心只有四个东西：`run`、`worker`、`evaluator`、`loop`
- `run` 是唯一事实源
- `worker` 是外部执行者，目前就是 Codex CLI adapter
- `evaluator` 是判断这次尝试是否推进 goal 的槽位
- `loop` 是推进器，读取 run，决定下一次 attempt，调用 worker，吃 evaluator 结果，再更新 current decision

同时也明确了几件事：

- `planner` 不是顶层组件，它是 loop 里的 planning logic
- `state` 不是独立真相，它只是 run 的当前视图
- `context` 不是单独系统，它是每次 attempt 的冻结切片
- `report` 不是本体，它只是 run 的人类视图

这意味着当前开发方向不是继续堆新模块，而是持续把旧系统的分散概念往 `run-centered` 这套心智模型上收。

## 2. 当前代码已经落到哪里

这次已经不是只写文档，核心骨架已经进代码了。

### 2.1 `run` 已经成为一个真实对象

相关文件：

- `packages/domain/src/index.ts`
- `packages/state-store/src/index.ts`
- `apps/control-api/src/index.ts`

现在已经有这些 schema 和数据对象：

- `Run`
- `Attempt`
- `CurrentDecision`
- `AttemptEvaluation`
- `RunSteer`
- `RunJournalEntry`

当前文件落地方式已经是：

- `runs/<run_id>/contract.json`
- `runs/<run_id>/current.json`
- `runs/<run_id>/journal.ndjson`
- `runs/<run_id>/report.md`
- `runs/<run_id>/artifacts/runtime-health-snapshot.json`
- `runs/<run_id>/steers/*.json`
- `runs/<run_id>/attempts/<attempt_id>/meta.json`
- `runs/<run_id>/attempts/<attempt_id>/context.json`
- `runs/<run_id>/attempts/<attempt_id>/result.json`
- `runs/<run_id>/attempts/<attempt_id>/evaluation.json`
- `runs/<run_id>/attempts/<attempt_id>/stdout.log`
- `runs/<run_id>/attempts/<attempt_id>/stderr.log`
- `runs/<run_id>/attempts/<attempt_id>/artifacts/`

一句话说，现在一次任务的真相已经开始围着 `runs/<run_id>/` 组织，而不是散落在好几套平行概念里。

其中 `runs/<run_id>/artifacts/runtime-health-snapshot.json` 是给 self-bootstrap 用的只读运行时体检产物，当前最小 schema 包含：

- `verify_runtime`
- `history_contract_drift`
- `created_at`

### 2.2 API 已经能围着 `run` 工作

当前已经有最小 run API：

- `GET /runs`
- `GET /runs/:runId`
- `POST /runs`
- `POST /runs/:runId/launch`
- `POST /runs/:runId/steers`

这意味着控制面已经不必只走旧的 goal/branch 流程了。

### 2.3 loop 已经跑起来了

相关文件：

- `packages/orchestrator/src/index.ts`
- `packages/judge/src/index.ts`
- `packages/worker-adapters/src/index.ts`

当前 loop 的行为不是空壳，已经有一个能工作的最小闭环：

- run 进入 `running`
- loop 看 `current decision`
- 没有 attempt 时会起第一条 `research` attempt
- attempt 执行完以后走 `evaluateAttempt`
- evaluator 输出 recommendation 和 `suggested_attempt_type`
- loop 根据 evaluator 结果更新 `current decision`
- 如果 research 证据足够，会转向 execution
- 如果连续两次同类型尝试还没推进，会停在 `waiting_steer`
- 人类 steer 进入后，loop 会基于 steer 再起下一次 attempt

### 2.4 evaluator 已经从打分器往决策器走了一步

`AttemptEvaluation` 现在新增了：

- `recommendation`
- `suggested_attempt_type`
- `verification_status`
- `missing_evidence`

当前 evaluator 还是启发式，不是最终答案，但至少它已经不只是给一个分数，而是在明确告诉 loop 下一步偏向什么。

## 3. 当前 loop 的真实语义

这里要讲清楚，不然接手的人很容易以为现在还是旧的 branch 调度逻辑。

### 3.1 现在 loop 真正依赖的东西

run loop 当前主要依赖这几个对象：

- `Run`
- `Attempt[]`
- `CurrentDecision`
- `RunSteer[]`
- `AttemptEvaluation`

它不再主要依赖 attempt 数量去硬编码下一步，而是尽量按 `CurrentDecision` 和 `AttemptEvaluation` 的组合去走。

### 3.2 `CurrentDecision` 现在承担什么

`CurrentDecision` 是 run 的当前压缩视图，主要回答这些问题：

- run 当前状态是什么
- 上一次 attempt 是谁
- 当前最优 attempt 是谁
- 下一步建议做什么
- 下一步更偏 research 还是 execution
- 是否在等人
- 当前卡点是什么

现在代码里出现过的 next action 主要有这些：

- `start_first_attempt`
- `attempt_running`
- `continue_research`
- `start_execution`
- `continue_execution`
- `retry_attempt`
- `wait_for_human`

这些值还不是严格枚举化的状态机语言，但已经足够表达当前最小 loop。

### 3.3 当前 evaluator 的行为

研究型 attempt：

- 看 findings
- 看 evidence quality
- 看 confidence
- 看有没有明确的 next step
- 产出 `continue / retry / wait_human`
- 如果 evidence 和 next step 足够好，会给出 `suggested_attempt_type = execution`

执行型 attempt：

- 看 evidence quality
- 看 confidence
- 看 artifacts
- 给出 `verification_status`
- 产出 `retry / wait_human / complete`

当前设计思路是：

- research 主要负责看懂问题，产出一个可执行下一步
- execution 主要负责做真实动作并留下证据

### 3.4 当前 loop 的一个重要约束

为了避免系统盲转，现在加了一个简单刹车：

- 如果 evaluator 还在让 loop `continue` 或 `retry`
- 但连续两次都是同类型 completed attempt
- 并且下一步建议还是同类型

那 loop 会停下来，进入 `waiting_steer`

这不是最终最优策略，但在最小产品阶段是合理的。它能避免系统在没有 fresh signal 的时候一直空转。

## 4. 已经做过的验证

这部分是给接手的人一个底。

### 4.1 类型检查已通过

已经跑过：

```bash
pnpm typecheck
```

通过。

### 4.2 loop smoke 已经跑过

新增了一个 repo 内的验证脚本：

- `scripts/verify-run-loop.ts`

已经跑过：

```bash
pnpm tsx scripts/verify-run-loop.ts
```

这个脚本验证了两条关键路径。

第一条是 happy path：

- 第一次 attempt 是 `research`
- evaluator 判断可以进入 `execution`
- 第二次 attempt 是 `execution`
- execution 完成后 run 进入 `completed`

第二条是 pause path：

- 连续两次 `research`
- evidence 还是不够
- loop 不会继续空转
- run 进入 `waiting_steer`

脚本输出已经证明这两条路径都通过了。

### 4.3 之前还做过真实 API 验证

之前已经实际用 control-api 跑过：

- 创建 run
- launch run
- loop 自动创建 attempt
- attempt 文件真实落盘到 `runs/<run_id>/attempts/...`

当时使用的是真 Codex adapter，不是 fake adapter。

## 5. 当前代码里哪些地方还是过渡态

这部分很重要。现在这条线虽然已经能跑，但离“优雅终态”还有距离。

### 5.1 orchestrator 里还同时挂着旧 goal/branch 逻辑和新 run loop

这是当前最大的结构性现实。

`packages/orchestrator/src/index.ts` 里目前同时存在：

- 老的 goal/branch orchestration
- 新的 run-centered loop

也就是说，这个文件现在是过渡态，不是终态。

当前做法是先把 run loop 长出来，而不是马上删旧世界。

后续应该逐步把 run loop 提纯，而不是继续把新逻辑往旧 branch 体系里塞。

### 5.2 evaluator 还是启发式

`packages/judge/src/index.ts` 里的 `evaluateAttempt` 还只是第一版 heuristic。

它现在已经比“只打分”强，但还远没有到可信 verifier 的状态。

最需要继续提升的是：

- execution 的 verify 要更多依赖真实世界证据
- 不同 goal 类型的 evaluator 要逐步分化
- evaluator 不该长期只看 writeback 文本

### 5.3 next action 还是字符串协议

`CurrentDecision.recommended_next_action` 现在还是字符串。

这在最小阶段是能接受的，但长期看会有两个风险：

- 语义容易漂
- loop 条件判断会变松散

后续如果 loop 继续扩展，建议把它收成显式枚举。

### 5.4 execution 还不是真正完整的“验证闭环”

现在 execution 已经有最小支持，但还不够完整。

当前更像：

- 允许执行
- 允许带回 artifacts
- evaluator 会把 artifacts 算进判断

但还没有形成足够强的 verify contract，比如：

- 明确的命令验证结果结构
- patch 落地检查
- 测试结果结构化
- 更强的 artifact schema

### 5.5 GUI 还没有切到 run-centered

这是当前最直接的产品缺口。

后端已经有 `/runs`，但前端主视角还没有彻底切过来。

如果下一位同事继续接手，我认为产品上最值钱的动作不是再加后端层，而是把 GUI 切到真实 run detail page。

## 6. 接手之后最建议先做什么

如果接手的人时间有限，我建议优先级是这样理解的。

先把 GUI 切成 run-centered，再继续打磨 evaluator，最后才考虑怎么处理旧 goal/branch 世界。

更具体一点：

### 第一优先级

做一个真正的 run detail page。

这个页面至少要同时看到：

- contract
- current decision
- attempt timeline
- raw evidence
- evaluator judgment
- steer input

为什么先做这个。

因为现在后端骨架已经在了，但如果 GUI 还看不到 run 的真实现场，就没法形成工作台体验，也没法帮助后续 debug evaluator 和 loop。

### 第二优先级

继续把 evaluator 往 verifier 方向收。

建议重点补：

- execution 的验证证据结构
- `artifacts` 的最小协议
- 真实命令结果和 patch 的结构化信息
- evaluator 对 execution 结果的更硬判断

### 第三优先级

把 orchestrator 里的 run loop 和旧 goal/branch 逻辑进一步解耦。

不建议立刻大拆文件。

建议做法是：

- 新功能只往 run loop 里加
- 旧 branch 体系不再继续扩张
- 等 GUI 跑在 run 上以后，再逐步判断旧世界要不要保留兼容层

## 7. 接手时建议先看的文件

如果要快速上手，建议先按这个顺序看。

先看：

- `packages/domain/src/index.ts`

这里能看见最小对象长什么样。

再看：

- `packages/state-store/src/index.ts`

这里能看见 run 在文件系统里怎么落。

然后看：

- `packages/orchestrator/src/index.ts`

这里能看见 loop 现在到底怎么推。

接着看：

- `packages/judge/src/index.ts`

这里能看见 evaluator 现在怎么给出下一步意图。

再看：

- `packages/worker-adapters/src/index.ts`

这里能看见 attempt 的上下文和 worker prompt 是怎么构建的。

最后看：

- `apps/control-api/src/index.ts`
- `scripts/verify-run-loop.ts`

前者看 API 面，后者看我们如何验证 loop。

## 8. 当前最容易踩的坑

这里单独写一下，避免接手时往回走。

第一个坑，是把 `state` 再次当成独立真相。

不要再把 `CurrentDecision` 理解成 source of truth。它只是 run 的当前视图。真正的事实还是 contract、attempt、evaluation、journal、artifacts 这些东西。

第二个坑，是继续把 planner 做成新顶层模块。

当前共识已经很明确，planning 是 loop 的一部分，不是第五个核心原语。

第三个坑，是把 evaluator 再做回一个文本打分器。

方向应该是反过来，越来越依赖真实证据和 verify，而不是越来越依赖“写得像不像”。

第四个坑，是过早大拆旧 branch 系统。

现在更合理的做法不是大迁移，而是继续让 run-centered 路径变强，直到旧路径自然退场。

## 9. 如果继续开发，我建议的最小任务切法

如果需要马上接着开发，我建议从下面这种粒度切任务。

任务 A：

做 run detail page，先只读展示，不追求花哨。

任务 B：

把 `/runs/:runId` 的返回进一步补齐 attempt result 和 evaluation 的消费路径，方便前端直接吃。

任务 C：

给 execution attempt 的 artifacts 增加最小结构化信息，比如 patch、command result、test result。

任务 D：

把 evaluator 里与 execution 相关的 verify 逻辑再收硬一点。

任务 E：

根据 GUI 使用反馈，再决定 `CurrentDecision` 的 action 语言是否要枚举化。

## 10. 结论

这条线现在已经从“讨论架构”走到了“最小骨架进代码”。

已经完成的关键转变是：

- run 已经是一个真实对象
- run loop 已经能工作
- evaluator 已经开始驱动下一步决策
- system 已经会在卡住时停下来等 steer

现在最值钱的事情不是继续做抽象，而是把这条 run-centered 闭环变成真实可用的工作台体验，然后继续把 verify 做硬。

如果接手的人认同这条方向，接下来最应该做的不是发明新模块，而是让现有四个原语更干净。
