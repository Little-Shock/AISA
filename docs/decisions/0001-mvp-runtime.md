# 0001 - MVP Runtime Uses Codex CLI Workers And In-Process Orchestrator

## 背景

PRD 强调第一阶段应优先跑通：

- `dashboard`
- `orchestrator`
- `shared context`
- `steer`
- `eval / judge`

同时明确：

- 文件系统优先于复杂基础设施
- 先做可运行、可观察、可复盘的最小闭环
- 优先复用现有 agent，而不是自研 worker runtime

## 决策

MVP 采用以下实现：

1. 底层 worker 统一使用 `Codex CLI`
2. `control-api` 在同一进程内启动 `orchestrator`
3. worker 统一继承同一套 `.env` 中的 API provider 配置
4. worker 默认以 `read-only` 模式运行
5. 运行时状态以 `JSON + Markdown + NDJSON + 文件系统目录` 为主

## 为什么这样做

- 复用现有 `Codex CLI` 可以最快形成真实 branch 执行闭环
- 同进程 orchestrator 可以减少队列、锁和分布式协调复杂度
- 统一 `.env` 能确保所有 branch worker 使用一致的 provider / model 配置
- read-only worker 更符合当前 MVP 对“多分支探索”和“可观察收敛”的目标，避免共享 working tree 下的并发写冲突

## 影响

正面影响：

- 很快就能跑通 `goal -> branch -> codex worker -> writeback -> judge -> report`
- 本地排障简单，产物可直接在仓库中查看
- worker 行为一致，减少 provider 配置漂移

当前代价：

- 暂不支持安全的多 branch 并发代码改写
- dashboard 先用轮询而不是流式推送
- orchestrator 横向扩展不是当前目标

## 后续

后续如果需要支持真正的并发代码分支执行，应引入：

- branch 级工作副本
- 更强的 worker 隔离
- 更明确的 merge / conflict 策略
