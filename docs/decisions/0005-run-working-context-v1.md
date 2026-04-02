# 0005 Run Working Context V1

## 背景

AISA 已经有 `current.json`、`automation.json`、`governance.json`、attempt `context.json`、`review_packet.json` 和 `handoff_bundle.json`。

这些工件各自有价值，但超长任务被拉长以后，operator 仍然缺一份直接回答现在在做什么、卡在哪、该看哪份证据的 run 级现场工件。

`handoff_bundle` 已经承担 settled 恢复锚点，不该再让它兼任 active run 的现场保持。

## 决策

新增 run 级工件 `runs/<run_id>/working-context.json`。

它只服务运行中的现场保持，不替代 `handoff_bundle`，也不进入自动续跑恢复锚点。

第一版收这些字段。

- `plan_ref`
- `active_task_refs`
- `recent_evidence_refs`
- `current_focus`
- `current_blocker`
- `next_operator_attention`
- `automation`
- `degraded`
- `source_attempt_id`
- `updated_at`

写入策略先收紧到少数主链时机。

- attempt 创建并落下 contract 后
- attempt 真正启动后
- attempt settled 后
- `current.json` 或 `automation.json` 被直接改写且不会经过上面两个主钩子时

control-api run detail 和 runs summary 都直接暴露：

- `working_context`
- `working_context_ref`
- `working_context_degraded`

dashboard 第一版只在 run detail 顶部读这套数据。

## 降级语义

读面不允许在 working context 缺失或落后时静默猜测。

第一版明确暴露三种 degraded。

- `context_missing`
- `context_stale`
- `context_write_failed`

写入失败继续按 fail-closed 处理，不靠 fallback 掩盖。

## 影响

active run 终于有了一份 run 级现场工件。

operator 不需要再先拼 `current`、journal 和 attempt 工件，才能知道当前焦点、卡点和最近证据。

自动续跑恢复链继续只认 `handoff_bundle`，但 active run 如果读到 degraded 的 working context，会先停下修现场，不假装上下文完整。
