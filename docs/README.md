# Docs

这个目录用于沉淀本仓库在 `PRD -> 实现` 过渡阶段的结构化文档。

当前文档：

- `aisa-harness-prd-v1.md` 当前 harness 主线 PRD
- `aisa-harness-roadmap-v1.md` 当前唯一主 roadmap
- `aisa-claude-code-absorption-roadmap.md` Claude Code 吸收顺序的配套路线图
- `aisa-claude-code-next-learning-plan.md` postflight gate 和 operator surface 的专项实施计划
- `claude-code-lessons-for-aisa-harness.md` Claude Code 对 AISA 的研究结论和判断
- `implementation-blueprint.md` 仅保留为旧 swarm 方案的历史蓝图，不再代表当前 harness 主线
- `remote-observability-cloudflare.md`
- `decisions/0001-mvp-runtime.md`
- `decisions/0002-runtime-source-drift-requires-restart.md`

约定：

- 当模块边界、目录结构、事件模型、状态模型发生变化时，先更新这里的文档，再扩展实现。
- 文档内容默认以当前会话指令、`AGENTS.md` 和 PRD 为准。
