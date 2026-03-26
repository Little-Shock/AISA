# 0002 - Runtime Source Drift Requires Restart Before Next Dispatch

## 背景

`0001` 已确认 `control-api` 和 `orchestrator` 在同一进程内运行。

这带来一个新的运行时风险：

- execution 可能会直接改到当前进程已经加载的运行时代码
- 进程内存里的实现还没刷新，但 loop 可能继续自动派发下一轮
- 这样会让 run 状态、review packet 和真实执行代码发生漂移

## 决策

当 execution 留下的 git 新增改动命中当前同进程 runtime 已加载的核心源码时，loop 不再自动继续派发下一次 attempt。

当前先把下面这些源码目录视为同进程 live runtime：

- `apps/control-api/src/`
- `packages/context-manager/src/`
- `packages/domain/src/`
- `packages/event-log/src/`
- `packages/judge/src/`
- `packages/orchestrator/src/`
- `packages/planner/src/`
- `packages/report-builder/src/`
- `packages/state-store/src/`
- `packages/worker-adapters/src/`

命中后，run 会停在 `waiting_steer`，并明确记录需要重启、受影响文件和阻塞原因。

## 为什么这样做

- 同进程 runtime 改了自己以后，继续自动派发最容易用旧内存代码跑出假通过
- 显式停住比偷偷续跑安全，也更符合 PRD 里的可观察、可复盘原则
- 先用文件路径护栏实现最小闭环，成本低，回归也容易稳定复现

## 影响

- execution 改到 live runtime 源码后，current decision 会保留下一步意图，但等待重启
- run journal 和 review packet 会留下 restart-required 证据
- 自动续跑不会跨过这条护栏
