# Anthropic Harness 方法对 AISA 的启示

这份文档不是复述文章。

它只回答四件事。Anthropic 这篇文章里真正有价值的部分是什么。它的结构和方法到底是什么。AISA 当前架构和它已经对齐了哪些地方，还缺了什么。以及 AISA 要不要调整架构，如果要，应该动哪里，不应该动哪里。

参考材料主要有两类。一类是 Anthropic 的原文 `Harness design for long-running application development`。另一类是 AISA 当前仓库里的 `run-centered` 架构认知、开发 handoff、自举模板和 runtime eval 资产。

## 先说结论

AISA 不需要改掉现在已经收敛出来的四个核心原语，也就是 `run + worker + verifier + loop`。

真正该吸收的，不是把 Anthropic 的三 agent 结构原样搬过来，而是把它的方法塞进 AISA 已经存在的 `verifier` 和 `attempt lifecycle` 里。更直接地说，AISA 现在缺的不是更多 agent，而是更硬的尝试契约、更怀疑的外部评估、更真实环境里的验收，以及一套能持续校准 evaluator 的工作流。

所以答案不是推翻重来，而是局部升维。AISA 的顶层架构可以不动，但 `verifier` 这一层必须从现在的轻 heuristic 升成真正的一等子系统。同时，execution attempt 不该再先做再补验证，而应该像 Anthropic 文里那样，先把 done contract 讲清楚，再允许执行。

## Anthropic 这篇文章真正有价值的地方

这篇文章最值钱的判断有三个。

第一个判断是，长时任务失败的两个主因不是模型不会写，而是做久了会跑偏，以及模型对自己太宽容。前者对应上下文衰减、任务漂移、提前收尾。后者对应自评过宽、生成器替自己找理由、把半成品说成完成品。这个诊断很重要，因为它把问题从“继续堆 prompt”转成了“重构任务闭环”。

第二个判断是，外部 evaluator 比自我反思更可控。文章里最核心的结构不是 planner、generator、evaluator 这三个词本身，而是把生产和验收强行拆开。生成器负责做，评估器负责挑刺。评估器不看生成器怎么说，而是去真实环境里跑，拿具体 evidence 判 fail/pass。这个思想和我们之前一直强调的不能被 fallback 骗、不能靠样例过关，其实是同一条线。

第三个判断是，harness 只是模型短板的补丁，不是永久神学。Anthropic 后来把 sprint 拆掉，就是因为模型升级后那层 scaffold 不再那么 load-bearing 了。这一点对 AISA 很关键，因为它意味着架构不应该围着今天某个模型的弱点永久凝固。应该保留的是稳定原语，不是临时脚手架。

## 他们的方法和结构到底是什么

Anthropic 这篇文章其实讲了两代 harness。

第一代是长时 agent 的基础版。它的核心做法是先拆任务，再做长任务分段，再用结构化 handoff 在 session 之间传递状态。这里最关键的不是“分段”这件事，而是他们已经承认单个 agent 长跑会失真，所以要用结构化工件保持现场连续性。

第二代是文章重点讲的版本。这个版本把系统拆成 planner、generator、evaluator 三个角色。planner 不是做详细技术实现，而是把一句需求扩成高层 spec。generator 按 chunk 或 sprint 去实现。evaluator 用真实环境里的工具去测，例如前端设计里用 Playwright 实际打开页面、截图、操作，再按 rubric 打分。在全栈应用里，evaluator 不是简单打分，而是按 contract 逐条验收，发现 bug 就打回。

这套结构里还有两个细节特别重要。

第一个细节是 contract-first。generator 和 evaluator 在每个 sprint 前先谈清楚这轮要做什么，done 长什么样，怎么测，什么算通过。这一步的作用不是形式化文书，而是把“高层模糊 spec”变成“这一轮可验证的工作契约”。

第二个细节是 evaluator calibration。Anthropic 明说了，评估器默认并不靠谱，早期会看出 bug 但又自己原谅自己。所以他们不是把 evaluator 当神谕，而是持续读 trace、找误判、加 few-shot、改 rubric，直到 evaluator 的偏好和人类验收足够接近。这本质上是一条 reviewer 训练流水线。

文章里还有一个经常被忽略但对我们更有价值的地方。Anthropic 不是只用 evaluator 来“看结果好不好”，而是把 evaluator 变成系统能不能继续推进的闸门。任何一项硬标准不过，就不能算完成。这比数值打分更像真正的 runtime contract。

## AISA 当前架构和它已经对齐了哪些地方

AISA 当前最成熟的地方，恰好不是 UI，而是架构判断。

我们已经明确了 `run` 是唯一事实源，`worker` 是外部执行体，`verifier` 是判断这次尝试是否推进 goal 的槽位，`loop` 是唯一主动推进者。这一点和 Anthropic 真正有价值的部分高度一致。AISA 也已经不把 planner 当顶层神圣蓝图，而是更接近 loop 内的 planning logic。这比 Anthropic 文章里写出来的表层三 agent 结构，其实更干净。

AISA 现在还有两个地方已经踩在正确方向上。

第一个是 replayable verification 的意识已经出来了。`runtime-verification.ts` 明确要求 execution result 必须带 `verification_plan`，而且 runtime 只信自己能重放的命令，不信口头自述。这个方向非常对，因为它天然对抗了“模型说自己做完了”的假阳性。

第二个是 eval 资产已经不是空壳。`evals/runtime-run-loop/` 里已经有 capability contract、failure modes、reviewer spec、smoke datasets。里面很多要求和 Anthropic 的 evaluator 思路已经同源，比如 fail closed、证据不够就 `needs_human`、不能从自信语气推导成功、每次只检查一个 failure mode。这说明 AISA 不是没有 evaluator 思想，而是 evaluator 还没深入到主运行链路。

## AISA 当前和 Anthropic 方法相比，真正缺的是什么

缺口主要不在顶层，而在 attempt 内部。

第一个缺口是 AISA 现在还没有真正的 attempt contract。现在 run 有 contract，execution 后也可能有 verification plan，但这两个东西中间少了一层。也就是“这一轮 attempt 到底要做什么、完成标准是什么、要留下哪些 evidence、失败的典型模式是什么”。Anthropic 的 generator 和 evaluator 先谈 contract，本质上是在补这层。AISA 现在如果直接起 execution attempt，仍然容易出现目标含糊、执行范围漂移、验证后置的情况。

第二个缺口是 verifier 还没真正分层。当前 `judge` 还只是第一版 heuristic，handoff 里也明确写了它离可信 verifier 还差很远。现在的 runtime verification 更像 execution 的硬约束，但 `judge` 还是偏文本和启发式。Anthropic 的思路其实是在提醒我们，verifier 不该是一个单一函数，而该至少分成三层。第一层检查 contract 是否可验。第二层检查 deterministic evidence，比如 git 改动、命令回放、测试结果、schema。第三层才是 skeptical evaluator，去看更高层的“这次到底算不算推进了 goal”。

第三个缺口是 evaluator calibration 还没有成为 AISA 的主工作流。AISA 已经有 reviewer spec，但目前更像离线 eval 资产，而不是每次线上误判后都能沉淀成新 failure mode、新数据集、新 reviewer prompt 的闭环。Anthropic 文章最强的部分不是他们有 evaluator，而是他们承认 evaluator 一开始很差，并把调 evaluator 当成主要工程工作。AISA 现在还没把这件事产品化、流程化。

第四个缺口是 goal-type-specific verification 还不够。Anthropic 在设计任务里用 Playwright，在应用任务里看 UI/API/DB，在不同任务上 evaluator 的抓手是不同的。AISA 现在的 runtime verification 已经对 execution 做了通用约束，但 verifier 还没有按任务类型长出不同的能力套件。对代码改动要看 patch 和测试，对 Web 产品要看 Playwright 和交互，对数据任务要看查询复现和指标检查。这个如果不分层，evaluator 会长期停在“看 writeback 文本”。

## 我们应该吸收什么，不应该照搬什么

AISA 最应该吸收的，不是多 agent 数量，而是四个工程习惯。

第一个是 contract-first。任何 execution attempt 开始前，都应该先有一个可验证的 `attempt contract`。它不需要像 Anthropic 那样有两个 agent 显式谈判，但 loop 至少要在内部完成这一步，并且 verifier 要有权否决“不可验证的 attempt”。

第二个是 skeptical evaluator。AISA 现在已经有 reviewer spec 里的 fail-closed 倾向，但要把这个思想真正搬进线上。不是给分，而是找 failure mode。不是问“看起来像不像成功”，而是问“还有哪些证据缺口足以让这次不能算成功”。

第三个是 evaluator calibration loop。每次 false positive、false negative、needs_human 分歧，都应该沉淀成 review packet 和 failure mode 资产。Anthropic 那种“读 logs，找误判，改 rubric”的活，不是附加项，而是 verifier 成熟的主线。

第四个是 scaffold 要分层，不要默认重型模式。Anthropic 自己已经证明，重 harness 有用，但贵、慢，而且只有在任务处在模型 solo 边界外时才值。AISA 不该把 Anthropic 的重型流程当默认路径，而应该保留一个轻默认路径，加一个高价值任务下的重型路径。

不该照搬的也有三件事。

第一，不要把 planner 再抬成顶层大组件。AISA 现在已经把 planner 放回 loop 里了，这是对的。Anthropic 的 planner 适合他们的应用生成场景，但 AISA 的核心不是写产品 spec 平台，而是 run control plane。

第二，不要把 sprint 结构当永久核心。文章自己已经说明，sprint 只是对旧模型的一层补丁。AISA 现在更应该做的是明确 attempt 原语和 verifier 原语，而不是重新长出一个厚重的 sprint orchestration。

第三，不要把 evaluator 做成一个统一神判官。我们真正要学的是 evaluator fail closed 和真实环境验收，而不是所有问题都丢给同一个 LLM reviewer。

## AISA 架构需不需要调整

需要，但不是大换血，而是局部重构。

顶层原语不需要改。`run + worker + verifier + loop` 仍然是对的。真正要调整的是 `verifier` 的内部结构，以及 `attempt` 从创建到验收的生命周期。

如果用一句更准确的话来讲，就是这样。AISA 的架构中心不用从 run-centered 改成 planner-centered 或 multi-agent-centered，但它必须从“run-centered + heuristic judge”进化到“run-centered + contract-first verifier”。

## 具体应该怎么调

第一处调整，是把现在的 `judge` 升成真正的 `verifier stack`。

这个 stack 至少应该有三层。最前面是 `contract checker`，负责判断这次 attempt 的目标、完成条件、evidence 要求和 verification steps 是否完整、是否可执行。中间是 `runtime verifier`，负责 deterministic replay，例如 git 变更、测试命令、API 命令、Playwright、数据校验。最后才是 `skeptical evaluator`，它读 contract、读 evidence、读 replay 结果，判断这次是否真的推进了 run 目标，以及下一步是继续、重试、换策略还是等人。

这意味着 `judge` 这个名字已经太轻了。现在就算不改 package 名，也应该把心智模型改掉。它不是一个结果评分器，而是一个多层 verifier。

第二处调整，是把 `attempt contract` 变成正式工件。

建议每个 attempt 目录里增加一份 `attempt_contract.json` 或 `attempt_contract.md`。这份东西至少包含这轮 objective、done definition、verification steps、required evidence、forbidden shortcuts、expected artifacts。当前 execution 的 `verification_plan` 应该从“执行结果里补带回”前移成“attempt 创建时必须确定”。worker 可以补充，但不能缺失。

这个改动会比继续补 heuristic judge 更值，因为它直接把“先做再说”改成“先说清楚怎么才算做成”。

第三处调整，是把 evaluator 的输入标准化成 review packet。

Anthropic 文章里 evaluator 强的原因，不是 prompt 魔法，而是它读到的是结构化证据。AISA 已经有 reviewer spec 和 review packet schema 思路，下一步该把它接进运行时。每次 execution 或关键 research attempt 结束，都应该自动生成 `review_packet.json`，里面有 contract、attempt meta、raw evidence manifest、verification results、blocking reasons、candidate next steps。这样 evaluator 的判断就不会继续漂在自由文本上。

第四处调整，是把 verifier 做成按任务类型装配。

代码改动型 run，不该和数据分析型 run 用同一套“看文本写回”的 evaluator。建议把 verifier 能力拆成任务插件。repo task 重点看 patch、tests、git state。Web task 重点看 Playwright、页面状态、接口回包。数据 task 重点看 SQL 可复现、指标定义、样本检查。这样 Anthropic 文里“在真实环境里验收”的思想才算真正落地。

第五处调整，是把 heavy harness 变成模式，而不是默认流程。

建议把 AISA 的 run 分成至少两种模式。普通模式用当前最小 run loop，强调便宜、快、可回放。重型模式在高价值任务上启用更严格的 contract、更多 verifier passes、更强的 evaluator 和必要的多轮修复。这样既吸收了 Anthropic 的有效部分，又不会把系统默认成本拉爆。

第六处调整，是把 evaluator calibration 变成一条固定维护线。

每次 evaluator 误判，都不该只是修一次 prompt 然后忘掉。应该沉淀成 failure mode、回放数据集、review packet 和 reviewer prompt 更新。AISA 已经有 `evals/runtime-run-loop/`，下一步不是再多写几条 smoke，而是让线上真实失败能被抽样并回灌进这套资产。

## 哪些改动是现在就值得做的

如果只看投入产出比，最值得先做的是三件事。

第一件，是把 `verification_plan` 从结果后置要求改成 attempt 前置契约，同时补 `attempt_contract` 工件。

第二件，是把 `judge` 从文本 heuristic 提升成三层 verifier，至少让 deterministic verification 和 skeptical evaluator 明确分层。

第三件，是把现有的 reviewer 资产接进线上运行闭环，让 false positive 和 false negative 能直接变成新 case，而不是只留在手工经验里。

这三件做完，AISA 的核心可信度会立刻上一个台阶，而且不会破坏当前的 run-centered 主结构。

## 最后一句判断

AISA 现在的方向没有错，甚至在架构原语上比 Anthropic 文章表面那套更干净。真正的问题不是原语选错了，而是 verifier 还没长成。

所以别把这篇文章读成“我们也该多起几个 agent 了”。更准确的读法是，“我们得把 attempt contract、外部怀疑型 evaluator、真实环境验收、calibration loop，正式塞进 AISA 的 verifier 层”。这才是对它最值钱的吸收。
