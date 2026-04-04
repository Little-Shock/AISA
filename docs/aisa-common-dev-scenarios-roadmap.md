# AISA Common Dev Scenarios Roadmap

## 目的

这份 roadmap 只服务一个目标。

让 AISA 从一个已经能稳定开发自己、也能稳定维护 run 内真相的 harness，继续长成一个适合大部分常见开发场景，而且第一次拿起来就不费劲的开发控制面。

这条线优先覆盖这些场景。

| 优先级 | 场景 | 说明 |
| --- | --- | --- |
| P0 | 单仓库 Node 后端服务 | API 服务、Worker 服务、定时任务服务 |
| P0 | 单仓库 Python 服务 | API 服务、数据处理服务、脚本仓库 |
| P0 | Go service / CLI | 服务仓库、命令行工具、自动化工具 |
| P1 | 仓库维护任务 | 依赖升级、回归修复、重构、发布前加固 |

这条线暂时不把多 agent 组织层、移动端、多仓库发布编排、重前端交互项目作为近程重点。

## 当前起点

先把已经站住的底座说清楚，避免 roadmap 再去重复立项。

当前代码已经具备这些能力。

| 已有底座 | 当前状态 |
| --- | --- |
| run-centered 主链 | `run -> attempt -> preflight -> execution -> verification -> review -> handoff` 已成立 |
| 隔离执行 | managed worktree、workspace scope、runtime writeback 都已进入主链 |
| 恢复语义 | recovery guidance 已明确区分 `first_attempt`、`latest_decision`、`handoff_first`、`degraded_rebuild` |
| 证据读取 | latest evidence surface 已统一，不再让 control-api 在多处重复拼装 |
| 运行中现场 | working context、run brief、maintenance plane 已进入正式读面 |
| 验证纪律 | deterministic runtime verify、adversarial verify、judge / eval regression 都有正式回归 |

这说明 AISA 缺的已经不是 run 内核。

真正还没产品化的，是把一个陌生项目顺手接进来，把第一条 run 安全发起来，再把中断后的恢复讲明白。

## 当前缺口

面向大部分常见开发场景，当前最明显的缺口集中在六块。

| 缺口 | 为什么会卡住外部项目采用 | 现有底座能复用什么 |
| --- | --- | --- |
| 缺正式 attach / bootstrap 入口 | 现在能直接 `POST /runs`，但不会先替陌生仓库生成项目画像和基线 | `CreateRun`、workspace locking、run surface |
| 缺 project profile 和 baseline snapshot | 外部仓库第一次接入时，没有结构化事实说明它是什么项目、能跑什么、默认该怎么跑 | state-store artifact、run brief、working context |
| 缺常见技术栈 pack 和任务 preset | verification 仍偏手工，默认能力更偏 Node + `pnpm` | verifier kit、contract、preflight、failure modes |
| 缺 capability plane | operator 很难在 launch 前就看清本机和当前仓库到底能不能跑 | `/health`、preflight readiness、runtime layout |
| 缺 project-aware recovery | run 内恢复已经不错，但还没把项目级证据、依赖状态、基线变化收进恢复面 | recovery guidance、handoff-first、working context |
| 缺外部 proof | 现在更多是在 AISA 自己身上证明正确，没有形成参考仓库矩阵 | verify suite、nightly regression 基础 |

这些缺口里，attach、capability、pack、project-aware recovery 属于底座能力缺口。operator 短路径和参考仓库 proof 属于产品化缺口。顺序上应该先补前者，再压后者。

## 设计约束

这条线必须和现有单 run 硬化线兼容，也不能为了外部项目采用把未来多 agent 的地基挖掉。

边界写死如下。

第一，不改 run 主链形状。后续增强继续围绕 `run -> attempt -> contract -> verification -> evaluation -> handoff` 展开，不引入新的真相层。

第二，不把 project profile 做成另一套隐式配置系统。它应该只是 attach 之后的结构化项目事实和默认策略入口，最终仍然服务 run contract、effective policy bundle 和 verifier 选择。

第三，不把 capability plane 做成展示层 decoration。它必须能在 attach 和 launch 前 fail-closed，真正拦住不该发车的情况。

第四，不把 working context 升级成项目长期记忆。它仍然只服务 active run，项目级稳定事实应该落在 project profile 和 baseline snapshot。

第五，这条线不预先引入 team mailbox、leader approval、team memory bus。多 agent 之后可以直接复用这里的 project profile、pack、capability、recovery 语义，但不在本线内实现 team protocol。

## Phase C1

这一阶段的目标是把陌生仓库接入做成正式入口，而不是让 operator 先拼一条完整 run。

| 项目 | 内容 |
| --- | --- |
| 目标 | 输入仓库根目录后，AISA 能先识别项目，再生成第一版项目事实，而不是直接要求用户填满 run payload |
| 建设内容 | 新增 project attach / import 入口；新增结构化 project profile；新增 baseline snapshot，记录 repo 形态、语言、包管理器、工作区范围、默认入口、toolchain 状态和 unsupported reason |
| 交付物 | 可读的 project profile 工件；baseline snapshot 工件；attach API 或等价 CLI；attach 失败时的明确失败类和失败原因 |
| 完成标准 | 一个常见 Node、Python、Go 单仓库项目，能在 10 分钟内接入；接入后系统能说清这是哪类项目、默认建议怎么跑、当前不支持什么 |

## Phase C2

这一阶段的目标是把 capability plane 做成 attach 和 launch 之前就能读到的正式事实层。

| 项目 | 内容 |
| --- | --- |
| 目标 | 在真正发车前，就明确告诉 operator 这台机器和这个仓库能做什么、不能做什么 |
| 建设内容 | 生成项目级 capability snapshot；把 worker adapter、toolchain、verifier readiness、workspace permission、model / reviewer availability 收进同一张快照；定义 capability mismatch failure class；attach 和 launch 都读取这张快照 |
| 交付物 | capability snapshot 工件；control-api / dashboard 上的 capability surface；统一的 capability mismatch failure 语义 |
| 完成标准 | operator 能在 launch 前看见缺失依赖、不可执行命令、权限不匹配、worker 不可用这类问题；系统不会把这些问题拖到 execution 中途才暴露 |

## Phase C3

这一阶段的目标是把常见技术栈和常见任务类型收成默认 pack，而不是继续让外部项目从零手写 verification plan。

| 项目 | 内容 |
| --- | --- |
| 目标 | attach 完之后，系统能给出第一版可用的 contract、verification 和 adversarial gate 建议 |
| 建设内容 | 提供 Node backend pack、Python service pack、Go service / CLI pack、repo maintenance pack；在 pack 之上补 bugfix、feature、refactor、API change、flaky test、release hardening 这类任务 preset；把默认验证命令、done rubric、failure modes、adversarial probe 模板都收进去 |
| 交付物 | stack pack registry；task preset registry；attach 阶段的 pack 推荐；生成第一版 attempt contract 的默认器 |
| 完成标准 | 大多数常见后端项目在 attach 后，不需要先手写完整 verification plan 就能安全启动第一条 run；生成出的默认 contract 具备 replayable verification 和 fail-closed 语义 |

## Phase C4

这一阶段的目标是把恢复从 run 内恢复推进到项目级恢复。

| 项目 | 内容 |
| --- | --- |
| 目标 | 外部项目 run 中断后，系统能基于项目事实和最新 settled evidence 明确告诉 operator 该继续、该 rebuild，还是该停下来等人 |
| 建设内容 | 让 project profile 和 baseline snapshot 进入 recovery guidance 输入面；working context 增补 baseline refs、关键文件 refs、最近证据 refs、当前 blocker、next focus；把 handoff-first、latest-decision、degraded-rebuild 的判定扩到项目级恢复 |
| 交付物 | project-aware recovery guidance；控制面上的 recovery path、recovery reason、baseline refs、latest settled evidence refs；项目级 degraded 语义 |
| 完成标准 | 一个外部项目 run 被暂停、隔夜中断、环境损坏或 managed workspace 重建后，系统能明确给出下一步建议；没有 handoff 或 baseline 缺失时会显式进入 degraded，而不是让 operator 猜 |

## Phase C5

这一阶段的目标是把第一次使用者的主路径压短，让人不用先懂完整内部术语体系。

| 项目 | 内容 |
| --- | --- |
| 目标 | 把 attach、launch、triage、resume 变成外部项目优先的最短路径 |
| 建设内容 | control-api 和 dashboard 都补 project-first surface；run detail 默认展示 project profile、pack、capability、preflight summary、handoff summary、recovery path；补外部项目版 getting started 和 operator guide；提供最短命令或入口流转 |
| 交付物 | 外部项目 onboarding 文档；project-first run detail；attach -> launch -> triage -> resume 的最短操作路径 |
| 完成标准 | 一个第一次使用 AISA 的工程师，不需要先读完整 architecture，就能在常见后端仓库里完成接入、启动、排障和恢复；UI 和文档不再默认读者已经熟悉 AISA 内部脑图 |

## Phase C6

这一阶段的目标是把可用性从内部确信推进到外部可证明。

| 项目 | 内容 |
| --- | --- |
| 目标 | 证明这套能力不只对 AISA 自己成立，而是对几类代表性仓库都成立 |
| 建设内容 | 建 3 到 5 个参考仓库矩阵；每个仓库沉淀 attach profile、默认 pack、典型失败模式、恢复路径回归；建立 external repo smoke suite 和 nightly regression；定义 adoption rubric |
| 交付物 | reference repo matrix；nightly regression；external adoption rubric |
| 完成标准 | 至少覆盖 Node backend、Python service、Go service / CLI、repo maintenance 四类路径；这些路径都能重复回放，不是一次性人工演示 |

## 推荐顺序

推荐顺序只有一条。

先做 C1，再做 C2，再做 C3，然后做 C4，再做 C5，最后做 C6。

原因也只有一条。先让项目能被识别、能被判断、能被安全发车，再把默认验证收成产品能力，然后把恢复做项目化，最后压低使用门槛并做外部证明。这样路线会一直建立在真相层和 fail-closed 语义上，不会先做表面易用性，再回头补底层纪律。

## Definition of Done

这条 roadmap 完成时，AISA 应该进入这样的状态。

一个第一次使用 AISA 的工程师，把一个常见后端或工具仓库接进来后，不需要先手写一堆配置，不需要先深懂一整套内部术语，也不需要自己猜这台机器能跑什么。系统会先识别项目，给出项目画像、能力快照、默认 pack 和第一版验证计划；发车前能明确 fail-closed；中断后能明确给出恢复路径；最终还有一组外部参考仓库证明这不是只会开发 AISA 自己的 harness。

到那时，再说它适合大部分常见开发场景，而且比较容易使用，才是站得住的。
