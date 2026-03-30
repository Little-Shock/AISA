# AISA Harness Roadmap

## 目标

这份 roadmap 只服务一件事。把 AISA 从当前已经能跑的 run-centered runtime，推进成一个更小、更硬、更容易维护的 execution harness。

路线不会重新起炉灶。我们保留已经有效的 run 主链、managed worktree、runtime verification 和 self-bootstrap 资产，只把真正薄弱的地方按顺序补硬。

## 当前所处位置

当前主线已经做到这些。

- `run -> attempt -> evaluation -> next attempt` 主链能跑
- execution 已经隔离到 managed worktree
- deterministic runtime verification 已经是硬门
- self-bootstrap 能生成 active next task，并能在 supervisor 里持续续跑

当前真正的短板也已经很清楚。

- execution 合同还不够像正式的发车规格
- execution 前没有独立的合同审查闸门
- 恢复入口仍然分散在多个文件里
- 某些失败会在 auto-resume 里重复出现，但没有被稳定归类和吸收

## Phase 0

先封住当前自举主链缺口，把已有主线收干净，再进入更大的结构改造。

这一阶段只做两件事。

- 完成当前 active next task，把 `verify:self-bootstrap` 纳入 `bootstrap:self` 的独立健康门
- 完成当前文档重构前的静态备份，冻结旧 PRD、蓝图和路线图快照

完成标准很直接。

- `bootstrap:self` 的 runtime health snapshot 会显式记录 self-bootstrap 健康状态
- `pnpm verify:self-bootstrap` 和 `pnpm verify:runtime` 继续通过
- 当前文档归档完成，新 PRD 和 roadmap 入库

## Phase 1

把 execution 从先跑再看，改成合同先行。

这一阶段的重点不是改更多界面，而是给 execution 发车前补一层正式审查。

要完成的东西有这些。

- 扩 `AttemptContract`，补 `done_rubric` 和 `failure_modes`
- 新增 `PreflightEvaluation` 工件
- dispatch 前强制跑 preflight evaluator
- preflight 不通过时，不创建 `running` execution attempt
- worker prompt 和 review input 都改成读取冻结后的 contract，而不是自由拼装说明

完成标准如下。

- 不合格合同不能发车
- 当前 run detail 能明确展示 preflight 失败原因
- `verify-run-loop` 和 `verify-runtime` 能覆盖至少一条 preflight fail-closed 场景

## Phase 2

把恢复和续跑入口收成一个 handoff bundle。

这阶段的目标很单一。任何一轮结束后，系统都要留下唯一可恢复的结构化交接包。

要落地的东西有这些。

- 新增 `handoff_bundle.json`
- 当前决策、review packet、runtime verification、健康门结论和下一轮目标都收进 handoff bundle
- auto-resume 只读 handoff bundle
- worker 恢复 prompt 只读 handoff bundle
- dashboard 解释当前状态时优先展示 handoff bundle 摘要

完成标准如下。

- 恢复现场时不再需要拼多个来源文件
- 同一轮失败原因只写一份，不在 summary、report、prompt 里反复漂移
- 至少有一条回归能证明 `no_git_changes` 不会再被当成正常推进重复消化

## Phase 3

把失败分类和恢复策略彻底分开。

这阶段不追求更多能力，只追求更稳的恢复语义。

建议固化下面这些 failure class。

- `invalid_contract`
- `stale_baseline`
- `no_git_changes`
- `deterministic_verification_failed`
- `worker_stalled`
- `runtime_source_drift`
- `evaluator_uncertain`
- `human_input_required`

每类失败都要对应明确恢复策略，而不是继续让 orchestrator 走模糊分支。

完成标准如下。

- journal、report、dashboard 和 handoff bundle 对同一轮失败给出同一分类
- `worker_stalled` 才允许短退避重试
- `invalid_contract` 和 `stale_baseline` 会退回修合同或修现场，不会直接盲目续跑

## Phase 4

把执行者选择收成槽位配置，把模型自由组合留在适配层。

这一阶段只做架构降噪，不增加外部复杂度。

要做的事情是。

- 引入 slot registry
- 明确 `research_or_planning`、`execution`、`preflight_review`、`postflight_review`、`final_synthesis` 五类槽位
- 每个槽位定义统一输入、权限和输出协议
- 允许不同执行者按槽位绑定，但内核不新增供应商判断分支
- run contract 新增 `harness_profile`

完成标准如下。

- 同一条 run 可以把 execution 交给 Codex，把 review 交给 Gemini 或 Claude，而内核代码不增加按品牌分叉的流程判断
- Lite、Standard、Heavy 三档 profile 可以显式选择
- 现有 reviewer 和 synthesizer 配置自然迁移到新槽位体系

## Phase 5

按任务类型装配 verifier kit，把 heavy harness 留给真正高风险任务。

这阶段才进入更强的任务分型。

建议最先支持三类 verifier kit。

- repo task
- web app task
- data task

每类 kit 都有自己的 deterministic checks 和真实环境抓手。这样可以避免所有任务都停留在“看文本写回”的轻判断里。

完成标准如下。

- repo task 默认看 patch、git、tests 和 runtime verification
- web task 可以接 Playwright 类真实环境验证
- data task 可以接查询、样本和指标断言
- heavy profile 只在这些高成本验证任务里启用

## Phase 6

把 evaluator calibration 正式变成维护主线。

这阶段不是继续堆产品表面能力，而是让 verifier 越跑越准。

需要建立的东西有这些。

- 线上误判样本回灌流程
- 从 review packet 提炼 failure mode 的流程
- reviewer prompt 和 eval 数据集的版本化更新流程
- false positive 和 false negative 的固定回归位

完成标准如下。

- 每次 verifier 误判都能沉淀为新 case，而不是只停在一次性修 prompt
- `evals/` 目录和线上 run 的失败样本开始真正打通

## 当前阶段明确不做

为了保证架构保持小，下面这些事情暂时不进主线。

- 多实例分布式 orchestrator
- 队列系统和任务总线
- 图式 agent 编排器
- 自动 issue 池和复杂 trigger engine
- 企业权限体系

## 下一步实施顺序

真正的落地顺序只看三轮。

先做 Phase 0，收好当前自举主链和文档基线。再做 Phase 1 和 Phase 2，把 execution contract 和 handoff bundle 立起来。等这两件事情站稳，再做 failure class 和 slot registry。后面的 typed verifier kit 和 calibration loop 不着急提前做重。

## 最终判断

这份 roadmap 的核心不是把 AISA 变成更大的系统，而是把它变成更小的内核。

只要 execution contract、verifier stack 和 handoff bundle 三件事站住，AISA 后面无论接谁来执行、加多少 profile，都还能保持优雅和可维护。
