# 两份计划交叉审查反馈

日期 `2026-03-23`

这次交叉看下来，两份文档并不冲突，重心不同。Codex 版更偏产品收口和任务闭环，Claude 版更偏工程实现和开发效率。放在一起看，反而能把 AISA 现在最容易失焦的地方补完整。

## 第一节 共识点

两份文档都认可当前方向没有跑偏。AISA 应该继续作为 control plane 往前走，不该回头再造一个底层 worker。文件系统优先、单进程 orchestrator、规则型 judge、现阶段不急着上数据库或复杂调度，这些基础判断是稳定共识。

两份文档也都承认当前仓库已经有一个真实可跑的 MVP，但还停在研究型原型阶段。它证明了主链可行，也就是 goal 到 plan，到 branch，到 worker，到 writeback，到 judge，到 report 这条线是通的。问题不在于架子有没有搭起来，而在于这条架子还没有支撑一个真正可持续的 agent 工作台。

还有一个重要共识是 planner 现在太硬编码。无论从产品角度还是工程角度看，固定三条 branch 都只是占位实现，不足以支撑真实任务策略。两份文档只是切入点不同，但都在指出同一件事，下一阶段必须让 planning 更像 planning，而不是模板填空。

## 第二节 分歧与互补

两份文档最大的区别，不是谁对谁错，而是谁先看任务结果，谁先看工程可维护性。Codex 版把注意力放在系统最终要不要真能推进任务，所以强调黄金路径、branch 类型分层、execution branch、验证产物、执行隔离和更硬的 Definition of Done。Claude 版把注意力放在现在这套代码能不能更稳地继续开发，所以强调 mock adapter、统一 adapter interface、SSE、错误处理、配置修正和决策记录。

这两种视角里，Codex 版更像在回答该先把产品做成什么样，Claude 版更像在回答现有仓库该先补哪些工程短板。前者决定方向，后者决定推进阻力。单看其中一份都不够。只看 Codex 版，容易知道该去哪，但开发过程会被真实依赖和接口形态拖住。只看 Claude 版，容易把仓库修得更整齐，却还没解决这个系统第一阶段到底要打穿什么任务的问题。

真正存在轻微优先级分歧的点有三个。第一个是 mock adapter。Claude 把它放到 P0，我认同它很重要，但更准确地说，它是开发效率 P0，不是产品价值 P0。第二个是 SSE。Claude 把它放到前面，我会再往后放一点，因为当前真正限制 AISA 的不是刷新频率，而是 branch 产物还不足以支撑执行型任务。第三个是 adapter interface。Claude 的方向是对的，但接口不该只为了兼容未来接 Pi 或异步 worker 来抽象，更应该先服务 branch 类型分层和 worker contract。换句话说，接口应该从任务模型倒推出去，而不是从技术预留倒推回来。

互补最明显的地方也正好在这里。Codex 版提出了 research branch、execution branch、verification branch 这层任务分工，Claude 版提出了统一 adapter interface、mock adapter 和更明确的错误边界。把两者合起来，刚好能收出一个更实的下一阶段方案。先定义 branch contract，再定义 adapter interface，再补 mock adapter 让这套 contract 能在本地和 CI 稳定演练。这会比单独做任何一项都更值。

## 第三节 综合建议

最终优先级我会这样排。第一优先级不是某个孤立功能，而是先钉死第一条黄金路径。目标要明确成一个真实仓库任务，从创建 goal 开始，到分叉，到至少一条 execution branch 真正执行动作，到人工 steer 在下一轮明确生效，到 judge 基于证据给出结论，到 report 能支持下一步开发决策。只要这条链没钉死，其他改动都会散。

黄金路径一旦定死，第二优先级就是 worker contract 和 branch 类型分层。这里要一起解决三个问题，branch 的任务类型是什么，writeback 里什么算有效证据，execution branch 的隔离现场怎么留。这个阶段应该把 Claude 提到的 adapter interface 一起做进去，因为这时接口会有真实边界，不会只是抽象而抽象。

第三优先级是补开发闭环。这里我会把 mock adapter、`.env.example` 修正、错误处理和最小决策记录放在一组。它们不直接决定产品方向，但会显著降低推进成本，也能让后面的验证不再依赖真实 Codex 和外部 API。

第四优先级才是体验增强和扩展能力。SSE、dashboard 的 run page 重心调整、planner 策略化、judge 从输出形状转向结果质量，这些可以并行推进，但仍然应该围着第一条黄金路径服务。再往后的 trigger、长期记忆、多实例和更复杂的 merge，现阶段都应该继续往后压。

如果一定要压成一句话，那就是先把任务闭环做真，再把工程底座补稳，最后才去做更快、更漂亮、更大规模的系统能力。

## 第四节 对 Claude 建议的具体反馈

Claude 那份建议整体是靠谱的，尤其适合拿来当当前仓库的短期工程整顿清单。mock adapter、配置修正、错误处理和决策记录，这几项都很实，也都能直接降低维护成本。对现有代码的观察也准确，没有脱离仓库现实。

我对 Claude 建议最想补的一句是，优先级需要再多一层任务视角。现在那份文档对工程短板判断很准，但还没有把这些动作和最终要打穿的任务闭环绑得足够紧。比如 mock adapter 该做，但它应该服务于 branch contract 演练，而不只是为了省 API 成本。adapter interface 该抽，但它应该围绕 research、execution、verification 这三种 branch 去设计，而不只是为了 future worker compatibility。SSE 也该补，但它解决的是观察体验，不是当前 AISA 最核心的可信执行问题。

如果把 Claude 的建议稍微往前再推半步，我会建议它把 P0 改写成两类。第一类是产品闭环 P0，也就是黄金路径、execution branch 和证据导向 judge。第二类是研发效率 P0，也就是 mock adapter、配置修正和错误边界。这样整个项目的推进逻辑会更稳，也能避免团队在早期把注意力都投到工程整洁度上，却没有尽快验证 AISA 最难也最值钱的那条链。

综合判断是，Claude 的建议适合做现在这版仓库的工程修整基线，Codex 这份建议适合做下一阶段产品收口基线。两者最好不要二选一，而是按先产品闭环、再接口与隔离、再开发便利、最后体验增强的顺序合并执行。
