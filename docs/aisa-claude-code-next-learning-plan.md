# AISA 从 Claude Code 学习的专项实施计划

## 目的

这份文档回答的是一个更窄的问题。

如果把 Claude Code 里值得学的东西拆开看，这份文档只覆盖 postflight gate 和 operator surface 这一块，不再假装自己代表完整吸收路线。

完整优先级以 [AISA Harness Roadmap](./aisa-harness-roadmap-v1.md) 和 [AISA 吸收 Claude Code 的 Roadmap](./aisa-claude-code-absorption-roadmap.md) 为准。

这个专项的目标只有一个。让 AISA 继续保持 `run -> contract -> preflight -> execution -> deterministic verification -> handoff` 这条硬内核，同时把 Claude Code 在 postflight gate、operator 短状态和副循环纪律上已经被大量真实场景磨出来的经验吸进来。

这份计划默认服从当前 harness 主线，不把 AISA 拉回 transcript-first，也不把它做成新的通用 assistant 平台。

## 范围边界

这份专项只覆盖下面这些东西。

- adversarial verifier
- verifier gate policy
- typed verifier kit
- run brief
- 围绕 verifier 和 operator surface 的 maintenance outputs

下面这些方向已经确认也很值得学，但不在这份专项里展开。

- 长任务运行中的现场保持和 compact discipline
- plan mode、approval、permissions、hooks 这一层 policy runtime
- 更强的多 agent 组织层
- repo memory、`/init`、MagicDocs、team memory 这类环境建设层

## 先定结论

更长远的底座仍然是 AISA，不是 Claude Code。

原因不是 AISA 现在更成熟，而是 AISA 的真相更硬，结构更适合承接未来模型持续变强的红利。模型以后更强，最值钱的不是让系统更会聊天，而是让 planning、execution、verification、diagnosis、synthesis 这些高智能动作，稳定地沉淀到一条不会散掉的主链里。

在这个专项范围里，Claude Code 最值得吸收的不是产品外壳，也不是 transcript 组织方式，而是三样东西。

- 对抗式 verification
- 很短但很准的状态表达
- 很强但不抢主链真相的副循环纪律

所以正确方向不是把 AISA 做成另一个 Claude Code，而是让 AISA 的硬内核外面，长出 Claude Code 那种成熟的智能护栏。

## 这个专项要学什么

这个专项里，下一步值得整套吸收的东西有这些。

### 1. Adversarial verifier

不是 reviewer 式看起来差不多就行，而是 verifier 式专门挑刺，专门找第一眼没暴露的问题，专门防止 first 80 percent 的自我欺骗。

这层要学 Claude Code 的核心纪律。

- verifier 默认只读
- verifier 必须真跑命令
- verifier 必须给真实输出，不给抽象判断
- verifier 至少做一次破坏性探测或反例探测
- verifier 的任务不是证明改动看起来合理，而是尽量把它搞坏

### 2. Verifier 不是建议，是 gate

Claude Code 的 verifier 有系统地位，这一点必须学。

但 AISA 不能把它学成唯一完成门。AISA 当前已经有 deterministic runtime verification，这条硬门不能让位。正确做法是双层门。

- 第一层是 deterministic replay，负责可回放硬证据
- 第二层是 adversarial verifier，负责找 deterministic gate 没覆盖到的洞

### 3. Project-specific verifier kit

Claude Code 值得学的不是只有一个通用 verifier prompt，而是通用 verifier 上面还叠项目级 verifier skill。

AISA 里最适合落成 typed verifier kit。先从下面几类开始。

- repo task
- web app task
- CLI task
- API task

每类 kit 都定义最低必跑检查、常见对抗探测、允许追加的探索动作和最低证据标准。

### 4. 短状态通道

Claude Code 很会给操作者一句短而准的话。AISA 也要补这层。

`run_brief` 的职责不是做摘要文学，而是给控制面提供真正能接球的控制信号。它应该先回答当前为什么继续或为什么停，当前最重要的阻塞是什么，下一步推荐动作是什么，是否需要人工，以及应该先看哪份证据。

### 5. Maintenance plane

Claude Code 的副循环强，但主链很窄，这点非常值钱。

AISA 应该把以下能力正式拆成维护平面。

- runtime health
- blocked run diagnosis
- history drift scan
- verifier summary
- review packet compression
- run brief 更新

这些东西默认只产出工件和建议，不直接偷偷改写主链真相。

## 哪些地方不能原样照搬

下面这些东西不能直接抄，否则会把 AISA 的底座带偏。

### 1. 不能让 verifier 替代 deterministic gate

AISA 现在最值钱的，是 execution 发车前就锁定 `attempt contract` 和 replayable verification plan，执行后再用 deterministic runtime verification 真回放。Claude Code 的 verifier 可以压在这上面，但不能反过来替代这套链路。

### 2. 不能让 verifier 自己决定主验证命令

Claude Code 的 verifier 可以临场决定怎么验证，这在 assistant runtime 里成立，在 harness 里不够稳。

AISA 里真正决定主验证动作的，仍然应该是 dispatch 前冻结的 contract。verifier 可以追加 exploratory probe，但不能改写 mandatory replay commands。

### 3. 不能把 transcript 抬回真相中心

Claude Code 的很多机制天然围绕会话和 transcript 展开。AISA 不该往这个方向退。AISA 的恢复、续跑、operator 接手，都应该继续围绕结构化工件，而不是 prompt 链和上下文残留。

### 4. 不能照搬 built-in agent 的产品外壳

Claude Code 的 verifier 是 built-in subagent。AISA 该学的是 verifier slot、权限边界和输出协议，不是把同样的产品外观照着做。

### 5. 不能直接把 PASS FAIL PARTIAL 塞进当前 schema

AISA 现有验证链路和评审链路围绕 `passed`、`failed`、`not_applicable`。如果要引入 `PARTIAL`，必须作为一条新维度落到 verifier artifact，不要直接污染现有 deterministic verification 语义。

## 目标形态

下一阶段的理想形态可以压成一句话。

`硬内核不变，智能外层明显变强。`

主链继续保持克制。

`run contract -> attempt contract -> preflight -> execution -> deterministic runtime verification -> adversarial verifier -> postflight synthesis -> handoff bundle`

其中每层职责都要更清楚。

- preflight 负责 shadow dispatch，不让不该发车的 execution 上路
- deterministic runtime verification 负责真实回放和硬证据
- adversarial verifier 负责找硬证据没覆盖到的问题
- postflight synthesis 负责收束下一步，不负责发明真相
- handoff bundle 继续做唯一恢复锚点

## 实施顺序

### Phase 0 先把边界写死

先把不会改的约束写清楚，再做功能。

这一阶段只做一件事。明确 AISA 接下来吸收 Claude Code 的边界，形成团队共识，不让后续实现一边写一边漂。

要写清楚的点有这些。

- deterministic gate 继续保留为硬门
- adversarial verifier 是叠加层，不是替代层
- contract 继续冻结 mandatory replay commands
- handoff bundle 继续做唯一恢复入口
- provider 名字不写回主链

完成标准是，后续任何 verifier 实现都不能绕过这些约束。

### Phase 1 引入 postflight adversarial verifier slot

这一阶段开始补真正的新能力。

要做的事情有这些。

- 正式定义一个只读的 `postflight_verifier` 或 `adversarial_verifier` 槽位
- 固定它的输入包，至少包含 attempt contract、preflight、runtime verification、review packet、handoff refs
- 固定它的权限边界，不允许改项目文件，不允许装依赖，不允许 git 写操作
- 固定它的输出工件，至少包含 checks、commands、observed_output、verdict、missing_evidence、risk_summary

完成标准如下。

- non-trivial execution 可以真正进入 adversarial verification
- verifier 结果不是自然语言碎片，而是结构化工件
- verifier 不会破坏工作区真相

### Phase 2 把 verifier 变成正式 gate

这一阶段的核心不是再做一个 reviewer，而是立 gate policy。

建议规则如下。

- trivial research 不强制走 verifier
- non-trivial execution 不得跳过 verifier
- deterministic replay 没过，直接失败，不进入 verifier pass
- deterministic replay 过了但 verifier fail，不允许标记 complete
- verifier 结果缺失或损坏，不允许静默降级为成功

完成标准如下。

- 完成态必须同时经过 deterministic gate 和 adversarial gate
- dashboard 和 handoff 能明确展示 verifier 结果
- auto-resume 能理解 verifier 失败和 deterministic 失败不是同一种失败

### Phase 3 做 typed verifier kit

这一阶段把通用 verifier 提升到任务类型层面。

建议先做四类 kit。

- repo task kit
- web app kit
- CLI task kit
- API task kit

每个 kit 至少回答四个问题。

- 最低必跑检查是什么
- 最值得做的对抗探测是什么
- 哪些探测可以只读完成
- 哪些结果才算最低可信证据

完成标准如下。

- preflight 能感知当前 run 绑定了哪一类 verifier kit
- verifier 输出开始呈现任务类型差异，而不是永远一套空泛文案
- typed kit 真正影响 gate 强度，而不是只影响 prompt 描述

### Phase 4 补 run_brief 并让控制面先吃它

这一阶段重点不是再长一个后台 agent，而是让 operator 能更快接球。

`run_brief` 建议成为正式工件，默认来源于 handoff bundle、governance、preflight 和 verifier summary，不自己创造新真相。

它至少回答这些问题。

- 当前状态
- 最近一轮为什么继续或为什么停
- 当前最重要的阻塞
- 下一步推荐动作
- 是否需要人工
- 最该先看哪份证据

完成标准如下。

- control-api run detail 直接返回 run brief
- dashboard 首页和 run detail 优先展示 brief
- operator 不用自己在 `current`、journal、review packet 和 verification 之间来回拼读

### Phase 5 把副循环正式拆成 maintenance plane

这一阶段的重点是让副循环更强，同时让主链更窄。

适合先拆出去的能力有这些。

- verifier summary 更新
- blocked run diagnosis
- review packet compression
- runtime health refresh
- history drift scan
- run brief refresh

完成标准如下。

- maintenance plane 默认只产出工件和建议
- maintenance plane 不直接推进 `CurrentDecision`
- operator 能分清哪些信号来自主链，哪些来自维护平面

### Phase 6 建立 verifier calibration loop

这是最能持续吃到未来模型升级红利的一层。

每次 verifier 误报、漏报、抓住新坑，都不该停在一次性 prompt 调整。它们应该沉淀成新的 eval case。

这一阶段要做的事情有这些。

- 从线上失败样本回灌 verifier eval
- 把 review packet、runtime verification、handoff bundle 和最终人工判断串起来
- 建立 verifier prompt 和 verifier kit 的版本化更新流程
- 固定 false positive 和 false negative 回归位

完成标准如下。

- verifier 每次误判都能沉淀成新 case
- 新模型接入后可以直接复跑旧集，看 verifier 是否真的变强
- AISA 享受模型升级红利的方式，开始从换模型试试看，变成有历史回归的稳定升级

## 对应到 AISA 当前代码的直接修改方向

下一轮实现最值得优先落的，不是所有阶段一起开，而是先做最小闭环。

建议顺序是这样。

- 先补 verifier slot 和 verifier artifact
- 再补 verifier gate policy
- 再补一版最小 typed kit
- 然后补 run brief 和控制面读面
- 最后再拆 maintenance plane 和 calibration loop

这样做的好处是，AISA 会先获得最值钱的能力，也就是 execution 结束后不再只靠 deterministic replay 和 reviewer 打分，而会多一道真正会挑刺的门。同时主链不会因为一次性改太多而失控。

## Definition of Done

这份计划真正完成，不是加了一个 verifier prompt 就算数，而是至少满足下面这些条件。

- non-trivial execution 默认要经过 adversarial verifier
- verifier 默认只读，不能改项目现场
- verifier 输出是结构化工件，不是散落在日志里的自然语言
- dashboard 和 control-api 能直接展示 verifier 结果和 run brief
- handoff bundle 能引用 verifier artifact，恢复时不需要重新拼真相
- typed verifier kit 已经能对不同任务类型给出不同的检查策略
- verifier 的误判和漏判能沉淀进回归集

## 最后判断

Claude Code 值得学的地方，AISA 下一步确实应该更大胆地学，甚至很多原则可以接近整套照搬。

但照搬的对象必须是纪律，不是产品外壳。AISA 继续做硬内核，Claude Code 的强对抗 verifier、短状态表达和副循环纪律接到外层，这才是更长远、更优雅、也更能享受未来模型持续变强红利的形态。
