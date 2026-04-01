# Claude Code 对 AISA Harness 的启发

## 目的

这份文档记录一次有边界的对照思考。

不是讨论 Claude Code 有多少功能，也不是讨论要不要把 AISA 做成另一个通用 assistant 平台。真正要回答的问题只有两个。

- Claude Code 身上哪些系统习惯值得 AISA 吸收
- AISA 下一步应该把哪些想法改成更明确的实现方向

这份文档服务当前的 harness 主线，默认以 [AISA Harness PRD](./aisa-harness-prd-v1.md) 和 [AISA Harness Roadmap](./aisa-harness-roadmap-v1.md) 为准。

## 总判断

如果目标是做极强的、超长任务、自迭代、自进化的多 agent 组织层，AISA 仍然更适合做底座。

原因不是 AISA 现在比 Claude Code 更成熟，而是两者的重心不同。

- AISA 的重心已经围绕 `run`、`attempt contract`、`preflight`、`runtime verification`、`handoff bundle` 这些一等真相展开
- Claude Code 的重心仍然是一个极强的 assistant runtime，它非常擅长执行、工具调用、会话维护和边路副循环，但不天然以 `run contract -> handoff` 为唯一真相

所以正确姿势不是把 Claude Code 当底座重写 AISA，而是把 Claude Code 当成一套成熟 runtime 的灵感来源和执行层参考。

一句话总结就是：

`AISA 负责脑和账本，Claude Code 提供手感、护栏和副循环灵感。`

## 非常值得吸收的东西

### 1. 小内核 + 副循环

Claude Code 最值得学的不是功能数量，而是结构习惯。

它真正决定真相的主链很窄。其它能力像记忆整理、文档维护、状态摘要、推测预演，都会降到旁边单独运行，不抢主链控制权。

对 AISA 的启发是：

- `run` 主链只负责合同、派发、验证、评审、交接
- 其它长期维护动作应降成旁路副循环
- 副循环可以补证据、补状态、补摘要，但默认不能直接改写主链真相

适合 AISA 变成副循环的东西包括：

- runtime health 刷新
- stalled run 诊断
- 历史 contract drift 扫描
- review packet 压缩和摘要
- blocked run 的 operator brief 生成

### 2. 先预演，再落真相

Claude Code 的一个强点，是很多动作会先在影子现场里试一遍，再决定要不要落到真实现场。

对 AISA 来说，最适合吸收的不是提前改代码，而是把 `preflight` 从格式闸门升级成现场闸门。

可以先在轻量 shadow 环境里回答这些问题：

- 这轮合同里的 replay 命令是不是当前现场真的能跑
- 推荐的 `next_attempt_contract` 有没有缺关键字段
- 当前 `auto-resume` 会不会继续撞回已知失败
- 当前 verifier kit 在这轮任务上有没有明显缺口

这样做的价值是，让很多今天需要跑完才暴露的问题，提前在发车前失败。

### 3. 一条很短的状态通道

Claude Code 很重视一句足够短、但足够准的状态消息。

AISA 现在已经有：

- `current decision`
- `review packet`
- `runtime verification`
- `report`
- `journal`

但 operator 仍然缺一个最短路径去理解当前为什么继续、为什么停住、是否该接球。

值得吸收的是一层很克制的 `run brief`，比如：

- preflight blocked because verification plan missing
- runtime source drift detected, restart required
- deterministic gate passed, reviewers disagree, waiting human steer
- no git changes, auto-resume blocked

这不是替代 report，而是给控制面补一个真正能盯盘的状态面。

### 4. 能力槽位优先于 provider 名字

Claude Code 里很多成熟设计的共同点，是能力挂在边界上，而不是把品牌写死进主循环。

AISA 的 slot registry 方向是对的，而且应该更坚决。

内核真正应该认识的是：

- `execution`
- `preflight_review`
- `postflight_review`
- `final_synthesis`
- `research_or_planning`

每个槽位只定义：

- 输入包
- 权限边界
- 是否允许写工作区
- 标准输出工件
- 失败语义

执行者是谁，是适配层问题，不进入 orchestrator 的流程分支。

### 5. 失败必须分等级

Claude Code 的另一个启发，是不是所有错误都值得同样处理。

对 AISA 来说，最该吸收的是按“是否污染真相”来分失败等级。

应该 fail-closed 的场景：

- `attempt contract` 不达标
- `preflight evaluation` 无法形成可信结论
- `handoff bundle` 不完整
- deterministic runtime verification 失败
- final synthesizer 失败且无法形成可信最终评审

可以 fail-open 或 soft-degrade 的场景：

- brief 生成失败
- 背景健康扫描失败
- 观察层摘要失败
- 非关键 reviewer 附加意见失败，但 deterministic gate 仍完整

这会直接决定 orchestrator 是“谨慎地停”，还是“稀里糊涂地继续”。

### 6. 恢复入口必须只有一个

Claude Code 给出的最重要提醒之一，是恢复真相一旦分散，就会越来越依赖内存、会话和人为解释。

AISA 的 roadmap 已经把 `handoff bundle` 放成关键目标，这个方向应该更偏执一点。

真正理想状态应该是：

- auto-resume 只读 `handoff_bundle.json`
- worker 恢复 prompt 只读 `handoff_bundle.json`
- dashboard 解释 run 当前状态时优先展示 handoff bundle 摘要
- operator 接手时，首先看到的也是 handoff bundle 的结构化视图

只要还有多个来源同时在解释同一轮到底发生了什么，真相就还没收拢。

## AISA 应该直接修改的地方

### 1. 把 handoff bundle 提升成唯一恢复锚点

当前代码里 `handoff_bundle` 已经存在，也有回归在断言它必须落盘。

但 control-api 和 dashboard 仍然主要靠多源拼装 detail，说明 handoff 还没有真正坐上“唯一恢复入口”的位置。

下一步应该改成：

- run detail 先读 handoff bundle，再补充 attempt 展开细节
- dashboard 首页和 run 详情都优先展示 handoff 摘要
- auto-resume 的可恢复判断显式带出“读取了哪一份 handoff bundle”
- `CurrentDecision` 更像运行中的压缩缓存，不再承担长期恢复真相

### 2. 把 preflight 从 schema 检查升级成 shadow dispatch

当前 `AttemptPreflightEvaluation` 已经能挡住一部分不合格合同。

下一步建议把它升级为一个更像发车模拟的流程，至少包含：

- 合同字段完整性检查
- verifier 命令可执行性探测
- 当前 workspace / toolchain / baseline 是否满足最小前置条件
- 推荐 next contract 的结构化解析和合法性检查

理想结果是：

- 不合格合同在 dispatch 前就失败
- 不可重放的 verification plan 在 dispatch 前就失败
- 当前现场不允许发车时，preflight 给出明确 failure class，而不是留给 execution 再爆

### 3. 增加 `run_brief` 工件和 operator 视图

建议新增一个很小的结构化工件，比如 `run_brief.json` 或 `operator_brief.json`。

它只回答最重要的控制问题：

- 当前状态
- 最近一轮为什么停或为什么继续
- 当前最重要的阻塞
- 下一步推荐动作
- 是否需要人工
- 推荐读哪份证据

控制面应该优先消费这份 brief，再决定是否展开完整 detail。

### 4. 把长期维护动作拆成 maintenance plane

建议显式引入一层维护平面，而不是继续把所有逻辑都塞进 orchestrator 主循环。

维护平面的任务类型可以包括：

- 运行时健康检查
- blocked run 诊断
- 旧 contract 漂移回放
- review packet 归档与摘要
- run brief 更新

这些任务默认只产出工件和建议，不直接写 `CurrentDecision`。

### 5. 正式固化 fail-open / fail-closed 策略表

建议新增一份明确的策略表，直接按工件和环节定义故障处理方式。

最小就够：

- contract/preflight/runtime verification/handoff/synthesis 属于哪一类
- 出错时是否允许继续
- 出错时要写哪个 failure class
- operator 应该从哪个工件理解现场

这会显著降低后续 orchestrator 继续长大时的语义漂移。

### 6. slot registry 要做，但不要带着 provider 分支一起做

slot registry 是对的，但实现上要刻意避免把它做成“给每个 provider 再包一层配置”。

正确做法应该是：

- 先固化槽位协议
- 再让执行者通过 adapter 适配这些协议
- orchestrator 只消费槽位输出，不消费 provider 细节

这会让 AISA 更像 harness，而不是一个 provider 编排平台。

## 不应该吸收的东西

### 1. transcript-first 的真相组织方式

Claude Code 的很多结构天然围绕 session 和 transcript 展开。

这对 assistant runtime 合理，对 harness 内核不合适。AISA 不该让 transcript 或 prompt chain 重新变成真相中心。

### 2. 通用 assistant 平台式膨胀

Claude Code 后面长出了很多运行时功能和产品表面。

这些能力对它成立，但对 AISA 来说大部分都不是当前主线。AISA 最怕的是内核开始承担太多不属于 harness 的平台功能。

### 3. 让副循环偷偷改主链

副循环可以强，但不能偷偷替 orchestrator 改真相。

一旦 health check、brief generator、review summarizer 这类旁路任务开始直接推进主链，系统会很快失去可解释性。

## 建议的实现顺序

如果要把这些想法变成现实，建议按下面顺序推进。

先把 `handoff bundle` 真正提成唯一恢复锚点。再把 `preflight` 升级成 shadow dispatch。然后补一条最短的 `run brief` 状态通道。等这三件事站住，再拆 maintenance plane，再做 slot registry 和更强 verifier kit。

这个顺序的好处是，不会把 AISA 带回“功能越来越多，但真相越来越散”的旧轨道。

## 最终判断

Claude Code 最值得 AISA 吸收的，不是功能菜单，而是系统习惯。

真正有价值的点只有这些：

- 主链要窄
- 副循环要强但克制
- 发车前要像真车一样预演
- 恢复入口只能有一个
- 错误必须分级
- provider 细节要被关进适配层

只要这些习惯吸收进去，AISA 会更像一个极强的 harness 底座。

如果吸收错了，把 Claude Code 的 assistant 平台体积一起学进去，AISA 反而会失去它现在最珍贵的方向感。
