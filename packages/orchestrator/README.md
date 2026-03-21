# Orchestrator

职责：

- 拉取 queued branch 并发给 codex worker
- 维护 branch / run / goal 状态推进
- 在 writeback 后串联 context、judge 和 report
