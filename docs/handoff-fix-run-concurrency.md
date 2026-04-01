# Handoff: 修复 Orchestrator Run 并发失控

## 背景

AISA 系统由三层组成：

1. **`supervise-self-bootstrap.ts`** (`scripts/supervise-self-bootstrap.ts`) — 外层 supervisor，每 15s 一个 cycle，管理 `state.active_run_id`，当 run 完成或卡死时 rotate 到新 run
2. **`control-api`** (`apps/control-api/src/index.ts`) — Fastify HTTP 服务，内嵌一个 `Orchestrator` 实例
3. **`Orchestrator`** (`packages/orchestrator/src/index.ts`) — 核心 tick 循环（每 1.5s），扫描所有 run 和 goal，dispatch codex 进程执行 attempt

## 问题

Orchestrator 的 `tickRuns()` 方法遍历 **所有** `status=running` 的 run，为每个有 pending attempt 的 run 无条件 dispatch 一个 codex 进程。没有全局并发上限。

实际发生的情况：supervisor 不断 rotate 创建新 run，旧 run 被 auto_resume 重新设为 running，Orchestrator 对每个 run 都 dispatch codex → 同时启动 25+ 个 codex 进程，消耗 50%+ CPU 和 9.4% 内存。

## 根因分析

### Orchestrator 已有的并发保护（都不够）

| 机制 | 位置 | 作用 | 为什么不够 |
|------|------|------|-----------|
| `activeAttempts` Set | Orchestrator 构造函数初始化 | 内存级去重，防止同一个 attempt 被重复 dispatch | 只防重复，不限制总量；且只在同进程内有效 |
| `run-dispatch-lease.json` | `tryAcquireRunDispatchLease()` | 文件级 per-run 互斥锁，跨进程有效 | 只防止同一个 run 被并发 dispatch，不防跨 run 并发 |
| `tickPromise` | `tick()` 方法 | 防同一个 Orchestrator 实例并发执行 tick | 每个 tick 内会扫完所有 run，一个 tick 内就能 dispatch 25+ 个 |

### Goal/branch 体系有并发控制，Run 体系没有

Goal/branch 在 `tickInternal()` 里有限制：
```typescript
const availableSlots = Math.max(0, goal.budget.max_concurrency - runningCount);
for (const branch of queuedBranches.slice(0, availableSlots)) { ... }
```

但 Run 体系的 `tickRuns()` 完全没有类似检查。`max_concurrency: 3` 只存在于 run 的 contract.json 中作为元数据，Orchestrator 从未读取它来限制自身行为。

### 为什么不需要额外排队机制

attempt 已经有 `created`/`queued` 状态，tick 每 1.5s 循环一次。超出上限的 attempt 留在原状态，下轮 tick 自然会检查。现有状态机本身就是队列。

## 改动规格

### 文件 1: `packages/orchestrator/src/index.ts`

#### 改动 A: 在 `OrchestratorOptions` 接口增加字段

位置：`OrchestratorOptions` 接口定义（约 line 174-192）

在 `runtimeLayout?: RuntimeLayout | null;` 之后增加：

```typescript
/** 全局最大同时执行的 attempt 数。默认 3，可通过 AISA_MAX_CONCURRENT_ATTEMPTS 环境变量覆盖。 */
maxConcurrentAttempts?: number;
```

#### 改动 B: 在 `Orchestrator` 类增加字段和赋值

位置：`Orchestrator` 类的 private 字段声明区域（约 line 453-474）

增加字段声明：

```typescript
private readonly maxConcurrentAttempts: number;
```

位置：构造函数体（约 line 476-543）

在 `this.instanceStartedAtMs = Date.now();` 之前增加：

```typescript
this.maxConcurrentAttempts =
  options.maxConcurrentAttempts ??
  readPositiveIntegerEnv("AISA_MAX_CONCURRENT_ATTEMPTS", 3);
```

#### 改动 C: 在 `tickRuns()` 中加全局上限检查

位置：`tickRuns()` 方法（约 line 901-999）

在 for 循环体内部，dispatch pending attempt 之前（约 line 978-990 区域），当前代码是：

```typescript
if (pendingAttempt) {
  const alignedAttempt = await this.ensureAttemptUsesRunWorkspace(
    run,
    pendingAttempt
  );
  const activeKey = this.getActiveAttemptKey(run.id, pendingAttempt.id);
  if (!this.activeAttempts.has(activeKey)) {
    this.activeAttempts.add(activeKey);
    void this.executeAttempt(run.id, alignedAttempt.id).finally(() => {
      this.activeAttempts.delete(activeKey);
    });
  }
  continue;
}
```

改为：

```typescript
if (pendingAttempt) {
  if (this.activeAttempts.size >= this.maxConcurrentAttempts) {
    continue; // 全局并发已满，本轮跳过，attempt 留在 created/queued 状态等下轮 tick
  }
  const alignedAttempt = await this.ensureAttemptUsesRunWorkspace(
    run,
    pendingAttempt
  );
  const activeKey = this.getActiveAttemptKey(run.id, pendingAttempt.id);
  if (!this.activeAttempts.has(activeKey)) {
    this.activeAttempts.add(activeKey);
    void this.executeAttempt(run.id, alignedAttempt.id).finally(() => {
      this.activeAttempts.delete(activeKey);
    });
  }
  continue;
}
```

同样，在 `createNextAttemptIfNeeded` 调用前（约 line 997）也要加检查：

当前代码：

```typescript
if (this.hasActiveAttemptForRun(run.id)) {
  continue;
}

await this.createNextAttemptIfNeeded(run.id);
```

改为：

```typescript
if (this.hasActiveAttemptForRun(run.id)) {
  continue;
}

if (this.activeAttempts.size >= this.maxConcurrentAttempts) {
  continue;
}

await this.createNextAttemptIfNeeded(run.id);
```

注意：这里用 `continue` 而不是 `break`，因为后面的 run 可能有已经在跑的 attempt 需要被 `recoverRunningAttempt` 处理。`pendingAttempt` 那个分支也可以用 `continue`，因为 for 循环开头的 `recoverRunningAttempt` 不受这个限制（它是恢复已有 attempt，不是新 dispatch）。

### 文件 2: `apps/control-api/src/index.ts`

#### 改动: 透传 `maxConcurrentAttempts` 配置

位置：`buildServer()` 函数中构建 `Orchestrator` 实例处（约 line 206-210）

当前代码：

```typescript
orchestrator = new Orchestrator(workspacePaths, adapter, undefined, undefined, {
  runWorkspaceScopePolicy,
  requestRuntimeRestart,
  runtimeLayout
});
```

改为：

```typescript
orchestrator = new Orchestrator(workspacePaths, adapter, undefined, undefined, {
  runWorkspaceScopePolicy,
  requestRuntimeRestart,
  runtimeLayout,
  maxConcurrentAttempts: readPositiveIntegerEnv("AISA_MAX_CONCURRENT_ATTEMPTS", 3)
});
```

注意：`readPositiveIntegerEnv` 已在本文件底部定义（约 line 1244-1248），可以直接使用。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AISA_MAX_CONCURRENT_ATTEMPTS` | `3` | 全局最大同时执行的 attempt 数。3 个 codex 大约占 120-150MB 内存、10-15% CPU |

## 验证方式

1. 启动 control-api + supervisor
2. `ps aux | grep 'codex exec' | grep -v grep | wc -l` — 应不超过 `AISA_MAX_CONCURRENT_ATTEMPTS` 的值
3. 检查 Orchestrator 日志，被跳过的 run 不会报错，attempt 留在 `created`/`queued` 状态
4. 1.5s 后下轮 tick 会自动尝试 dispatch（如果此时有空位）
5. 可选：设 `AISA_MAX_CONCURRENT_ATTEMPTS=1` 测试严格串行模式

## 不在本次范围

- 不需要改 `supervise-self-bootstrap.ts`
- 不需要改 run 的 `contract.json` 或 `max_concurrency` 字段
- 不需要新建队列数据结构
- 不需要改 Goal/branch 体系（已有并发控制）
