# 0004 - Model Synthesizer Finalizes Attempt Evaluation While Runtime Verification Stays Hard-Gated

## 背景

`0003` 已经把评审链路拆成：

- `review_input_packet.json`
- `review_opinions/*.json`
- 一份供 loop 消费的 `evaluation.json`

但当时最终 `evaluation.json` 仍然由确定性规则直接聚合 reviewer opinions。

这会留下两个问题：

- 多 reviewer 已经落盘了，但最终结论还是单层规则拼接，缺少真正的多视角综合
- 如果要接 Gemini CLI、Codex CLI 这类真实 reviewer，系统还没有一个通用的 final synthesizer 入口

## 决策

最终 attempt evaluation 改成四层：

- `review_input_packet.json`
- `review_opinions/*.json`
- `evaluation_synthesis.json`
- `evaluation.json`

其中：

- reviewers 继续只负责输出 opinion
- synthesizer 负责把 frozen input、reviewer opinions 和 deterministic base evaluation 综合成最终 judgment
- `evaluation.json` 继续是 loop 唯一消费的结论

配置层拆成两套：

- `AISA_REVIEWERS_JSON`
- `AISA_REVIEW_SYNTHESIZER_JSON`

这让 reviewer 和 final synthesizer 可以独立扩展，不把 Gemini CLI、Codex CLI 写死进 orchestrator 协议。

## 约束

runtime verification 仍然是硬门槛。

具体约束是：

- `verification_status` 由 deterministic runtime verification 决定
- 当 runtime verification 失败时，最终 recommendation 和 suggested_attempt_type 继续锁在 deterministic 结果上
- 模型 synthesis 只能改软判断，比如 evidence quality、goal progress、rationale 和 missing evidence

如果 configured synthesizer 失败：

- 不允许静默退回 deterministic synthesis
- `evaluation.json` 不落盘
- `evaluation_synthesis.json` 不落盘
- run 会显式停在可恢复状态，保留 reviewer opinions 和失败上下文

## 影响

- 多 reviewer 不再只是证据附件，最终结论真的会经过模型综合
- final synthesis 也有独立工件，可回放、可审计
- 后续继续加别的 provider 或 reviewer 角色时，只需要补 config 和 CLI wrapper，不需要改 run-centered 主链
