# Working Context Phase 2 Plan

这份文档只服务下一阶段一件事。

给 active run 补上一层运行中现场保持，让超长任务拉长以后，系统仍然知道自己现在在做什么、为什么停住、下一步该接哪条线。

这不是 transcript 压缩。也不是新的长期记忆层。更不是 handoff bundle 的替代品。

handoff bundle 继续负责 settled 之后的恢复锚点。working context 只服务 active run。

## 目标

下一阶段先把运行中现场变成一份显式工件，而不是散落在 current、journal、attempt 工件和 dashboard 文案里。

这份工件要解决的是三个问题。

- 单次运行拉长以后，当前计划和当前焦点会漂
- evidence 和 blocker 分散在不同文件里，operator 很难快速读现场
- 一旦现场压缩或重写失败，系统今天缺少明确的 degraded 表达

## 最小工件

建议新增 `runs/<run_id>/working-context.json`。

它只记录当前仍然活着的现场，不做历史归档。

建议最小 schema 先收紧到这些字段。

```json
{
  "run_id": "run_xxx",
  "status": "active",
  "plan_ref": "runs/run_xxx/attempts/attempt_xxx/attempt_contract.json",
  "active_task_refs": [
    {
      "task_id": "task_current",
      "title": "stabilize dashboard run detail view",
      "source_ref": "runs/run_xxx/attempts/attempt_xxx/result.json"
    }
  ],
  "recent_evidence_refs": [
    {
      "kind": "verification",
      "ref": "runs/run_xxx/attempts/attempt_xxx/runtime_verification.json",
      "note": "latest failing proof"
    }
  ],
  "current_focus": "repair dashboard run detail loading path",
  "current_blocker": {
    "code": "missing_working_context_snapshot",
    "summary": "latest context rewrite failed before handoff",
    "ref": "runs/run_xxx/journal.ndjson"
  },
  "next_operator_attention": "relaunch after context rewrite repair",
  "automation": {
    "mode": "active",
    "reason_code": null
  },
  "degraded": {
    "is_degraded": false,
    "reason_code": null,
    "summary": null
  },
  "source_attempt_id": "attempt_xxx",
  "updated_at": "2026-04-01T00:00:00.000Z"
}
```

这里有几个边界要先说死。

- `plan_ref` 指向当前正在生效的 run contract 或 attempt contract，不复制计划正文
- `active_task_refs` 只放仍然正在推进的任务，不做完整任务史
- `recent_evidence_refs` 只保留最近还能支撑当前判断的证据引用
- `current_focus` 和 `current_blocker` 允许短文本，因为 operator 需要一眼能看懂
- `automation` 直接镜像当前 automation truth，避免现场和自动化状态分叉
- `degraded` 必须显式存在，失败时不能靠缺字段表达

## 更新时机

这份工件不需要每个 event 都刷。先抓几个真正改变现场的点。

- 新 attempt 创建后，写入当前 plan ref、当前焦点和初始 task refs
- attempt settled 后，用这轮结果刷新 active task refs、recent evidence refs、current blocker
- steer 被应用后，刷新 current focus 和 next operator attention
- run 进入 `manual_only` 或 `waiting_steer` 时，同步 automation 和 degraded
- handoff bundle 生成成功时，不删除 working context，只把它留给 active run 继续用

第一版先不要做高频增量压缩。先把谁负责写、什么时候写、写坏了怎么办钉住。

## 降级语义

working context 失败时不能静默跳过。

建议明确三种 degraded 状态。

- `context_missing` 本轮还没生成过 working context
- `context_stale` 最新一次 attempt 已经 settled，但 working context 没跟上
- `context_write_failed` 现场写入尝试失败，内容不可信

系统动作也要收紧。

- degraded 只影响 active run 读面，不得改写 settled 恢复锚点
- auto-resume 读到 degraded working context 时，不得假装现场完整
- dashboard 和 control-api 要直接暴露 degraded 状态，不替用户脑补

## 和 handoff bundle 的分工

两者职责不能混。

handoff bundle 回答的是上一轮 settled 之后发生了什么，恢复应该读什么。

working context 回答的是当前这轮仍在运行时，计划在哪、证据在哪、焦点在哪、卡在哪。

恢复顺序也要固定。

- active run 读 working context
- settled recovery 读 handoff bundle
- 如果 active run 现场坏了，也只是进入 degraded，不回退成 transcript-first 模式

## API 和 dashboard 先做什么

第二阶段最先落地的，不是复杂压缩算法，而是把这份工件接进读面。

control-api 的 run detail 建议先补：

- `working_context`
- `working_context_ref`
- `working_context_degraded`

dashboard 先补两个最值钱的位置。

- run detail 顶部显示当前 focus、current blocker、automation mode
- 明示当前读的是哪份 working context，是否 degraded

只要这层读面先站住，后面再加 context rewrite 和 compact 机制，风险会小很多。

## 下一步实现顺序

下一轮实现建议按这个顺序做。

先在 domain 和 state-store 里定义 `WorkingContext` 及持久化。

再让 orchestrator 在 attempt 创建、attempt settled、apply steer 之后写这份工件。

然后让 control-api 和 dashboard 把它读出来，并把 degraded 状态直接露给 operator。

最后再补受控重写和 compact 逻辑，而不是一开始就做复杂压缩。

## 完成标准

第二阶段完成时，至少要看到这些结果。

- 任意一个 active run 都能直接指出当前 plan ref、当前 focus、最近 evidence refs 和 blocker
- working context 丢失或重写失败时，UI 和 API 会明确报 degraded
- handoff bundle 仍然是 settled 恢复唯一锚点，没有被 working context 偷偷替代
