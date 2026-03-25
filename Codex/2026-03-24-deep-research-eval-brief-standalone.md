# AISA Eval Deep Research Brief

日期 `2026-03-24`

这是一份给 deep research agent 的自包含需求文档。假设研究代理无法读取本地文件，因此这里已经内嵌了理解 AISA 当前阶段所需的关键背景、现状、约束和研究目标。

## 一句话任务

请为 AISA 设计一套面向案例和 goal 的 eval 体系，并调研已有 GitHub 项目中值得借鉴的方案，最终产出一份能直接指导 AISA 后续产品收敛和工程实现的研究报告。

## 项目是什么

AISA 当前全名是 `AutoResearch Swarm Dashboard`。

它不是新的底层模型，不是新的 coding agent，也不是聊天 UI。它的定位是一个 `agent orchestration control plane`。系统围绕一个 goal 发起多方向探索，让多个 agent branch 在共享上下文中推进任务，允许人类中途注入 steer，然后通过 judge 和 report 机制帮助任务收敛。

核心价值不在 worker 本身，而在外层 loop、分支调度、共享上下文、人工 steer、证据回写、阶段性报告和择优收敛。

## 当前产品判断

我们最近已经收敛出一个重要结论。AISA 第一阶段不应该停在只读 research dashboard，而应该做成一个带最小执行能力的 agent 工作台。

意思不是一开始就做复杂自动编程平台，而是第一条黄金路径里至少要有一条 `execution branch`，它能够在隔离现场执行最小真实动作，比如生成 patch、运行一个验证命令、产出成功或失败日志，并把这些结果带回控制面。否则系统仍然只是会汇总分析的研究原型，而不是能推进真实任务的工作台。

## 当前工程现状

AISA 现在已经是一个可运行的 TypeScript monorepo。主要模块有：

- `dashboard-ui`
- `control-api`
- `planner`
- `orchestrator`
- `worker-adapters`
- `context-manager`
- `judge`
- `state-store`
- `event-log`
- `report-builder`

系统已经跑通的主链大致是：

`goal -> planner -> branch -> worker -> writeback -> judge -> report -> dashboard`

现在能做到的事情包括：

- 创建 goal
- 生成 branch plan
- 调用 Codex CLI 作为 worker
- 收集 writeback
- 更新共享上下文
- 记录事件和产物
- 生成 current report
- 在 dashboard 中查看 goal、branch、context、report、events
- 人工提交 steer
- branch rerun

## 当前实现的关键限制

虽然主链已经可跑，但它现在仍然偏研究型原型。

最重要的几个限制如下。

第一，planner 目前是硬编码模板，不是真正的任务策略器。它固定生成 3 条 branch，分别偏主流程、上下文协议、风险验证。

第二，worker 目前默认是只读分析模式。底层用 `Codex CLI`，sandbox 默认是 `read-only`。这意味着它更像分析型 branch，而不是执行型 branch。

第三，judge 目前仍然是规则评分器，主要根据 findings 数量、evidence 比例、recommended next steps 和 confidence 来打分。也就是说，它评的是输出形状，不是任务结果。

第四，dashboard 目前主要是可观察面板，还没有真正围绕单个 run 的执行证据和决策过程做最强表达。

## 当前系统运行方式

为了帮助你理解 eval 该评什么，这里给出当前系统实际运行的简化描述。

### 1. Goal

用户通过 API 或 dashboard 创建一个 goal。goal 包含：

- `title`
- `description`
- `success_criteria`
- `constraints`
- `owner_id`
- `workspace_root`
- `budget`

其中 budget 至少包括：

- `tokens`
- `time_minutes`
- `max_concurrency`

### 2. Planner

系统收到 goal 后，会生成：

- `plan.md`
- `branch_specs.json`
- `eval_spec.json`

当前 planner 的 `eval_spec` 维度固定为：

- `relevance`
- `evidence_quality`
- `actionability`
- `cost_efficiency`

阈值大致是：

- `keep_threshold = 0.75`
- `rerun_threshold = 0.45`

### 3. Branch

当前 branch 主要有这些字段：

- `id`
- `goal_id`
- `parent_branch_id`
- `hypothesis`
- `objective`
- `success_criteria`
- `assigned_worker`
- `status`
- `score`
- `confidence`
- `context_snapshot_id`
- `latest_run_id`

当前 branch status 包括：

- `created`
- `queued`
- `running`
- `writing_back`
- `judging`
- `kept`
- `discarded`
- `respawned`
- `failed`
- `stopped`

### 4. Worker Adapter

当前唯一已接入的 worker adapter 是 Codex CLI adapter。

它会：

- 生成 task spec
- 生成 worker prompt
- 调用 `codex exec`
- 要求 worker 只返回 JSON
- 解析 JSON 成 writeback
- 落地 stdout、stderr、writeback、report

当前 worker prompt 的核心规则包括：

- 以只读分析模式工作
- 尽量使用本地仓库证据
- 证据不足时明确说明
- 只返回 JSON

### 5. Worker Writeback

当前系统要求 worker 返回的结构大致如下：

- `summary`
- `findings`
- `questions`
- `recommended_next_steps`
- `confidence`
- `artifacts`

其中 `findings` 中每一项当前包括：

- `type`，目前通常是 `fact`、`hypothesis`、`risk`
- `content`
- `evidence`

当前 `evidence` 只是字符串数组，通常是相对路径或命令，没有更强结构化设计。

### 6. Orchestrator

orchestrator 轮询 goals，挑出 queued branches，按并发额度启动 worker。每个 branch 执行时会：

- 读取 goal 和 plan
- 读取 queued steer
- 构建 context snapshot
- 把 branch 状态改成 running
- 创建 worker run
- 调用 adapter 执行
- 写回 context
- 调用 judge
- 更新 branch 状态
- 刷新 goal report

### 7. Judge

当前 judge 的评分逻辑大致是：

- findings 越多，分数越高
- findings 中带 evidence 的比例越高，分数越高
- 有 recommended next steps，分数更高
- confidence 会进入总分
- questions 太多会扣分

最终根据分数给出：

- `keep`
- `rerun`
- `request_human_review`

这说明 eval 的“位置”已经存在，但现在还远远不够成为系统验收机制。

## 我们已经明确的路线图

当前团队已经形成的路线判断是：

第一阶段要打穿一条黄金路径，而不是继续堆概念。推荐场景是一个面向本地代码仓库的任务。

这条黄金路径应该长这样：

- 用户创建一个 goal
- 系统生成少量 branch
- 至少有一条 `research branch`
- 至少有一条 `execution branch`
- research branch 负责结构理解、风险识别、上下文归纳
- execution branch 负责最小真实动作和证据留存
- 人工 steer 能在下一轮明确生效
- judge 依据 success criteria 和证据做判断
- report 能支持下一步开发决策

团队目前倾向于避免过度工程，因此有几个明确原则：

- 文件系统优先，不急着上数据库和复杂消息系统
- 最小 execution capability 优先，不急着做复杂自动合并
- 先跑通真实任务，再固化更复杂的 schema 和 contract
- 不要做脱离产品阶段的宏大评测平台

## 为什么现在要做 eval 研究

当前最大问题不是系统完全没法跑，而是我们缺少一套真正服务于系统验收的 eval 方法。

现在如果只靠肉眼看 dashboard、读 report、感觉 branch 输出“还不错”，很难回答下面这些关键问题：

- AISA 到底有没有越来越接近一个可用工作台
- 哪些改动真的提升了任务完成质量
- 哪些 branch 只是更会写总结，并没有推进任务
- 哪些 goal 类型适合当前阶段
- 什么才算一次任务真正完成
- 人工 steer 是否真的改变了后续行为
- execution branch 产出的证据是否足够支撑保留和收敛

我们需要的是一套 case-based、goal-aware、result-oriented 的 eval，而不是通用 LLM benchmark。

## 本轮研究真正要解决的问题

请围绕下面这些问题展开深度研究。

### 1. Eval 应该分几层

请判断对 AISA 这种系统来说，合理的 eval 结构应该如何分层。

我们目前倾向于至少分成三层：

- 系统级 eval
- 案例级 eval
- goal 级 eval

但我们不希望只是概念分层，而是希望知道每一层真正该评什么，不该评什么，哪些适合做硬门槛，哪些适合做趋势观察。

### 2. 面向案例的 eval 应该怎么设计

我们希望第一版 eval 面向真实案例，而不是抽象 benchmark。

请研究：

- 案例应该如何定义
- 案例需要包含哪些输入
- 案例应该如何描述 workspace、goal、success criteria、constraints、人工 steer、允许产物、失败条件
- 案例库应该偏研究型任务、执行型任务，还是两者混合
- 对 AISA 第一阶段来说，最值得纳入的前 5 到 10 个案例类型是什么

### 3. 面向 goal 的验收应该怎么设计

我们需要知道每个 goal 自己的验收标准应该如何表达，才能避免 judge 退化成“看起来还行”的文本评分器。

请重点研究：

- success criteria 应该如何写，才能被系统真正使用
- evidence、artifacts、最终 report 应该如何和 success criteria 对齐
- 哪些 goal 适合自动判断，哪些 goal 必须人工 review 兜底

### 4. Judge 应该如何演化

请从当前原型逻辑出发，给出一个现实可行的演化路径。

我们特别关心：

- 哪些规则可以继续先保留
- 哪些规则必须升级
- evidence 什么时候需要更强结构化
- judge 如何从“输出评分器”变成“结果验收器”
- judge 和人工 review 的边界应该怎么划

### 5. GitHub 上有哪些现成模式值得借鉴

请探索与下面这些主题真正相关的 GitHub 项目：

- multi-agent orchestration
- long-running goal-driven agent workflow
- agent evaluation harness
- coding agent benchmark / task harness
- artifact / evidence design
- trace / replay / report / review UI
- human-in-the-loop steer / review / rerun

不是要求找到一个和 AISA 完全一样的项目，而是找到在某些关键点上做得特别好的项目，并提炼具体可借鉴模式。

我们尤其需要你指出：

- 哪些项目在 case corpus 组织上值得借鉴
- 哪些项目在 artifact/evidence 表达上值得借鉴
- 哪些项目在 eval harness 设计上值得借鉴
- 哪些项目在 judge/review/workflow 设计上值得借鉴
- 哪些项目虽然看起来相关，但其实不适合 AISA 当前阶段

### 6. 最终推荐方案

请在研究结束后，给出一版适合 AISA 当前阶段的推荐方案。

这份推荐方案必须回答：

- AISA eval 第一版应该长什么样
- 第一批案例应该如何选
- 当前 judge 应该如何改
- 哪些能力该现在做
- 哪些能力现在不做反而更好

## 交付物要求

请输出一份研究报告，至少包含下面这些部分。

- 执行摘要
- 对 AISA 当前阶段和约束的复述
- 推荐的 eval 总体结构
- 第一批案例库建议
- goal 级验收建议
- judge 演化建议
- GitHub 项目探索与对比
- 最终推荐路线
- 明确的 now / later 取舍

## 报告必须做到

- 不要泛泛谈 AI eval 原则
- 不要只列项目名，不提具体借鉴点
- 不要把系统验收和单次任务评分混为一谈
- 不要默认我们要做大而全的平台
- 不要脱离当前工程现状给理想化方案

## 报告最好回答的几个关键判断

如果你能明确回答下面这些问题，这份研究就会非常有用。

- AISA 第一版 eval 的最小闭环到底是什么
- 系统级通过到底意味着什么
- 一个案例要写成什么样，才能拿来做回归验收
- execution branch 的证据最少要包含什么
- judge 的自动判断边界应该停在哪里
- 哪些 GitHub 项目值得直接借鉴设计，哪些只适合参考局部做法

## 起始探索方向

你可以从这些公开项目开始，但不必限制在这里。

- `karpathy/autoresearch`
- `openclaw/openclaw`
- `badlogic/pi-mono`
- 其他与 agent benchmark、task harness、artifact/evidence、trace/replay、goal-driven workflow 相关的 GitHub 项目

如果发现更强的样本，请优先采用更相关、更成熟、更贴近 AISA 当前阶段的项目。

## 研究判断原则

请始终按下面这些原则做判断。

- 产品落地价值优先于概念完整性
- 当前阶段适配优先于未来理想形态
- 真实案例优先于抽象 benchmark
- 结果和证据优先于漂亮摘要
- 取舍优先于面面俱到

## 最终输出的目标

读完你的研究报告后，我们希望团队可以立刻做三件事：

- 拍板 AISA eval 第一版结构
- 选出第一批案例
- 明确 judge 和 roadmap 的下一步改动方向

如果你的报告不能帮助我们做出这三件事，那就说明研究还不够贴近需求。
