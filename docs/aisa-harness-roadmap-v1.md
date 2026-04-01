# AISA Harness Roadmap

## 目标

这份 roadmap 只服务一件事。把 AISA 从当前已经能跑的 run-centered runtime，推进成一个更小、更硬、更容易维护的 execution harness。

路线不会重新起炉灶。我们保留已经有效的 run 主链、managed worktree、runtime verification、preflight、handoff bundle 和 self-bootstrap 资产，只把真正还没收口的地方按顺序补硬。

## 当前真实进度

先把当前代码里已经落地的部分说清楚，避免 roadmap 继续把已完成事项写成未来目标。

当前已经落地的东西有这些。

- `run -> attempt -> evaluation -> next attempt` 主链能跑
- execution 已经隔离到 managed worktree
- deterministic runtime verification 已经是硬门
- self-bootstrap 能生成 active next task，并能在 supervisor 里持续续跑
- `AttemptContract` 已经带 `done_rubric` 和 `failure_modes`
- execution dispatch 前已经强制跑 preflight evaluation
- settled attempt 已经会落 `handoff_bundle.json`
- `harness_profile` 已经存在，并且 execution / reviewer / synthesizer effort 已经有一层轻量配置

当前真正还没站稳的地方也很明确。

- control-api 和 dashboard 还没有把 preflight / handoff bundle 当成控制面的第一来源
- 恢复和续跑虽然已经读 handoff bundle，但仍然会混读 `current decision`、journal、日志摘录和其它派生状态
- 系统还没有显式解决超长单次运行里的现场保持和上下文续命
- preflight 现在更像合同与工具链闸门，还不是接近真实发车的 shadow dispatch
- deterministic gate、对抗式 gate、failure policy 和 operator brief 还没有收成一套清楚语义
- 维护类动作还没有独立平面，仍然主要挤在 orchestrator 主循环附近
- permissions、hooks、plan approval 这类治理层能力还没有被正式定义成 policy runtime
- execution 适配层目前仍然基本固定在 Codex CLI，只有 reviewer / synthesizer 更接近 provider-neutral
- slot registry 还没有正式成立，当前 `harness_profile` 也还不是完整槽位系统

## 路线调整原则

后续阶段按四个原则推进。

- 先收真相，再加能力
- 先让控制面读对，再让执行层变重
- 先把恢复入口变成一个，再去做更多 profile、更多 verifier kit、更多执行者组合
- 先把运行时纪律立住，再去做更强的多 agent 组织层

这意味着 roadmap 的重点要从新增某个对象，改成谁在真正消费那份工件，谁还能绕开它，以及长任务拉长以后系统还能不能稳稳保住现场。

## Phase 0

把 roadmap 和当前实现重新对齐，不再把已经落地的 preflight、handoff bundle、harness profile 写成未来事项。

这一阶段不引入新机制，只做现实校准。

- 把已落地能力从未来阶段移到当前进度说明
- 把后续阶段改成围绕真相收口、运行时纪律、控制面收口和恢复入口收口来排顺序
- 保留 self-bootstrap、managed worktree 和 runtime verification 作为既有底座，不再重复立项

完成标准很直接。

- roadmap 能准确反映今天代码里已经存在的能力
- 后续阶段的标题和任务不再与当前实现冲突

## Phase 1

先把控制面读模型收口，让 dashboard 和 control-api 不再主要依赖多源拼装来解释 run 状态。

这一阶段要做的事情有这些。

- run detail 显式返回 preflight evaluation
- run detail 显式返回最新 handoff bundle 或 handoff 摘要
- dashboard 首页和 run 详情优先展示 handoff / preflight 摘要，而不是只展示 `current decision` 和派生信号
- auto-resume、dashboard、report 读到的 handoff bundle ref 要能被清楚展示
- `CurrentDecision` 在文档和实现里正式降级为运行中缓存视图，而不是长期恢复锚点

完成标准如下。

- operator 在 dashboard 里能直接看到当前 run 最近一次 preflight 和 handoff 结论
- run detail 不需要靠多个 attempt 工件拼读，才能解释为什么继续或为什么停住
- 至少一条 run detail / control-api 回归能证明 handoff summary 已经成为首屏信息

## Phase 2

把恢复和续跑真正收成 handoff-first，而不是 handoff-exists-but-not-authoritative。

这一阶段的目标很单一。任何恢复动作都先读 handoff bundle，再决定是否降级去读其它证据。

要落地的东西有这些。

- auto-resume 的下一步计划优先由 handoff bundle 提供
- worker 恢复 prompt 优先由 handoff bundle 提供
- dashboard 和 control-api 显式标出当前恢复依据的是哪一份 handoff bundle
- 没有 handoff bundle 时，系统进入明确的 degraded / rebuild path，而不是静默回退到多源拼装
- failure reason、recommended next action、recommended attempt type 尽量先从 handoff bundle 取值
- handoff bundle 继续补 preflight ref / verdict，避免恢复时再回头翻 attempt 工件目录

完成标准如下。

- 恢复现场时可以先只读 handoff bundle 就理解上一轮发生了什么
- `no_git_changes` 一类阻塞不再需要靠 journal 文案和日志摘录拼起来才能成立
- 至少一条自动续跑回归能证明系统记录并展示了实际读取的 handoff bundle ref

## Phase 3

补一层运行中现场保持，让超长单次任务在不抬高 transcript 地位的前提下，仍然能稳住工作现场。

这一阶段不是做 assistant 式摘要，而是做 harness 自己的 working context preservation。它服务运行中的长任务，不替代 handoff bundle，也不变成新的长期恢复锚点。

建议补上的能力有这些。

- 显式记录当前 plan ref、active task refs、recent evidence refs、最近关键阻塞和下一步工作焦点
- 对长任务引入受控压缩与恢复机制，优先保留结构化工件引用，而不是自由文本上下文
- 明确区分运行中现场工件和 settled handoff 工件，避免两者职责混淆
- compact 或现场重写失败时 fail-closed 到清楚的 degraded 状态，而不是静默丢现场继续
- control-api 和 dashboard 能指出当前 run 使用的是哪一份运行中现场快照或工作上下文摘要

完成标准如下。

- 单次运行被拉长后，系统仍能指出当前计划、当前证据和当前阻塞
- compact 或现场保持失败不会偷偷污染主链真相
- handoff bundle 继续保持唯一恢复锚点，运行中现场工件只服务 active run

## Phase 4

把 preflight 从合同闸门升级成 shadow dispatch。

现在的 preflight 已经有价值，但还不够像真实发车前的现场预演。下一阶段要把它做成更接近真实执行环境的发车模拟。

建议补上的能力有这些。

- verification commands 的真实可执行探测
- 当前 workspace / toolchain / baseline 的最小前置条件检查
- 推荐 `next_attempt_contract` 的结构化合法性检查
- auto-resume 是否会直接撞回已知失败模式的前置判断
- verifier kit 就绪度检查，而不只是合同字段存在性检查

完成标准如下。

- 一批今天要到 execution 结束后才暴露的问题，能在 dispatch 前失败
- preflight failure code 开始覆盖现场问题，而不只覆盖合同缺字段
- `verify:run-loop` 和 `verify:runtime` 能覆盖至少一条 shadow dispatch fail-closed 场景

## Phase 5

把 gate 语义、failure policy 和 operator 读面一起收紧。

这一阶段不追求更多自动化，先追求系统说话一致，完成态更可信，operator 接球更快。

建议同时完成四件事。

- 在 deterministic runtime verification 之外，引入只读的 postflight adversarial verifier 作为第二层 gate
- 正式固化 fail-open / fail-closed 策略表
- 统一 preflight、runtime verification、verifier、handoff、journal 和 dashboard 使用的 failure class
- 新增一个极短的 `run_brief` 或 `operator_brief` 工件

这个 brief 只回答最重要的问题。

- 当前状态
- 最近一轮为什么停或为什么继续
- 当前最重要的阻塞
- 下一步推荐动作
- 是否需要人工
- 应该优先读哪份证据

完成标准如下。

- non-trivial execution 的完成态必须同时经过 deterministic gate 和 adversarial gate
- preflight、runtime verification、handoff、journal、dashboard 对同一轮失败给出同一 failure class
- operator 打开 run 详情后，先看 brief 就能知道要不要接球
- brief 失败可以降级，但 contract / preflight / runtime verification / handoff 失败必须 fail-closed

## Phase 6

把长期维护动作从 orchestrator 主循环旁边拆出来，形成 maintenance plane。

这阶段的重点不是做更多功能，而是保护主链，让旁路副循环变强但不抢真相控制权。

维护平面最先适合承接这些工作。

- runtime health 刷新
- blocked run 诊断
- contract drift 扫描
- review packet 压缩和摘要
- verifier summary 更新
- run brief 更新

完成标准如下。

- 维护任务默认只产出工件和建议，不直接推进 `CurrentDecision`
- orchestrator 主循环职责重新收回到合同、派发、验证、评审、交接
- operator 可以看见哪些信号来自主链，哪些来自维护平面

## Phase 7

补出明确的 policy runtime 和 planning discipline，让后续更强的 agent 组织层有治理底座。

这一阶段不追求更多执行者组合，先把哪些动作可以自动做、哪些必须审批、哪些规则会被熔断说清楚。

建议补上的能力有这些。

- plan mode 和 execution mode 的明确边界
- non-trivial 计划的 approval 语义，以及多 agent 场景下的 leader approval 流程
- tool permissions、hooks、dangerous rule stripping 和 killswitch 的统一策略
- 对危险自动化规则的 fail-closed 语义，而不是让配置静默绕过治理层
- hooks 和 policy decision 的结构化事件面，为控制面和维护平面提供明确证据

完成标准如下。

- 系统能清楚表达当前 run 处于 planning、approval 还是 execution 阶段
- 危险权限规则不会通过配置绕开治理层
- 多 agent 计划流转开始具备清楚的审批和责任边界

## Phase 8

等真相面、恢复面和治理面都站稳，再做正式的槽位体系、typed verifier kit 和更强的多 agent 组织层。

这一阶段只做架构降噪，不把 provider 细节重新写回内核。

要做的事情是。

- 正式引入 slot registry
- 明确 `research_or_planning`、`execution`、`preflight_review`、`postflight_review`、`final_synthesis` 五类槽位
- 每个槽位定义统一输入、权限边界和输出工件
- 让 `harness_profile` 从 effort 配置演进成 policy bundle 和槽位绑定配置
- repo task、web app task、CLI task、API task 四类 verifier kit 正式成型
- 多 agent 组织层围绕 plan、approval、handoff 和 structured mailbox 建立起来，而不是回到 transcript-first

完成标准如下。

- 同一条 run 可以把 execution 交给 Codex，把 review 交给 Claude 或 Gemini，而内核代码不增加按品牌分叉的流程判断
- verifier kit 选择开始真正影响 preflight、runtime verification 和 postflight 读面
- `harness_profile` 不再只是 effort 容器，而是清楚表达槽位、gate 强度和 kit 的组合
- 多 agent 组织层围绕结构化工件运转，而不是围绕松散会话状态运转

## Phase 9

把 evaluator calibration 正式变成维护主线。

这阶段不是继续堆产品表面能力，而是让 verifier、failure policy 和 kit 越跑越准。

需要建立的东西有这些。

- 线上误判样本回灌流程
- 从 review packet、runtime verification 和 handoff bundle 提炼 failure mode 的流程
- reviewer prompt、verifier prompt 和 eval 数据集的版本化更新流程
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
- 为所有 run 默认打开 heavy harness
- 把 repo memory、自动文档维护和团队共享记忆提前抬进近程主链

## 下一步实施顺序

真正的落地顺序现在只看五轮。

先做 Phase 1 到 Phase 3，把控制面、恢复面和长任务现场保持都收紧。再做 Phase 4 和 Phase 5，把 shadow dispatch、双层 gate、failure policy 和 operator brief 立起来。接着拆 maintenance plane。然后补 policy runtime 和 planning discipline。最后才做正式 slot registry、typed verifier kit 和更强的多 agent 组织层。

这个顺序的好处是，不会把 AISA 带回功能越来越多，但真相越来越散的旧轨道，也不会过早把注意力带到 provider 排列组合和产品表面。

## 最终判断

这份 roadmap 的核心不是再给 AISA 增更多模块，而是让已经出现的关键工件真正坐上主链，再把长任务纪律和治理层补齐。

现在最重要的不是再发明一个新对象，而是让 handoff bundle、运行中现场保持、preflight、双层 gate、run brief 和 failure policy 形成清楚的真相层级。

只要控制面先读对，恢复入口先收成一个，长任务现场能稳住，治理层边界先立住，AISA 后面无论接谁来执行、加多少 profile、加多少 verifier kit，都还能保持优雅和可维护。
