# Run Lifecycle

这份文档解释 AISA 最核心的一条主链:

`run -> attempt -> verification -> review -> next decision`

如果你只想先记住一句话:

- `Run` 是一条持续推进的任务。
- `Attempt` 是这条任务的一轮正式尝试。
- 每一轮尝试都必须留下可以复盘的证据，而不是只留一段聊天记录。

## 1. Run 和 Attempt 分别是什么

### Run

`Run` 表示一条持续推进的目标，例如“把某个 feature 做完并验证通过”。

它跨越多轮执行，所以系统需要长期保存:

- 当前目标和约束
- 当前最可信的决策
- 最新 handoff
- working context
- 历史 attempts 与验证结果

### Attempt

`Attempt` 表示围绕当前 run 发起的一轮具体尝试。一次 attempt 通常会包含:

- 输入 contract
- preflight / readiness 检查
- 实际执行
- runtime verification
- adversarial verification
- review / synthesis
- handoff bundle

## 2. 一轮 Attempt 的标准流程

```text
attempt contract
  -> preflight
  -> execution
  -> runtime verification
  -> adversarial verification
  -> review / synthesis
  -> handoff bundle
  -> next decision
```

### Attempt Contract

这一层先定义“这一轮准备做什么”。它应该把目标、写入范围、风险、验证门讲清楚，避免模型无边界扩写。

### Preflight

preflight 用来在真正执行前先判断:

- 当前输入是否足够
- 依赖是否满足
- 这轮执行是否应该直接 fail-closed

如果未来升级到 shadow dispatch，这里还会更像“先演练再放行”的机制。

### Execution

执行一般发生在独立 worktree / adapter 环境里，不直接把主工作区当作试验场。

### Runtime Verification

runtime verification 回答的是:

- 代码在最基本层面上是不是还能跑
- 关键 surface 有没有被改坏

它更偏回归和可运行性，而不是从对抗角度找洞。

### Adversarial Verification

这层故意尝试“把它搞坏”，目标不是证明 happy path，而是尽量在交付前找出:

- 漏掉的失败路径
- 过时断言
- scope 外副作用
- 只在真实运行时才会暴露的脆弱点

### Review / Synthesis

review 不只是一句“看起来没问题”，而是要把观察、finding、证据和风险压成结构化结论。需要时可由多 reviewer 并行，再由 synthesizer 收口。

### Handoff Bundle

handoff bundle 是下一轮接手时要看的最小真相包。它关心的是:

- 这轮做了什么
- 有哪些证据成立
- 哪些问题还没解
- 下一轮最建议先做什么

## 3. Handoff 和 Working Context 的区别

这两个概念经常被混淆，但职责不同:

| Concept | Responsibility |
| --- | --- |
| Handoff Bundle | 交接摘要，告诉下一轮“发生了什么、该从哪接着做” |
| Working Context | 现场保持，保留长期上下文、当前活跃事实、恢复所需背景 |

可以把 handoff 理解成交班摘要，把 working context 理解成值班台的持续现场。

## 4. 为什么要两层验证

如果只做一种 verify，系统很容易出现两类问题:

- 只看类型和 happy path，交付后才发现真实运行红点
- 只靠 reviewer 主观判断，没有稳定的自动回归入口

所以 AISA 把验证拆成两层:

- runtime verification: 证明核心链路没有立刻坏掉
- adversarial verification: 主动寻找隐藏风险和脆弱边界

## 5. 一轮 Run 最后会留下什么

围绕 run / attempt，系统会逐步留下:

- run brief
- current decision
- preflight evaluation
- execution artifacts
- runtime verification results
- adversarial verification results
- review packet
- handoff bundle
- working context / active snapshot

dashboard 和 control-api 的价值，就是把这些散落工件重新组织成 operator 能快速理解的 surface。

## 6. 现在的主线收敛方向

当前阶段主要在继续收敛:

- preflight evaluation / handoff summary surface
- handoff-first auto-resume 与 degraded path
- working-context preservation 与 active snapshot surfacing
- shadow dispatch 与 verifier readiness fail-closed
- operator brief、failure class 和 adversarial verifier gate

具体模块边界见 [`architecture.md`](./architecture.md)，术语定义见 [`glossary.md`](./glossary.md)。
