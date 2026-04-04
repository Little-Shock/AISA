# Glossary

这份词汇表用来统一 AISA 里最容易混淆的术语。

## Run

一条持续推进的任务。它不是一次聊天，而是一条会跨越多轮 attempt 的长期工作流。

## Attempt

围绕某个 run 发起的一轮正式尝试。一次 attempt 应该带有明确 contract、执行过程、验证结果和 review 结论。

## Current Decision

当前系统最可信的推进判断。它回答“下一步最应该做什么”，而不是简单复读历史状态。

## Preflight

执行前的放行检查。用于判断输入、依赖、风险和 readiness 是否满足，必要时直接 fail-closed。

## Preflight Evaluation Summary

把 preflight 阶段的关键结论压成 operator 可读的摘要，避免只能靠原始工件自己推断。

## Runtime Verification

面向可运行性和主回归链路的验证。它主要证明系统没有在关键 surface 上立刻坏掉。

## Adversarial Verification

故意尝试寻找失败路径、脆弱边界和 scope 外副作用的验证。它的目标不是证明 happy path，而是尽量提前发现风险。

## Review Packet

一轮 attempt 的结构化审查证据包，通常包含观察、findings、验证结果和风险结论。

## Handoff Bundle

交接给下一轮 AI 或人类的最小真相包。它关注“发生了什么、哪些结论成立、接下来先做什么”。

## Working Context

为恢复和续跑保留的持续上下文。它比 handoff 更偏“现场保持”，而不是单次交接摘要。

## Active Snapshot

当前 run 在某个时刻的活跃现场切片，用来帮助 operator 或后续 attempt 快速恢复上下文。

## Run Brief

给 operator 的运行摘要，压缩说明当前 run 的目标、状态、风险和建议动作。

## Failure Class

对失败进行统一分类的结构化标签，用来避免不同模块各自发明一套错误语义。

## Operator Surface

给人类值班、审查、接管使用的正式界面和接口集合，主要由 dashboard 与 control-api 组成。

## Fail-Closed

当系统无法确认安全或 readiness 时，默认不继续放行，而不是带着不确定性继续跑。

## Shadow Dispatch

在真正执行前做更接近真实派发的演练或放行检查，用来尽早暴露执行期风险。

## Degraded Path

当完整自动化路径不可用时，系统退化到的安全处理路径。重点不是“照常跑”，而是“明确告诉 operator 现在该怎么接球”。

## Self-Bootstrap

系统把自己的开发和推进任务也纳入 run / attempt 主链的一种运行方式。它要求更严格的验证、handoff 和恢复纪律。
