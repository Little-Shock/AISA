# MVP 代码审查与调整建议

- 日期：`2026-03-23`
- 背景：对当前 Milestone 0 代码实现进行审查，对照 PRD 和 Implementation Blueprint 给出调整建议

## 1. 当前实现评价

### 做得好的部分

- **模块边界清晰**：`domain`、`state-store`、`event-log`、`orchestrator`、`planner`、`worker-adapters`、`context-manager`、`judge`、`report-builder` 完全对齐 PRD 的模块语言
- **文件系统优先**：状态、事件、产物全部落地为 JSON / Markdown / NDJSON，调试和观测非常直观
- **类型安全**：Zod schema 全覆盖，所有对象模型都有 parse 校验
- **单进程 Orchestrator**：MVP 阶段内嵌在 control-api 进程中，后台轮询调度，是正确的简化
- **闭环完整**：goal → plan → branch → worker → writeback → judge → report → dashboard 全链路可跑通

### 已完成的闭环能力

- 创建 goal
- 自动生成 3 branch 计划
- 排队派发 Codex CLI（`codex exec`）
- 收集 writeback 并解析
- 规则评分（4 维度）
- 更新共享上下文板
- 聚合当前最优报告
- Dashboard 展示全部状态
- 人工 steer 队列 + branch rerun

---

## 2. 需要调整的问题

### P0：补 Mock Adapter

> Blueprint 明确要求实现 `mock`、`codex`、`pi` 三个 adapter，但当前只有 `codex`。

没有 mock adapter 的后果：

- 本地开发和 CI 验证都依赖真实 Codex CLI + OpenAI API
- 无法在没有 API key 的环境下跑通闭环
- 开发循环太慢

建议：

- 实现一个 `MockWorkerAdapter`，返回固定的 writeback JSON
- 通过 `.env` 中的 `WORKER_ADAPTER_TYPE=mock` 切换

### P0：修复 `.env.example` 中的 Windows 路径

当前 `NEXT_PUBLIC_DEFAULT_WORKSPACE_ROOT=E:\00.Lark_Projects\36_team_research` 是 Windows 路径，在 macOS 上无法直接使用。

建议改为平台无关的占位符：

```
NEXT_PUBLIC_DEFAULT_WORKSPACE_ROOT=./
```

### P1：抽象 `WorkerAdapter` Interface

Blueprint 定义了统一接口：

```ts
interface WorkerAdapter {
  type: string
  startTask(taskSpecPath: string): Promise<{ runId: string }>
  pollStatus(runId: string): Promise<{ state: string }>
  injectContext(runId: string, steerPath: string): Promise<void>
  stopTask(runId: string): Promise<void>
  collectArtifacts(runId: string): Promise<string[]>
  normalizeOutput(runId: string): Promise<string>
}
```

但实际 `CodexCliWorkerAdapter` 只有一个 `runBranchTask` 方法，是同步阻塞式调用。如果后续要接 Pi 或其他异步 worker，会导致接口不兼容。

建议：

- 在 `packages/worker-adapters/src/index.ts` 中先定义统一 interface
- `CodexCliWorkerAdapter` 实现该 interface
- Mock adapter 也实现该 interface

### P1：补 SSE 推送

Dashboard 当前通过 4 秒 `setInterval` 轮询 `GET /goals/:goalId`，branch 执行期间体验较差。

Blueprint 明确推荐了 SSE，并预留了 `GET /stream/goals/:goalId` 端点。

建议：

- 在 control-api 补一个 SSE 端点
- Dashboard 端做渐进增强：优先用 SSE，fallback 到轮询

### P2：改善错误处理

control-api 中大量 `catch {}` 统一返回 404，例如：

```ts
} catch {
  return reply.code(404).send({ message: `Goal ${goalId} not found` });
}
```

这掩盖了真实错误（JSON 解析失败、文件权限、Zod 校验失败等）。

建议：

- 区分 "not found"（`ENOENT`）和 "internal error"
- 对 Zod 校验失败返回 400
- 对未知异常返回 500 并记录日志

### P2：补决策记录

`docs/decisions/` 目录当前是空的，但 AGENTS.md 明确要求关键决策要有记录。

至少应该补以下决策：

1. 为什么 MVP 选择 Codex CLI read-only 模式
2. 为什么 orchestrator 内嵌在 control-api 进程中
3. 为什么先不引入数据库

### P3：Planner 太硬编码

`generateInitialPlan` 写死了 3 个 branch，hypothesis 和 objective 也是固定中文文案。

建议至少做到：

- branch 数量可配置（通过 goal 的 budget.max_concurrency 控制）
- hypothesis/objective 能从 goal 的 description 和 success_criteria 中派生

---

## 3. 建议的下一步优先级

| 优先级 | 事项 | 原因 |
|--------|------|------|
| P0 | 补 Mock Adapter | 解除对真实 API 的开发依赖 |
| P0 | 修复 `.env.example` | 当前在 macOS 上默认路径不可用 |
| P1 | 抽象 `WorkerAdapter` interface | 为接 Pi 和其他 worker 做准备 |
| P1 | 补 SSE 推送 | 改善 Dashboard 实时体验 |
| P2 | 改善错误处理 | 减少调试成本 |
| P2 | 补决策记录 | 符合 AGENTS.md 约束 |
| P3 | Planner 智能化 | 提升计划生成质量 |

## 4. 不需要调整的部分

以下内容当前实现是合理的，不建议在 MVP 阶段改动：

- 文件系统存储策略（不要提前引入数据库）
- 单进程 orchestrator（不要提前引入分布式调度）
- 规则型 judge（不要提前引入 LLM judge）
- 单页面 dashboard（不要提前拆组件库）
- 中文 UI 文案（贴合目标用户）
