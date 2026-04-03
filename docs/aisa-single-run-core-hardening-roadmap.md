# AISA Single-Run Core Hardening Roadmap

## 目的

这份 roadmap 只服务一件事。

把 AISA 在不引入更强多 agent 组织层的前提下，继续压成一个更稳、更长跑、更适合未来扩展的单 run execution harness。

它不是新的总 roadmap，也不是对多 agent 计划的替代。它是主 roadmap 的一条近程实施线，专门覆盖那些先做了只会让底座更硬、以后做多 agent 也不用大改的工作。

一句话说，这条线只做单 run 底座硬化，不做 team orchestration。

## 名字

这条线的正式名字是。

`AISA Single-Run Core Hardening`

中文可以直接叫。

`AISA 单 run 底座硬化线`

## 为什么现在单独拉一条线

当前 AISA 的主骨架已经站住了。

- run 主链已经完整
- execution contract、preflight、runtime verification、adversarial verification 已经是主链能力
- handoff-first、working context、policy runtime、self-bootstrap 都已经落地
- `harness_profile` 已经升级成 version 3，并开始正式表达 gate bundle

现在如果直接往更强的多 agent mailbox、leader approval、team coordination 上冲，风险不是功能做不出来，而是会把还没压稳的单 run 真相层和现场层重新搅乱。

所以接下来最合理的顺序，不是继续扩组织层，而是先把单 run 底座继续压硬，让未来多 agent 建在稳定地基上，而不是反过来逼底座返工。

## 和多 agent 计划的边界

这条线必须写死边界，避免以后撞车。

这条线不做这些事。

- 不引入 structured mailbox
- 不引入 leader approval
- 不引入 team memory sync
- 不让一个 run 同时出现更复杂的多 worker 协调协议
- 不把 orchestrator 主链改成 transcript-first 或 session-first

这条线只做这些事。

- 继续收紧单 run 的真相层
- 继续压硬 active context
- 继续让 `harness_profile` 的 policy 语义更完整
- 继续把 execution adapter 从品牌细节里解耦
- 继续校准 verifier、failure policy 和 maintenance plane
- 继续把 self-bootstrap 变成更稳的长跑单 run harness

## 不撞车的设计约束

后面做多 agent 时，最怕的是今天做出来的东西逼着未来大拆。为了避免这个问题，这条线必须遵守几条约束。

第一，run 主链不改形状。

后续所有增强都继续围绕 `run -> attempt -> contract -> verification -> evaluation -> handoff` 这条链展开，不新增并行真相层。

第二，`harness_profile` 只做加法，不做重命名式重写。

这条线允许继续往 profile 里补 gate、恢复策略、维护策略、review 组合，但不能把已经存在的 execution / reviewer / synthesizer / gates / slots 结构推倒重来。

第三，working context 继续只服务 active run。

它不升级成长期记忆，不升级成 team mailbox，不和 handoff bundle 抢恢复锚点。

第四，execution adapter 的抽象要围绕能力，不围绕品牌。

这会直接帮未来多 agent，因为以后无论是单执行者还是多执行者，内核看到的都还是同一组 capability boundary。

第五，maintenance plane 继续只产出工件和建议。

它不能偷偷推进主链真相。这样以后多 agent 的副循环接进来，也不会先把真相层打乱。

## Phase S1

先做 active context hardening。

现在 working context 已经有了，但还不够像真正的长任务现场包。它能告诉系统当前焦点和阻塞，但现场压缩、恢复、再续跑这几步还不够硬。

这一阶段要补的重点如下。

- 明确把 plan ref、active task refs、recent evidence refs、current blocker、next focus 收成更稳定的结构
- compact 或现场重写失败时，明确进入 degraded，而不是悄悄回退到日志拼装
- active run 恢复时，先读 working context，再按需展开其它证据
- control-api 和 dashboard 更明确地展示当前 active context 的版本、来源和 degraded 状态

完成标准是。

- 单次任务被拉长后，系统还能稳定指出现在在做什么、为什么卡住、下一步该接什么
- working context 出问题时，系统会明确暴露，而不是假装现场没丢
- handoff bundle 继续保持 settled 恢复唯一锚点

## Phase S2

做 profile bundle 2.0。

现在 `harness_profile` 已经正式有了 gate bundle，但还只是第一版。下一步不是继续加更多字段，而是把已有字段变成更完整的运行时语义。

这一阶段要补的是。

- 让 profile 不只影响 postflight adversarial gate，也开始明确影响恢复策略和维护节奏
- 把不同 profile 下的 verification discipline、operator brief 强度、maintenance refresh 策略写清楚
- 继续保持 preflight 和 deterministic runtime 的硬门语义，不为了 profile 漂亮去做软化
- 让 control-api 和 dashboard 直接展示 profile 生效后的 effective policy，而不是只展示原始输入

完成标准是。

- profile 不再只是配置集合，而是真正可读、可执行、可验证的 run policy bundle
- operator 能看懂这条 run 当前到底遵守什么执行纪律
- 以后多 agent 接入时，可以直接复用 profile 语义，不需要重新发明一套 team policy 对象

## Phase S3

做 execution adapter neutrality。

现在 execution 这一段虽然已经有 slot 和 verifier kit，但真正干活的链路还偏 Codex CLI。下一步要继续把 execution 从具体品牌细节里拆开。

这一阶段要做的是。

- 把 orchestrator 里残留的 execution transport 假设继续外推
- 让 execution adapter 的输入、输出、失败语义进一步标准化
- 让 execution slot 真正只认 contract、workspace scope、verification refs 和 writeback
- 确保 control-api、dashboard、self-bootstrap 都不需要知道执行者品牌

完成标准是。

- 单 run execution 这条链已经 provider-neutral 到足以让后续多 agent 直接复用
- 内核流程不再因为某个执行者实现细节而长条件分支
- 即使暂时仍主要跑 Codex CLI，代码结构也已经不是 Codex-specific

## Phase S4

做 verifier 和 maintenance plane calibration。

现在 verifier、run brief、blocked diagnosis、failure class 已经有了，但它们还需要更系统的校准，避免长期运行后逐渐漂。

这一阶段要补的是。

- 建立更明确的坏例库和长期回放集
- 继续收紧 failure class 在 preflight、runtime、adversarial、handoff、brief 之间的一致性
- 让 maintenance plane 的 blocked diagnosis、run brief、history drift 扫描形成稳定回归
- 对 verifier kit 的不同任务类型持续补坏路径和边界路径验证

完成标准是。

- 系统不是只有功能通，而是判断越来越准
- operator 打开 run 详情时，brief、failure signal、verification 结论不会互相打架
- 后面多 agent 接进来时，判断层还能保持稳定，不会因为执行者变多就变糊

## Phase S5

做 self-bootstrap long-run hardening。

现在 self-bootstrap 已经能持续给自己选下一步任务，但它还更像能跑，而不是已经非常抗折腾。

这一阶段要补的是。

- 更稳的 stuck 识别和暂停边界
- 更明确的 active next task 发布和消费纪律
- 更稳的 runtime verify 链，避免长链条里的子回归因为进程或环境问题失真
- 更清楚的 overnight 续跑和故障后恢复策略

完成标准是。

- self-bootstrap 可以稳定夜跑，不会因为现场漂移或回归链异常轻易失真
- active next task、working context、handoff bundle 三者职责边界继续清楚
- 这条线跑稳之后，再接多 agent 组织层不会先把自举链打碎

## 顺序

真正建议的顺序只有一条。

先做 S1，再做 S2，再做 S3，然后做 S4，最后做 S5。

原因很简单。先把 active context 和 profile 语义压稳，再继续抽 execution adapter，随后校准判断层，最后再把 self-bootstrap 长跑硬化。这个顺序会让每一步都直接给未来多 agent 铺路，但不会提前引入 team complexity。

## Definition of Done

这条线完成时，AISA 应该处在这样一个状态。

- 不考虑多 agent，单 run 已经足够长跑、足够稳、足够可恢复
- `harness_profile` 已经是完整可执行的单 run policy bundle
- active context、handoff bundle、maintenance plane 三者职责清楚
- execution adapter 已经足够中立，未来接 team layer 不需要大改内核
- self-bootstrap 已经能长期稳定运行

到那时，再进入多 agent 组织层才是顺势而为，而不是返工。
