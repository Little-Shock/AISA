# AISA 合并路线图

日期 `2026-03-24`（修订版，合并 Claude 过度工程化审查反馈）

这份文档把 Codex 和 Claude 两边的建议合成一版最终路线图，目标是收掉前面文档里的优先级摇摆，让产品目标、工程动作和完成标准指向同一条线。

## 先定结论

AISA 的第一阶段不建议停在 research dashboard。更合适的定位是，做一个带最小执行能力的 agent 工作台。原因很直接。如果第一阶段只做只读研究，项目会继续停在会拆分支、会汇总报告、会展示状态的原型层。这样的系统能证明 orchestration 架子成立，但还不能证明它能稳定推进真实任务。

所以第一阶段就应该包含最小 execution capability，但执行范围要收得很窄。不是一上来就做复杂并发改写、自动合并和多租户调度，而是只要求一条 execution branch 能在隔离现场里完成真实动作，留下完整证据，并把结果带回控制面。

## 第一阶段要打穿的黄金路径

建议只打穿一个场景。针对一个本地代码仓库，用户创建一个 goal，系统生成少量 branch，其中至少包含一条 research branch 和一条 execution branch。research branch 负责读代码、提炼结构、指出风险。execution branch 负责在隔离工作区里做最小真实动作，比如生成 patch、跑一个验证命令、写出失败或成功证据。用户可以在中途注入 steer，steer 在下一轮明确生效。judge 不只看输出长得像不像，而是看结果是否对齐 success criteria，是否附带可验证证据。最后 report 不只是摘要拼接，而是能支持下一步开发决策。

如果这条链打不穿，后面的 SSE、trigger、长期记忆、多实例都不该提前展开。

## V1 Definition of Done

V1 至少要满足下面这个标准。

- 一个真实仓库任务可以从 goal 创建走到最终 report。
- 系统能生成合理的 branch 组合，而不是固定模板硬编码。
- 至少一条 execution branch 能在隔离现场完成真实动作。
- 人工 steer 能在下一轮明确生效，并能在事件或上下文里看见生效痕迹。
- judge 的结论能和 success criteria、验证产物对上。
- report 能支持下一步动作决策，而不是只做信息汇总。
- 开发环境不依赖真实 Codex API 才能演练主链。

## 推荐的分阶段顺序

### Phase 1：最小模型变更（1-2 天）

这一阶段只做最小的模型层改动，不做大设计。

- 在 `domain` 的 `BranchSpec` 中加入 `branch_type` 字段（`research | execution`），默认 `research`。不前置定义 `verification`，等有 execution 产出后再加。
- 写半页黄金路径描述，存入 `docs/decisions/`。明确第一条链路的输入、输出和失败条件。
- **不做** 完整 evidence schema、worker contract 固化、verification branch 定义。这些在没有真实 execution 产出之前定义大概率需要返工。

> 原则：当前 writeback 已有 `findings[].evidence` 数组，够用。先跑起来，看到真实产出后再定义结构化 evidence。

### Phase 2：补最小可开发闭环（2-3 天）

这一阶段解决的是开发和验证成本，但所有动作都服务第一条黄金路径。

- 抽象统一的 `WorkerAdapter` interface。
- 实现 `MockWorkerAdapter`，让主链可以在本地和 CI 演练。
- 修正 `.env.example` 里的默认路径和跨平台配置问题。
- 改善 `control-api` 的错误处理，区分 400、404 和 500，不再用统一 404 吞掉真实错误。
- 补最小决策记录，把为什么先做 control plane、为什么文件系统优先、为什么第一阶段只做最小 execution 记下来。

这里的重点不是把仓库修漂亮，而是把主链变成一个不依赖外部条件也能持续验证的系统。

### Phase 3：最小 execution 能力 + 核心模块升级（3-5 天）

这一阶段让系统从只读原型跨到最小可执行工作台。用最少的代码改动跑通第一次 execution，再根据真实产出回来完善。

- **execution branch 落地**：让 Codex adapter 支持 `workspace-write` sandbox 参数。execution branch 使用独立工作目录（git worktree 或 temp copy）作为隔离现场。不需要新的隔离抽象——当前代码已经为每个 branch 保留了 stdout/stderr/output 目录，增量工作只是改 sandbox 参数 + 指定独立 `--cd` 目录。
- **planner 改进**：让 branch 数量和 hypothesis 从 goal 的 description/success_criteria 派生，而不是写死三条固定模板。不做"策略选择器"——只有一种场景时不需要策略选择器。
- **judge 改进**：评分从输出形状转向结果质量，对齐 success criteria。
- **dashboard 改进**：从总览优先改成 run page 优先，把用户最关心的状态时间线、证据、steer、生效边界和推荐动作放前面。
- **SSE**：在这个阶段补，作为体验增强。

> 原则：先跑通一次 execution（改参数 + 指定目录），看到真实产出后，再根据实际产物定义 worker contract 和 evidence schema。这才是"文件系统优先、可观察优先"的精神。

### Phase 4：扩展能力（以后）

只有前三阶段稳定以后，再去碰这些能力。

- verification branch 真正参与复核和 rerank。
- worker contract 和 evidence schema 正式固化（基于 Phase 3 的真实产出）。
- 更复杂的 planner 策略和多轮分叉。
- trigger engine。
- 长期记忆。
- 多实例管理。
- 更自动化的 merge 和回写。

## 对 Claude 建议的吸收

Claude 那边提的几项工程建议都保留，而且优先级不低。`MockWorkerAdapter`、统一 adapter interface、`.env.example` 修正、错误处理和决策记录，都是应该尽快做的。这些建议的价值，在于它们让主链验证不再依赖真实外部环境，也让后面的扩展有更稳的底座。

但这些工程项不再单独构成路线图主线。它们现在被放进 Phase 2，是因为它们服务于黄金路径，而不是替代黄金路径。

## 对 Codex 建议的吸收

Codex 那边提的场景收窄、branch 分层、黄金路径和更硬的 V1 DoD，被直接吸收为这份路线图的主骨架。branch 区分是 planner、judge、预算控制和 worker 抽象的前提。

同时做了两个收束。第一，execution capability 要前移，但不做成大而全。第一阶段只要求最小执行，不要求复杂并发写入，不要求自动合并，不要求完整企业级治理。第二，不过早固化 contract 和 schema。先用最少改动跑通 execution，看到真实产物后再定义结构化协议，避免设计空转。

## 最终优先级

如果压成一句最实用的话，顺序就是这样。

先在 domain 里加个 branch_type 字段，再把 mock adapter 和开发闭环补稳，然后改一个 sandbox 参数跑通第一次 execution，看到真实产出后升级 planner 和 judge，最后再做规模化能力。

这份路线图的核心不是多做功能，也不是多做设计，而是用最少的改动让 AISA 从会跑的研究原型，跨到能推进真实任务的最小工作台。
