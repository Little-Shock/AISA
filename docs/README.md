# AISA Docs

这套文档的目标不是把仓库里的每个文件都解释一遍，而是让不同角色的人都能尽快回答 3 个问题：

1. 这个项目到底是什么？
2. 我现在该看哪份文档？
3. 我改完代码后该跑什么验证？

如果你还没看过仓库首页，先从根目录的 [`README.md`](../README.md) 开始。它负责回答「AISA 是什么」和「怎么在本地跑起来」。

## 从哪里开始

### 我是第一次进仓库

- 根 [`README.md`](../README.md)
  - 产品定位、Quick Start、主要验证入口
- [`getting-started.md`](./getting-started.md)
  - 新同学第一次跑通本地环境、理解 repo map 和常用验证入口的首站
- [`aisa-common-dev-scenarios-roadmap.md`](./aisa-common-dev-scenarios-roadmap.md)
  - 如果目标是把 AISA 接到外部仓库，这份是近程主路线
- [`glossary.md`](./glossary.md)
  - 先把 `run`、`attempt`、`handoff`、`working context` 这些词对齐

### 我是 operator / reviewer / 值班同学

- [`operator-guide.md`](./operator-guide.md)
  - 用人话解释 dashboard 上最重要的信号、该怎么接球、什么时候该人工介入
- [`verify-cookbook.md`](./verify-cookbook.md)
  - 按场景列常用验证命令，不需要先读完整架构
- [`troubleshooting.md`](./troubleshooting.md)
  - 常见红点、定位顺序和最小排障命令

### 我是开发者，想理解系统主链

- [`run-lifecycle.md`](./run-lifecycle.md)
  - 解释 `run -> attempt -> verify -> handoff -> next decision` 主链
- [`architecture.md`](./architecture.md)
  - 解释 control plane 的层次、模块边界和数据流
- [`decisions/`](./decisions)
  - 关键设计决策记录

## 当前推荐阅读顺序

1. 根 [`README.md`](../README.md)
2. [`operator-guide.md`](./operator-guide.md)
3. [`verify-cookbook.md`](./verify-cookbook.md)
4. [`run-lifecycle.md`](./run-lifecycle.md)
5. [`architecture.md`](./architecture.md)
6. [`glossary.md`](./glossary.md)
7. 需要追设计历史时再看 roadmap、PRD 和 ADR

## 文档地图

### 新人入口

- [`getting-started.md`](./getting-started.md)
  - 本地启动、验证入口、推荐阅读顺序
- [`run-lifecycle.md`](./run-lifecycle.md)
  - 主运行链路和工件解释
- [`architecture.md`](./architecture.md)
  - 模块边界、四层结构、数据流
- [`glossary.md`](./glossary.md)
  - 统一术语表

### 产品与路线

- `aisa-harness-prd-v1.md`
  - 当前 harness 主线 PRD
- `aisa-harness-roadmap-v1.md`
  - 当前主 roadmap
- `aisa-single-run-core-hardening-roadmap.md`
  - 单 run 核心收敛路线
- `aisa-common-dev-scenarios-roadmap.md`
  - 面向常见外部开发场景的接入与采用路线
- `project-isolated-runtime-requirement.md`
  - AISA 作为 runtime 管理多个外部项目时的项目隔离需求与对抗性验收方案

### 专项计划与历史材料

- `aisa-claude-code-absorption-roadmap.md`
  - Claude Code 吸收顺序路线图
- `aisa-claude-code-next-learning-plan.md`
  - postflight gate 和 operator surface 的专项计划
- `claude-code-lessons-for-aisa-harness.md`
  - Claude Code 对 AISA 的研究结论
- `implementation-blueprint.md`
  - 旧 swarm 方案蓝图，保留作历史参考
- `working-context-phase-2-plan.md`
  - working context 后续计划
- `handoff-fix-run-concurrency.md`
  - 针对 handoff / 并发问题的专项记录
- `remote-observability-cloudflare.md`
  - 远端观测环境说明

### 设计决策

- `decisions/0001-mvp-runtime.md`
- `decisions/0002-runtime-source-drift-requires-restart.md`
- `decisions/0003-reviewer-pipeline-artifacts.md`
- `decisions/0004-model-synthesizer-finalizes-attempt-evaluation.md`
- `decisions/0005-run-working-context-v1.md`
- `decisions/0006-fail-closed-artifact-reads.md`
- `decisions/0007-adversarial-dry-run-replay.md`

## 维护约定

- 模块边界、目录结构、事件模型、状态模型发生变化时，先更新文档，再扩展实现。
- 根 README 负责「产品首页」语义；`docs/` 负责按角色拆开的深入入口。
- 每新增一个长期维护的 verify 脚本，都应该在 [`verify-cookbook.md`](./verify-cookbook.md) 里补上用途和推荐使用场景。
- 新增长期术语时，优先落在 [`glossary.md`](./glossary.md)，避免不同文档各自发明口径。
