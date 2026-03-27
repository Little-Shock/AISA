# 0003 - Attempt Reviewer Pipeline Persists Frozen Input, Opinions, And One Synthesized Evaluation

## 背景

当前 run-centered loop 已经有：

- attempt result
- runtime verification
- 单份 `evaluation.json`

但 evaluator 还停在单层结构里，存在两个问题：

- reviewer 证据和 reviewer 角色信息没有单独落盘，无法复盘多 reviewer 分歧
- orchestrator 如果未来直连多个模型 provider，容易把 Gemini CLI、Codex CLI 这类实现细节写死到核心调度里

## 决策

attempt 评审链路拆成三层持久化产物：

- 冻结的 `review_input_packet.json`
- 多份 `review_opinions/*.json`
- 一份供 loop 消费的 `evaluation.json`

Reviewer adapter 只通过通用 reviewer 身份字段接入：

- `role`
- `adapter`
- `provider`
- `model`

Reviewer 注册改为配置驱动：

- runtime 默认从 `AISA_REVIEWERS_JSON` 读取 reviewer 列表
- 每个 reviewer config 只声明身份字段和 adapter 参数
- 首个真实 adapter 采用 CLI stdin/stdout JSON 协议，不改 `review_input_packet -> review_opinions -> evaluation` 落盘协议

Orchestrator 不再依赖具体模型/provider 名称，只负责：

- 冻结 review input
- 并行收集 reviewer opinions
- 用确定性 synthesizer 合成单份 evaluation

硬门槛继续由 deterministic runtime verification 决定。reviewer 只提供软判断和下一步建议。

## 影响

- 同一份 attempt 证据现在可以并行留下多份 reviewer opinion
- loop 继续只消费一份 synthesized evaluation，不破坏现有 run-centered 主链
- 后续接 Gemini CLI 3.1 Pro、Codex CLI 或其他 reviewer 时，只需要补 adapter，不需要改 orchestrator 协议
