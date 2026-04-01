# AISA 吸收 Claude Code 的 Roadmap

## 目的

这份 roadmap 只回答一个问题。

AISA 如果要从 Claude Code 身上吸收最值得学的东西，应该按什么顺序吸收，吸收成什么样，哪些地方要坚决不学。

这不是新的总 roadmap，也不是要把 AISA 改造成另一个 assistant 平台。它是一份配套路线图，用来补充 [AISA Harness Roadmap](./aisa-harness-roadmap-v1.md) 和 [Claude Code 对 AISA Harness 的启发](./claude-code-lessons-for-aisa-harness.md)。

一句话说，这份文档只关心一件事。

`把 Claude Code 的系统习惯吸进 AISA，把 Claude Code 的平台体积挡在 AISA 外面。`

## 总判断

Claude Code 最值得学的，不是它支持多少模型、多少工具、多少会话，而是它那套长期把复杂系统压成少数稳定习惯的方式。

真正值得 AISA 学的是这些。

- 恢复入口尽量只有一个
- 长任务运行中也能稳稳保住现场
- 发车前先预演，不把晚失败当本事
- 操作者总能读到一句短而准的当前状态
- 旁路副循环很强，但不轻易改主链真相
- policy runtime 和 planning discipline 很硬
- provider 细节被关在适配层里

真正不该学的是这些。

- transcript-first 的真相组织方式
- 通用 assistant 平台式膨胀
- 边路任务直接偷偷改主链
- 让用户体验层压过恢复与验证层

所以这份 roadmap 的目标不是让 AISA 变得更像 Claude Code，而是让 AISA 在自己的 harness 方向上，吸收 Claude Code 已经证明有效的系统纪律。

## 先学什么，后学什么

学习顺序必须克制。

如果一开始就去学多执行者组合、花哨的 profile、复杂的工具接入，AISA 学到的会是 Claude Code 的表面，不是它真正稳定的骨架。

正确顺序应该反过来。

先学 handoff-first。再学长任务现场保持。再学 shadow dispatch。再学双层 gate 和短状态。再学强副循环。再学 policy runtime。最后才学槽位、typed verifier kit 和更强的多 agent 组织层。

这个顺序和主 roadmap 对齐，因为当前 AISA 最缺的也正是这些地方。

## Phase A

先学 handoff-first。

Claude Code 最值得学的第一件事，是中断之后不容易丢现场。它强的不是上下文无限长，而是系统能把现场压成可恢复的最小真相。

AISA 现在已经有 `handoff_bundle.json`，但它还没有真正坐上唯一恢复入口的位置。控制面和续跑路径仍然在混读 `current decision`、journal、runtime 状态和其它派生对象。

这一阶段的目标很单一。

让 AISA 的控制面、auto-resume、人工接手，都先读 handoff bundle，再决定要不要展开其它证据。

要做的事情如下。

- control-api 显式返回最新 handoff bundle 摘要和 ref
- dashboard 首页和 run 详情优先展示 handoff 摘要
- auto-resume 的状态更新、阻塞原因和恢复计划显式带出 handoff bundle ref
- worker 恢复 prompt 继续向 handoff bundle 收口
- `CurrentDecision` 在文档和实现里正式降级成热缓存视图

完成标准如下。

- operator 想知道上一轮发生了什么时，首先看到的是 handoff 摘要
- auto-resume 和人工恢复能指出自己读的是哪一份 handoff bundle
- 同一轮失败原因不再在 current、dashboard、prompt 和 report 里漂移

这一步学到的不是一个文件，而是一条纪律。

`恢复优先靠交接包，不靠会话记忆。`

## Phase B

再学长任务运行时的现场保持。

Claude Code 最近最值得 AISA 补课的，不是又一个 agent prompt，而是 compact 背后的工作现场重写纪律。它不是简单摘要，而是在长任务中尽量保住 plan、recent files、mode、tool delta 和关键上下文。

AISA 不该学 transcript 压缩，但该学 harness 自己的 working context preservation。

这一阶段要补的东西有这些。

- 运行中显式记录 plan ref、active evidence refs、最近关键阻塞和当前工作焦点
- 对超长单次运行引入受控压缩与恢复机制，优先保留结构化工件引用
- 明确区分运行中现场工件和 settled handoff 工件，避免两者职责打架
- compact 或现场保持失败时进入明确 degraded 状态，而不是静默丢上下文继续

完成标准如下。

- 单次运行被拉长后，系统仍能指出当前计划、当前证据和当前阻塞
- working context 丢失不会偷偷污染主链真相
- handoff bundle 继续保持唯一恢复锚点

这一步学到的习惯是。

`长任务不是靠上下文变长活下来，而是靠现场被稳稳保住。`

## Phase C

再学 shadow dispatch。

Claude Code 很强的一点，是很多动作会先在影子现场里过一遍，再决定要不要真正进入执行。

AISA 现在已经有 preflight，但它更像合同和工具链闸门，还没有变成真正的发车前预演。

这一阶段要把 preflight 从合同 lint 升成 shadow dispatch。

要补的东西有这些。

- replay 命令的真实可执行探测
- 当前 workspace、toolchain、baseline 是否满足最小发车条件
- 推荐 `next_attempt_contract` 的结构化合法性检查
- auto-resume 是否会直接撞回已知失败模式的预判
- verifier kit 是否覆盖当前任务最低要求的检查

完成标准如下。

- 一批今天要到 execution 结束后才暴露的问题，能在 dispatch 前失败
- preflight failure code 不再只描述缺字段，也开始描述真实现场不允许发车的原因
- operator 能直接看到 preflight 为什么拦住这轮发车

这一步学到的不是更重的流程，而是一个习惯。

`晚失败不是本事，早失败才是。`

## Phase D

再学双层 gate 和短状态通道。

Claude Code 值得学的不只是 verifier 会挑刺，而是它把完成语义和操作者状态都做成了系统能力。

AISA 现在最适合吸收的是下面这组组合，而不是单独把 verifier 做大。

- deterministic runtime verification 继续做硬门
- adversarial verifier 作为第二层只读 gate
- run brief 负责给 operator 一句短而准的当前状态
- failure class 在 control-api、dashboard、handoff 和 journal 里保持一致

完成标准如下。

- non-trivial execution 的完成态必须同时经过 deterministic gate 和 adversarial gate
- operator 打开 run 后，先读 brief 就知道要不要接球
- failure class 不再在不同工件里各说各话

这一步学到的是 Claude Code 的表达克制和 gate 纪律。

`状态消息不是摘要文学，而是控制信号。`

## Phase E

再学强副循环，但不让它改主链真相。

Claude Code 很值得学的一点，是它真正决定真相的主链很窄。很多能力都在旁边独立运行，比如状态整理、文档维护、预判、摘要、恢复辅助。

AISA 也该这样学，但现在还差最后一步。因为 governance、run health、自举健康、contract drift 扫描这些东西已经长出来了，却还没有正式被承认为 maintenance plane。

这一阶段的目标是把旁路能力做强，同时把边界做硬。

适合进入 maintenance plane 的东西有这些。

- runtime health 刷新
- blocked run 诊断
- history contract drift 扫描
- review packet 压缩和摘要
- verifier summary 更新
- run brief 更新

完成标准如下。

- maintenance plane 默认只产出工件和建议
- 它不直接偷偷推进 `CurrentDecision`
- orchestrator 主链重新收回到合同、派发、验证、评审、交接

这一步学到的是 Claude Code 最容易被学歪的一点。

`副循环可以强，但不能替主循环决定真相。`

## Phase F

再学 policy runtime 和 planning discipline。

这部分是这轮新发现里非常值得补上的东西。Claude Code 的 permissions、hooks、plan mode、approval、killswitch，本质上不是交互小功能，而是一层治理运行时。

AISA 如果以后真要承接极强的多 agent 组织层，没有这层，后面的 slot registry 和 team coordination 会偏空。

这一阶段要做的事情如下。

- 把 planning、approval、execution 三种状态边界写清楚
- 建立 non-trivial 计划的 approval 语义
- 为多 agent 场景补 leader approval 和 structured mailbox 风格的流转协议
- 统一 permissions、hooks、dangerous rule stripping 和 killswitch 的治理语义

完成标准如下。

- 系统能明确表达当前 run 处于 planning、approval 还是 execution
- 危险自动化规则不能通过配置静默绕过治理层
- 多 agent 计划流转开始具备清楚的责任边界

这一步学到的是 Claude Code 的系统治理感。

`强组织层不是先多 agent，而是先有纪律。`

## Phase G

最后才学槽位、typed verifier kit 和更强的适配层。

这部分当然重要，但它必须排在后面。否则 AISA 会过早把精力花在多执行者排列组合上，学到 provider 编排平台的体积，而不是 harness 的骨架。

这一阶段该学的是 Claude Code 的边界抽象，不是它的产品外观。

要做的事情如下。

- 正式引入 slot registry
- 明确 `research_or_planning`、`execution`、`preflight_review`、`postflight_review`、`final_synthesis` 五类槽位
- 每个槽位只定义输入包、写权限、标准工件和失败语义
- `harness_profile` 从 effort 配置升级成 policy bundle
- repo task、web app task、CLI task、API task 四类 typed verifier kit
- 更强的多 agent 组织层围绕 plan、approval、handoff 和 structured mailbox 运转

完成标准如下。

- 内核流程不再认识 provider 名字
- 不同执行者可以按槽位替换，但 orchestrator 不新增品牌分支
- profile 真正影响验证强度、review 组合和恢复策略，而不是只影响 effort
- 多 agent 组织层围绕结构化工件运转，而不是围绕松散会话状态运转

这一步学到的是 Claude Code 的抽象方式。

`内核认识能力边界，不认识品牌名字。`

## 近程不学什么

为了避免 AISA 走偏，这里把这轮明确不该提前学进主链的东西写死。

不学 transcript-first。Claude Code 很多结构天然围绕 session 和 transcript 展开，这对 assistant runtime 合理，对 harness 内核不合适。

不学平台体积。Claude Code 后面可以长很多产品能力，但 AISA 现在不能把这些能力一起学进来，否则恢复真相会再次分散。

不学边路篡权。health、brief、summary、review 压缩这些旁路任务，都不能直接替主链推进状态。

不学 provider 先行。只要 provider 名字重新出现在 orchestrator 的流程分支里，说明学错了。

不把 repo memory、`/init`、MagicDocs、team memory sync 提前抬进近程主链。这些更像环境建设层和团队协作层，后面可以学，但不该压过恢复、发车、gate 和治理层。

## 建议的实施顺序

真正建议的落地顺序只有一条。

先做 handoff-first。再补长任务现场保持。接着做 shadow dispatch。然后把双层 gate、failure policy 和 run brief 收成一套。之后拆 maintenance plane。再补 policy runtime 和 planning discipline。最后才做正式 slot registry、typed verifier kit 和更强的多 agent 组织层。

这个顺序故意把 slot 放后面，把恢复、控制面和治理层放前面。原因很简单。

Claude Code 最强的地方，从来不是它能接多少模型，而是它能在复杂情况下仍然保持可恢复、可解释、可继续。

## 最终判断

这份吸收路线的核心，不是让 AISA 更像 Claude Code，而是让 AISA 更像一个真正成熟的 harness。

Claude Code 给 AISA 的真正启发只有一句话。

`先把系统习惯学会，再考虑把能力菜单做大。`

只要 handoff-first、运行中现场保持、shadow dispatch、双层 gate、短状态通道、强副循环但不改真相、policy runtime 和 provider 细节关进适配层 这几件事吸收进去，AISA 就会更稳、更长跑、更适合做超长任务的多 agent 底座。
