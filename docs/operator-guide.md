# Operator Guide

这份文档写给需要盯盘、接球、判断下一步的人。

如果只记一句话：AISA 不是聊天窗口，而是一套让 AI 持续做事、持续验证、持续交接的控制台。

## 先记 4 个词

- `run`
  - 一条持续推进的任务
- `attempt`
  - AI 为这条任务做的一次具体尝试
- `preflight`
  - 真正执行前的门禁检查，决定这次尝试能不能放行
- `handoff`
  - 当前这轮做完后，留给人或下一轮 AI 的交接包

## 你在 dashboard 上最该先看什么

### 1. 这条 run 现在要不要人工接球

优先看：

- `waiting_for_human`
- run brief 里的接球态
- 当前 blocking reason

最常见的读法：

- `接球：需要人工`
  - 说明系统判断这轮不该自动继续推进，需要人决定下一步
- `接球：自动推进`
  - 说明系统仍在可自动运行的区间

### 2. 是哪里卡住了

优先看：

- `failure class`
- `failure code`
- preflight summary
- handoff summary

可以先按这个心智模型理解：

- `preflight_blocked`
  - 不是执行已经跑坏，而是执行前就被门禁拦住了
- `runtime fault`
  - 执行过程中出了故障
- `replay gap`
  - 证据、回放契约或验证工件不完整

### 3. 下一步建议是什么

优先看：

- `recommended_next_action`
- `recommended_attempt_type`
- run brief 的 `焦点` / `下一步`

如果 brief、handoff、current decision 三者不完全一致，先以最新的 handoff 和 current decision 为准，再回看 journal。

## 一个最实用的 triage 顺序

1. 先在首页看这条 run 是否需要人工接球。
2. 进入 run detail，先读 run brief，不要先钻 journal。
3. 再看 preflight summary 和 handoff summary，确认是门禁拦截、运行故障还是证据缺口。
4. 确认 recommended next action。
5. 只有在需要追因时，再往下翻 attempt timeline、report、journal 和 artifacts。

如果这条 run 来自外部项目，再多加一步：

- 先看 `先看项目上下文`
- 再看 `项目能力与恢复`

这两块会先告诉你这是什么项目、当前默认 pack / preset 是什么、现在还能不能发车、恢复该走哪条路。先把这层看清，再去读 handoff 和 journal，效率会高很多。

## 常见信号的人话翻译

- `preflight required`
  - 这轮执行前还有硬门没过
- `adversarial gate required`
  - 对抗验证还没补齐，不能把这轮当成可放心交付
- `run brief degraded`
  - 简报不是最新鲜的快照，要同时参考 handoff 和 current decision
- `working context degraded`
  - 当前上下文快照可能有点旧，重要决策别只看这一处

## 什么时候应该人工介入

出现下面任一类情况时，不要期待系统自己“猜对”：

- brief 明确说 `接球：需要人工`
- preflight 已 fail-closed
- failure class 已经明确，但 next action 仍不清楚
- 你需要改 run 目标、边界、优先级或验收标准

如果是外部项目，再补一条：

- `项目能力与恢复` 已经显示 `阻塞` 或 `降级重建`

## 介入前最好先确认的 5 件事

1. 这次失败是发生在 preflight、runtime 还是 postflight。
2. 当前 latest attempt 有没有留下完整工件。
3. handoff 里推荐的 next action 是什么。
4. brief 里的 `焦点` 是否仍然和你要解决的问题一致。
5. 这条 run 是该继续 execution、改成 research，还是先停下来等人。

如果 run 来自外部项目，把这 5 件事替换成更短的项目版顺序也行：

1. 这是什么项目，选中的 stack pack 和 task preset 是什么。
2. capability snapshot 对 `research` 和 `execution` 分别怎么判。
3. recovery path 是 `first_attempt`、`handoff_first` 还是 `degraded_rebuild`。
4. baseline ref、关键文件 ref、latest settled evidence ref 是否都还在。
5. 当前是缺环境、缺基线、缺 handoff，还是单纯需要人工改目标。

## 下一步看哪里

- 想知道该跑什么验证：
  - 看 [`verify-cookbook.md`](./verify-cookbook.md)
- 遇到红点想先排障：
  - 看 [`troubleshooting.md`](./troubleshooting.md)
- 想系统理解对象和主链：
  - 看 `run-lifecycle` 与 `architecture`
