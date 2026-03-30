# AGENTS.md

## 1. 仓库当前状态

这是一个处于 `PRD -> 实现` 过渡阶段的仓库。

- 当前仓库主要内容是产品需求文档：[2026-03-20_autoresearch-swarm-dashboard_PRD.md](E:\00.Lark_Projects\36_team_research\2026-03-20_autoresearch-swarm-dashboard_PRD.md)
- 在新增代码、目录、脚本、配置前，先阅读这份 PRD
- 不要把当前仓库误判为“已有实现的成熟项目”；默认它仍是一个文档优先、方案收敛中的工作区

## 2. 事实来源优先级

当信息冲突时，按以下顺序处理：

1. 用户在当前会话中的明确指令
2. 本文件 `AGENTS.md`
3. 仓库内后续新增的决策记录、架构说明、实施计划
4. [2026-03-20_autoresearch-swarm-dashboard_PRD.md](E:\00.Lark_Projects\36_team_research\2026-03-20_autoresearch-swarm-dashboard_PRD.md)
5. Agent 自行推断

补充说明：

- 如果未来已有代码与旧文档冲突，先确认是“文档过期”还是“实现偏离设计”
- 未经确认，不要擅自把 PRD 中的高层产品意图改写成别的项目方向

## 3. 项目定位

本项目是 `AutoResearch Swarm Dashboard`，其核心定位是：

- 一个 `agent orchestration control plane`
- 面向多 agent 任务编排、观测、人工 steer、上下文回写、评估择优
- 构建在现有 agent 之上，而不是重新发明底层模型或 worker runtime

不要把它实现成以下任一方向：

- 普通 chat UI
- 单 agent 对话壳
- 新的 foundation model 平台
- 以 worker 内核为中心、忽略 orchestration 与 shared context 的系统

最小正确方向应持续贴合 PRD 中强调的主线：

- `dashboard`
- `orchestrator`
- `shared context`
- `steer`
- `eval / judge`

## 4. 设计与实现原则

除非用户明确要求，否则默认遵守以下原则：

- 文件系统优先于复杂基础设施
- 先做可运行、可观察、可复盘的最小闭环，再引入更重的系统依赖
- 优先支持多分支探索和结果汇总，而不是只做单线程闭环
- 支持人工介入，但不要把 steer 简化为“粗暴中断当前任务”
- 所有重要产物都应可持久化、可追踪、可被其他 agent 读取

技术方向上，优先参考 PRD 的建议：

- 前端可采用 `Next.js` 或同等级成熟 Web 框架
- 后端可采用 `TypeScript` 或 `Python`
- 状态存储可先从本地文件和轻量存储开始，再演进到 `SQLite` 或 `Postgres`

## 5. 模块边界

如果开始落地代码，目录和模块边界应尽量贴合 PRD，而不是随意混写。

建议优先围绕以下能力组织代码：

- `dashboard-ui`
- `control-api`
- `orchestrator`
- `planner`
- `worker-adapters`
- `context-manager`
- `judge`
- `trigger-engine`
- `state-store`
- `event-log`

要求：

- `Dashboard` 只负责控制面和可视化，不承载复杂执行逻辑
- `Orchestrator` 负责调度和状态推进
- `Planner` 负责计划、分支策略、依赖关系
- `Context Manager` 负责共享上下文与回写
- `Judge` 负责评估、打分、择优
- 外部 agent 接入尽量通过 adapter 层，不要把 provider/CLI 细节散落到核心模块

## 6. 文件与产物约定

优先使用可读、可复用、可机器消费的产物格式：

- 方案、报告、复盘、设计说明使用 Markdown
- 状态、快照、事件、协议对象使用 JSON
- 流式事件或审计日志优先使用 NDJSON 或其他可追加格式

如果新增运行期产物目录，命名应直观并体现职责，例如：

- `docs/`
- `artifacts/`
- `events/`
- `state/`
- `reports/`
- `plans/`

不要把一次性实验文件、临时日志和长期资产混在一起。

## 7. 新增代码时的规则

在这个仓库里新增代码时，默认执行以下动作：

1. 先说明新增模块对应 PRD 的哪一部分
2. 保持改动小而可验证，不一次性铺开整套大架构
3. 为新增目录补最少量的说明文档，解释职责、输入输出、边界
4. 若引入状态文件或事件文件，给出最小 schema 或示例
5. 新增行为尽量附带测试、示例或最小验证脚本

如果只是搭脚手架，也要避免空壳目录泛滥。每个新目录都应有明确责任。

## 8. 文档与决策同步

由于当前仓库几乎没有可执行上下文，文档同步是强约束，不是附加项。

出现以下情况时，必须同步更新文档：

- 修改系统边界或模块职责
- 确定新的目录结构
- 引入新的事件模型、对象模型或状态机
- 调整评估策略、上下文协议、worker 接入方式
- 发现 PRD 与实际实现不一致，并决定以哪一方为准

建议把关键决策记录在 `docs/decisions/` 或类似目录中，至少说明：

- 背景
- 决策内容
- 为什么这样做
- 对后续实现的影响

## 9. Agent 工作方式

未来进入该仓库的 agent 应默认这样工作：

- 先读 PRD，再动手
- 先确认当前仓库是否仍处于“文档阶段”，不要假设已有代码体系
- 如果要扩展实现，优先延续 PRD 的模块语言和产品边界
- 如果信息不足，先补结构化说明或实施计划，再补代码
- 做完实现后，补齐与之对应的文档和产物约定
- 每轮完成后，若当前会话具备可用的外部频道连接，应通过 subagent 将本轮简要总结发送到公告板频道 `1487823042121040036`

若只是做探索、调研或方案拆解，输出应尽量沉淀为仓库内可复用资产，而不是只留在会话里。
