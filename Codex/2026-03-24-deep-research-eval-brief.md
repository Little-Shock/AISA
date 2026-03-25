# AISA Eval System Deep Research Brief

日期 `2026-03-24`

## Intake Summary

我们正在开发 AISA，当前全名是 `AutoResearch Swarm Dashboard`。它不是新的底层模型，也不是新的单体 coding agent，而是一个运行在现有 agent 之上的 `agent orchestration control plane`。它的目标是围绕一个 goal 发起多方向探索，持续回写上下文，允许人工 steer，并通过评估与择优推进任务收敛。

目前项目已经有一个可运行的 MVP 骨架，主链大致是 `goal -> planner -> branch -> worker -> writeback -> judge -> report -> dashboard`。当前实现偏研究型原型，已经能创建 goal、生成分支、调用 Codex CLI、收集 writeback、做规则型评分、更新共享上下文并展示 dashboard。但它离一个可稳定推进真实任务的 agent 工作台还有距离。

我们最近收敛出的方向是，AISA 第一阶段不应该停在只读 research dashboard，而应该做成一个带最小执行能力的 agent 工作台。第一条黄金路径建议围绕一个本地代码仓库任务展开，系统至少要能生成 `research branch` 和 `execution branch`，其中 execution branch 要能在隔离现场执行最小真实动作并留下可验证证据。人工 steer 必须在下一轮明确生效，最终 report 必须能支持下一步开发决策。

在这个背景下，我们需要一套真正服务于系统验收的 eval 设计。重点不是做通用 LLM benchmark，也不是做漂亮但脱离产品的评分表，而是设计一套面向案例和 goal 的系统级验收方法，帮助我们判断 AISA 是否正在变成一个可用的 agent 工作台。

## Draft Goal Spec

### Goal Title

为 AISA 设计一套面向案例与 goal 的 eval 体系，并调研现有 GitHub 项目中的可借鉴方案

### Objective

产出一份可直接指导 AISA 后续设计与实现的研究结论，回答两个问题。第一，AISA 应该如何设计一套真正服务于系统验收的 eval 体系，尤其是面向案例和 goal 的多层验收逻辑。第二，现有 GitHub 项目中有哪些值得借鉴的产品模式、数据结构、benchmark 组织方式、evidence 设计、case corpus 设计和结果展示方式，可以帮助 AISA 少走弯路。

### Decision This Research Should Support

这份研究要支持一个具体决策。我们要决定 AISA 的 eval 系统第一版应该如何设计，第一批案例库应该如何组织，`judge` 应该如何从当前的粗糙规则评分升级为面向结果和证据的验收器，以及这些能力应该如何进入 roadmap，而不导致过度工程。

### Primary Audience

这份研究的第一读者是 AISA 的核心设计者和实现者，也就是正在定义产品方向、数据结构和核心模块的人。第二读者是后续参与实现 planner、judge、worker-adapters、dashboard 和 case corpus 的工程同学。

### Success Criteria

- 研究结果能清楚区分系统级 eval、案例级 eval、goal 级 eval 三层，不把它们混成一套分数。
- 研究结果能给出 AISA 第一版 eval 的推荐结构，而不是泛泛而谈的 AI 评测原则。
- 研究结果能提出第一批建议纳入的案例类型，并说明为什么这些案例最适合当前阶段。
- 研究结果能说明 `judge` 如何从当前实现升级为结果导向、证据导向的验收模块。
- 研究结果能给出对现有 GitHub 项目的具体观察，并提炼出可借鉴模式，而不是只做项目罗列。
- 研究结果能明确指出哪些能力应该现在做，哪些应该延后，避免过度工程。

## Project Context

### Current Product Positioning

AISA 的定位是一个 `goal-oriented` 的多 agent 控制面，不是新的 worker。核心价值在于外层 loop、共享上下文、评测择优、人工 steer 和 dashboard，而不在于重新造一个 agent 内核。

### Current Engineering State

当前仓库是 TypeScript monorepo，已有 `dashboard-ui`、`control-api`、`planner`、`orchestrator`、`worker-adapters`、`context-manager`、`judge`、`state-store`、`event-log`、`report-builder` 等模块。运行期状态优先落在文件系统，而不是数据库和消息队列。

当前 `judge` 的评分逻辑仍然偏原型化，主要依据 findings 数量、evidence 比例、recommended next steps 和 confidence 计算分数。这说明系统已经有“评估”这个位置，但现在评的是输出形状，不是任务结果。

### Current Roadmap Direction

我们已经形成一个比较明确的阶段判断。第一阶段要打穿的不是纯 research dashboard，而是一条最小可执行的黄金路径。推荐场景是针对一个本地代码仓库，用户创建一个 goal，系统生成少量 branch，其中至少有一条 research branch 和一条 execution branch。research branch 负责理解结构、发现风险。execution branch 负责在隔离现场执行最小真实动作，比如生成 patch、运行验证命令、产出日志或失败证据。人工 steer 在下一轮明确生效，judge 根据 success criteria 和证据做判断，最终 report 支持下一步决策。

### Why Eval Matters Now

我们不希望继续依靠直觉判断系统是否“看起来不错”。AISA 需要的是一套可复跑、可对比、可用来验收系统迭代的 eval 机制。这个 eval 既要能服务产品方向判断，也要能服务核心模块开发，还要能随着真实案例积累逐步演化。

## Research Questions

请围绕下面这些问题展开研究，但不要被问题顺序限制。

### A. Eval 的总体结构

对 AISA 这种 agent orchestration control plane 来说，一套好的 eval 应该分成哪些层次。系统级、案例级、goal 级分别应该评什么，不应该评什么。哪些指标应该作为硬门槛，哪些指标适合做连续观察。

### B. 面向案例的验收设计

第一批 case corpus 应该如何组织。案例应该如何定义输入、环境、goal、success criteria、允许产物、失败条件和人工 steer。案例应该偏向研究型任务、执行型任务，还是两者混合。对于当前 AISA 阶段，最值得纳入的前 5 到 10 个案例类型应该是什么。

### C. 面向 goal 的验收设计

每个 goal 自己的验收标准应该如何表达。success criteria、evidence、artifacts、judge 结论和最终 report 之间应该如何对齐。goal 级 rubric 应该如何避免沦为泛泛的文本评分。

### D. Judge 的演化路径

从当前代码出发，`judge` 最合理的演化路径是什么。哪些判断可以先继续规则化，哪些判断必须引入更强的结构化 evidence，哪些判断需要人工 review 兜底。怎样设计才能让 `judge` 成为结果验收器，而不是摘要评分器。

### E. GitHub 项目探索

请调研 GitHub 上与下面几类问题相关的项目，并提炼最值得借鉴的模式。

- 多 agent orchestration 或 control plane
- case-based / benchmark-based agent evaluation
- coding agent 的 benchmark、task harness、artifact/evidence 设计
- goal-driven long-running agent workflow
- 人工 steer、回合制 review、reporting、replay、trace 可视化

不是要找最像 AISA 的完整项目，而是要找在某些关键点上做得特别好的项目，比如 eval harness、case corpus 组织、artifact 结构、evidence 表达、judge 设计、report 呈现、任务回放等。

### F. 推荐方案

在调研结束后，请给出你认为最适合 AISA 当前阶段的一版推荐方案。这个方案要回答，我们现在应该先做什么，后做什么，哪些设计可以先简化，哪些如果不做会导致后面方向跑偏。

## Scope

### In Scope

- AISA 第一阶段和 V1 所需的 eval 体系设计
- case corpus 的组织方法
- goal / success criteria / evidence / artifact / report / judge 之间的关系设计
- 与 AISA 场景真正相关的 GitHub 项目和模式探索
- 面向当前仓库状态的演进建议
- 避免过度工程的 phased recommendation

### Out of Scope

- 通用 LLM benchmark 综述
- 与 AISA 当前阶段无关的大规模企业评测平台设计
- 完整自动化评分平台的细节实现
- 与本项目无关的纯学术 benchmark 讨论
- 只停留在“有哪些项目值得看”的浅层罗列

## Deliverable Brief

### Deliverable Kind

一份研究报告式需求方案，外加一份简明的建议清单。

### Working Title

`AISA Eval System Proposal and GitHub Landscape Review`

### One-Sentence Promise

这份报告要帮助 AISA 团队用最少的过度设计，建立一套真正服务于系统验收的 eval 体系，并借鉴已有 GitHub 项目的成熟做法。

### Must Include

- 一段简明的执行摘要，说明最核心结论
- 对 AISA 当前阶段和真实需求的重述，确保上下文准确
- 一个面向 AISA 的 eval 结构提案，清楚区分系统级、案例级、goal 级
- 第一批 case corpus 的建议范围和推荐案例类型
- 对 `judge` 演化路径的建议
- 对 evidence / artifact / report / steer 在 eval 中应扮演什么角色的建议
- GitHub 项目探索结果，包含项目名称、为什么相关、具体可借鉴点、局限
- 一份最终推荐路线，说明现在该做什么，后面再做什么
- 明确指出哪些设计属于过度工程，当前不建议做

### Must Avoid

- 泛泛的 AI eval 概论
- 大量没有落到 AISA 场景的 benchmark 术语
- 只罗列仓库名称，不提具体可借鉴点
- 不区分产品验收和工程便利的建议
- 把系统评测和单次任务评分混为一谈

### Publish Bar

读完之后，AISA 团队应该能直接拿这份报告做三件事。第一，决定 eval 第一版的结构。第二，选出第一批要收集的案例。第三，明确 judge 和 roadmap 的下一步改动方向。

## Suggested Exploration Seeds

下面这些可以作为起点，但不要限制在这里。

- `karpathy/autoresearch`
- `openclaw/openclaw`
- `badlogic/pi-mono` 中与 coding agent / orchestration 相关的部分
- 其他与 agent benchmark、task harness、artifact/evidence、trace/replay、goal-driven workflow 相关的 GitHub 项目

如果发现更相关或更新的项目，优先采用更强的样本，不必拘泥于起始名单。

## Operator Policy

- 以产品落地价值为第一判断标准，不以“概念完整性”作为优先级依据
- 优先使用 GitHub 仓库、README、文档、issues、源码结构等一手材料
- 必须明确区分事实、推断和建议
- 建议里要有取舍，不能把所有方向都列成“可选”
- 结论必须回到 AISA 当前阶段，而不是面向遥远未来的理想状态
- 如果发现我们当前假设有明显偏差，请直接指出

## Activation Verdict

`ready`

这份 brief 已经足够作为 deep research agent 的输入，不需要再补更多背景才能启动。

## Open Questions / Assumptions

- 假设本轮研究的第一优先级是 AISA 第一阶段的 eval 体系，而不是长期平台化评测系统。
- 假设 AISA 当前更关心面向代码仓库任务的 eval，而不是广义 web agent 或 consumer agent benchmark。
- 假设我们希望保留文件系统优先、最小执行能力优先、避免过度工程这几条原则。
- 如果研究过程中发现“最小 execution capability”本身需要调整定义，可以在报告中提出修订意见。

## Relevant Local Context To Read

如果 research agent 可以读取本地仓库，建议至少先看这些文件。

- `2026-03-20_autoresearch-swarm-dashboard_PRD.md`
- `Codex/2026-03-24-merged-roadmap.md`
- `packages/judge/src/index.ts`
- `packages/domain/src/index.ts`
- `packages/orchestrator/src/index.ts`
- `packages/worker-adapters/src/index.ts`

## Final Ask To The Research Agent

请基于以上背景，做一份面向 AISA 的深度研究。重点回答 eval 应该怎么设计，第一批案例应该怎么选，`judge` 应该怎么演化，以及现有 GitHub 项目里哪些模式最值得借鉴。输出必须足够具体，能直接反过来指导我们的需求收敛和后续实现。
