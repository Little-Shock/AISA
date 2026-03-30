# AISA Harness PRD

## 文档信息

- 版本 `v1`
- 日期 `2026-03-29`
- 适用阶段 `当前主线 -> 下一阶段实现`
- 目标 用更小、更硬、更容易维护的架构，重写 AISA 的产品定义与核心约束

## 这份 PRD 在解决什么

AISA 现在已经不是一个空壳控制面。它已经具备 `run`、`attempt`、`review packet`、`runtime verification`、独立 managed worktree 和 self-bootstrap 主链。

但当前顶层叙事仍然残留了较重的 swarm 和 dashboard 视角。这会带来三个长期问题。

- 系统的真相分散在多个派生视图里，恢复和续跑需要拼很多文件
- execution 是否该发车，往往要等跑完才知道合同够不够硬
- 一旦把更多 agent 和能力继续堆进 orchestrator，内核会越来越重，后续难维护

下一阶段不再把 AISA 定义成一个泛化的多 agent 控制面，而是把它收成一个面向长时应用开发的 run-centered harness。

## 一句话定义

AISA 是一个围绕单个 `run` 持续推进的 long-running application development harness。

它的职责很克制。先冻结任务契约，再生成和审查本轮执行合同，再派发给外部执行者，再用可回放验证和怀疑式评估判断是否真正推进，最后留下唯一可恢复的交接包。

## 产品定位

AISA 不是新的底层模型，不是新的单体 coding agent，也不是一个默认重型的多智能体图编排器。

AISA 是一个小内核系统。它负责维持任务事实、执行合同、验证闸门、恢复现场和人类介入边界。至于具体由 Codex、Claude Code、Gemini、Pi 还是其它执行者完成某一步，是适配层和配置层的问题，不进入内核分支逻辑。

## 产品目标

### G1 合同先行

任何 `execution` 都必须先有明确、可审、可验证的 `attempt contract`。合同不过关，不允许派发。

### G2 验证驱动

系统必须把 deterministic runtime verification 继续保留为硬门，并把执行前审查和执行后审查都正式接入主链。

### G3 单包交接

每一轮结束后，系统必须留下唯一可恢复的 `handoff bundle`。auto-resume、人工恢复、worker prompt 和 dashboard 读取同一份来源锚点。

### G4 分层 harness

不是所有 run 都开重型流程。AISA 必须支持轻量、标准、重型三档 harness，让成本和任务风险匹配。

### G5 适配器可组合

不同槽位可以自由绑定不同执行者，但内核不直接认识供应商名字。内核只认识槽位、输入合同、输出工件和验证结果。

## 非目标

- 不引入新的基础设施层，不上队列、数据库、分布式调度
- 不把 planner 重新抬成顶层中心组件
- 不默认给所有任务启用重型多评审、多回合修复外壳
- 不把 deterministic verification 让位给模型互评
- 不做图编辑器式 agent graph 编排

## 核心设计原则

### 1. Run 是唯一事实源

所有稳定真相都围绕 `run` 收口。`report`、`dashboard view`、`current decision` 都是派生视图。

### 2. Contract-first

execution 的工作范围、成功标准、禁止偷懒方式、必须留下的证据和验证命令，都要在执行前冻结。

### 3. Verifier first

模型可以参与评审，但不能替代 deterministic verification。任何需要真实命令、真实文件、真实环境回放的地方，优先由 runtime verifier 负责。

### 4. Handoff over memory

长时任务不依赖上下文永远保持新鲜。系统默认通过结构化交接包恢复现场，而不是靠长 prompt 和记忆延续。

### 5. Small core, optional heavy shell

核心内核保持小。只有在高不确定、高成本验证的任务里，才给 run 开更重的 harness profile。

## 核心架构

下一阶段的最小内核只保留五个稳定部件。

- `Run`
- `Loop`
- `Attempt Contract`
- `Verifier Stack`
- `Handoff Bundle`

其它组件都降级。

- `planner` 是生成合同草稿的辅助器，不是顶层真相
- `dashboard` 是观察层，不放调度逻辑
- `reviewer` 和 `synthesizer` 是 verifier stack 的可插拔层，不是核心原语
- `adapter` 是执行槽位的实现，不进入内核条件分支

可以把下一阶段的主链理解成这条流。

`run contract -> attempt contract draft -> preflight evaluator -> execution -> runtime verifier -> postflight evaluator -> handoff bundle -> next decision`

## 核心对象

### Run

保持当前定义。它继续保存任务契约、attempt 历史、证据、当前压缩视图和 steer。

### Attempt Contract

这是 execution 发车前必须存在的一等工件。它不是补充说明，而是执行规格。

最小字段包括下面这些。

- `objective`
- `success_criteria`
- `required_evidence`
- `forbidden_shortcuts`
- `expected_artifacts`
- `verification_plan`
- `done_rubric`
- `failure_modes`

现有 `AttemptContract` 继续保留，但要补 `done_rubric` 和 `failure_modes`，并把它前移成 dispatch gate。

### Preflight Evaluation

这是 execution 前的合同审查结果。

它至少回答四个问题。

- 这轮合同是否足够具体
- 验证命令是否真的可回放
- 证据要求是否能被检查
- 当前基线是否允许开始这一轮

如果 preflight 不通过，本轮 attempt 不创建 `running` 状态，系统直接给出失败分类和修订建议。

### Runtime Verification

保持当前 deterministic 硬门角色，但要继续扩成任务相关的能力套件。代码任务看 patch、git、tests。Web 任务看 Playwright 和接口回放。数据任务看查询与样本断言。

### Postflight Evaluation

这层在 deterministic verification 之后运行。它负责怀疑式判断，不是重复打分。

它回答的问题是。

- 这轮是否真的推进了 goal
- 失败属于哪一类
- 下一轮是重试、改合同、换方向还是等人
- 哪些证据已经够，哪些证据仍然缺

### Handoff Bundle

这是下一阶段最重要的新工件。它应该成为 auto-resume、人工恢复和 worker prompt 的统一入口。

最小字段建议如下。

- 当前 run 的来源锚点
- 上轮 attempt id
- 当前批准的 attempt contract
- baseline 指纹
- deterministic verification 结论
- postflight 失败分类
- 当前允许继续的最小上下文
- 下一轮目标
- 禁止重复动作
- 推荐使用的 harness profile

## 槽位与适配器

内核只认识槽位，不认识具体模型名字。

推荐保留下面这些槽位。

- `research_or_planning`
- `execution`
- `preflight_review`
- `postflight_review`
- `final_synthesis`

每个槽位都只定义四类东西。

- 输入包
- 工具权限
- 是否允许写工作区
- 标准输出工件

只要某个执行者能遵守该槽位协议，就可以接入。Codex、Claude Code、Pi 更适合 `execution`。Gemini、Claude 一类更适合 `preflight_review`、`postflight_review` 和 `final_synthesis`。这只是默认分工，不写死在内核里。

## Harness Profile

### Lite

适合确定性强、验证清晰的代码改动。只开最小 research、单 execution、deterministic verification。评审层尽量轻。

### Standard

默认主线。包含合同审查、execution、deterministic verification、postflight review 和 handoff bundle。

### Heavy

只给高成本验收任务启用。允许更重的 reviewer 组合、更强的真实环境验证和更严格的修复闭环。

## 当前系统需要收敛的点

### 1. 顶层叙事从 swarm control plane 收成 execution harness

保留 run-centered 思路，不再把多 agent 并发探索当成主卖点。

### 2. 当前真相收口

`current.json`、`review_packet.json`、runtime health snapshot、active next-task 这些文件继续存在，但下一阶段应由 `handoff bundle` 统一串联，不再各自承担恢复入口。

### 3. Dashboard 降级成观察层

dashboard 很重要，但不再驱动主架构。系统的成立条件是合同、验证和交接，不是大盘页。

### 4. Planner 降级成辅助器

planner 继续存在，但它的职责只剩下把高层任务压成可审的合同草稿，不再代表唯一真相。

## 验收标准

下一阶段完成后，AISA 至少应满足下面这些行为标准。

- 不合格的 execution contract 不能被派发
- 坏的 self-bootstrap 健康门会阻塞 `bootstrap:self`
- 任何一次 auto-resume 都能指出自己读取的是哪一份 handoff bundle
- `no_git_changes`、`worker stalled`、`verification failed`、`runtime source drift` 这类失败会被明确分类，不再混在一个模糊 summary 里
- dashboard 和报告不再需要拼多个来源才能解释当前为什么继续或为什么停下
- 不同槽位可以换执行者，但内核代码不新增供应商分支

## 明确不做的复杂化

为了保持架构优雅，下面这些做法默认不进入当前主线。

- 不新增第三个后台进程
- 不加消息队列和任务总线
- 不引入图式 agent orchestration DSL
- 不把每种模型写成单独流程
- 不为所有 run 默认打开 heavy harness

## 这版 PRD 对实现的直接要求

接下来所有实现文档和迭代计划，都要围绕这几个问题来写。

- 本轮合同是什么
- 谁来审合同
- 谁来执行
- 哪个 verifier 负责硬门
- 哪个工件是下一轮唯一交接入口

如果一个新设计不能清楚回答这五个问题，那它大概率只是在增加复杂度，而不是在让 AISA 更强。
