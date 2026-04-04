# Verify Cookbook

这份文档只回答一个问题：你现在该跑哪条验证命令。

如果没有特殊原因，先从最窄的验证开始，不要一上来就跑全量。

## 最常用的命令

### 全仓基础检查

```bash
pnpm typecheck
```

适用场景：

- 改了跨包类型、接口或共享 schema
- 想先确认 workspace 没有明显类型断裂

### Runtime 主回归

```bash
pnpm verify:runtime
```

适用场景：

- 改了 runtime、orchestrator、状态推进逻辑
- 想确认关键回归和 runtime health snapshot 还站得住

### Run detail / control-api surface

```bash
pnpm verify:run-api
```

适用场景：

- 改了 `apps/control-api`
- 改了 run detail payload、summary surface、brief / handoff / preflight 返回结构
- 改了 project attach / baseline / capability snapshot / project-first run create / attached launch gate / stack pack / task preset / project-aware recovery guidance 这类外部项目接入 surface

### External repo matrix

```bash
pnpm verify:external-repo-matrix
```

适用场景：

- 改了外部项目 attach、project-first run create、默认 pack / preset 继承
- 改了 Node backend、Python service、Go service / CLI、repo maintenance 这四类参考仓库的识别或恢复语义
- 想确认外部可用性不是只对 AISA 自己成立

### Run loop / dispatch / gate

```bash
pnpm verify:run-loop
```

适用场景：

- 改了 preflight gate、dispatch、worker readiness、shadow dispatch
- 改了 orchestrator 中 attempt 放行或阻断逻辑
- 改了 attached project 默认 execution contract fallback

### Dashboard control surface

```bash
pnpm verify:dashboard-control-surface
```

适用场景：

- 改了 dashboard 首页、run detail 首屏、operator brief 展示
- 改了 project-first run detail，比如 attached project、stack pack、task preset、capability、recovery path 这些首屏信息
- 改了 UI 对 run summary / run detail 的关键读取顺序

### Dashboard steer surface

```bash
pnpm verify:dashboard-run-steer
```

适用场景：

- 改了 run steer 提交入口
- 改了前端 steer 表单、状态或交互条件

### Self-bootstrap

```bash
pnpm verify:self-bootstrap
```

适用场景：

- 改了自举入口、监督脚本、managed worktree 恢复逻辑
- 改了 `/runs/self-bootstrap` 相关链路

### Judge / evals

```bash
pnpm verify:judge-evals
```

适用场景：

- 改了 judge、evals、adversarial-verification、verify matrix

## 按改动范围选命令

### 改了 control-api / summary surface

建议顺序：

1. `pnpm --filter @autoresearch/control-api typecheck`
2. `pnpm verify:run-api`
3. 如果改动影响外部项目接入，再补 `pnpm verify:external-repo-matrix`
4. 如果改动影响 run 推进，再补 `pnpm verify:run-loop`

### 改了 orchestrator / runtime gate

建议顺序：

1. `pnpm --filter @autoresearch/orchestrator typecheck`
2. `pnpm verify:run-loop`
3. `pnpm verify:runtime`

### 改了 dashboard 首屏 / operator surface

建议顺序：

1. `pnpm --filter @autoresearch/dashboard-ui typecheck`
2. `pnpm verify:dashboard-control-surface`
3. 如果同时改了 project-first detail 的 API 字段，再补 `pnpm verify:run-api`
4. 如果改了 steer，再补 `pnpm verify:dashboard-run-steer`

### 改了 self-bootstrap / 监督逻辑

建议顺序：

1. `pnpm verify:self-bootstrap`
2. `pnpm verify:runtime`

### 改了 reviewer / judge / evals

建议顺序：

1. `pnpm verify:judge-evals`
2. `pnpm verify:evaluator-calibration`

## Review 前的最小建议

### Backend 票

至少补：

- 相关包 `typecheck`
- 与改动最贴近的一条 verify

### Frontend 票

至少补：

- `@autoresearch/dashboard-ui` 的 `typecheck`
- 与 surface 对应的 verify 脚本

### Cross-cut 票

不要只跑一条 happy-path。

至少要补：

- 一条主验证
- 一条相邻链路验证
- 一条负向或 fail-closed probe

## 跑红后先看哪里

- 如果是 command 级报错：
  - 先看脚本名，再回到对应模块排查
- 如果是 payload 断言不一致：
  - 先检查 schema / summary surface / fixture 是否一起变了
- 如果是 mixed-scope worktree 红点：
  - 先确认是不是别的票的变更混进来了

更详细的排障顺序见 [`troubleshooting.md`](./troubleshooting.md)。
