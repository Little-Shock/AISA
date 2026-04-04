# Troubleshooting

这份文档收的是最常见、最容易卡住推进节奏的问题。

原则只有两条：

1. 先确认是不是 scope 内问题。
2. 先用最窄的命令复现，不要直接跳到全量验证。

## Dashboard 打不开或没有数据

先确认两个进程都起来了：

```bash
pnpm dev
```

如果你是分开跑：

```bash
pnpm --filter @autoresearch/control-api dev
pnpm --filter @autoresearch/dashboard-ui dev
```

再确认默认地址：

- dashboard: `http://127.0.0.1:3000`
- control-api: `http://127.0.0.1:8787`

如果页面能开但数据是空的，优先检查：

- `NEXT_PUBLIC_CONTROL_API_URL`
- dashboard 的 `/api/control/*` 代理配置
- 当前 `runs/` 下是否真的有 run 数据

## `verify:run-api` 打红

先不要默认认定是 control-api 路由坏了。

优先排查顺序：

1. 先看是哪条断言失败，是 payload 字段、fixture 还是 route status。
2. 如果工作区是 mixed-scope，先确认是不是别的票把 summary / fixture 一起改了。
3. 再检查：
   - `apps/control-api/src/index.ts`
   - `scripts/verify-run-detail-api.ts`
   - 最近变更涉及的 fixture 生成脚本

## `verify:run-loop` 或 gate 相关验证打红

这类问题通常不是前端问题，先看：

- preflight gate 模式
- verifier readiness
- shadow dispatch / fail-closed 分支
- worker toolchain 是否可用

建议最小复现：

```bash
pnpm verify:run-loop
```

如果怀疑 runtime 也受影响，再补：

```bash
pnpm verify:runtime
```

## `/runs/self-bootstrap` 很慢

这条链路有时不是坏了，而是很重。

先区分两件事：

- 是真的返回错误码
- 还是返回成功但耗时很长

如果是性能慢但能过，先记成性能/解耦观察，不要直接把它记成当前票的 blocker。

优先再跑：

```bash
pnpm verify:self-bootstrap
```

## Runtime source drift / 要求重启

如果 control plane 明确提示 runtime source drift，需要优先接受这是保护机制，不是噪音。

这说明：

- 当前内存里的 runtime 与本地源码不一致
- 系统在阻止旧代码继续派发

处理顺序：

1. 保存当前必要变更
2. 重启相关进程
3. 再复跑最小验证

## Managed worktree 里缺本地 toolchain

这类问题常见于自举或 worker 恢复路径。

优先检查：

- `pnpm`
- Node 版本
- 当前 workspace root 是否在允许范围内
- 依赖是否安装完整

如果问题只发生在 managed worktree，不要先改业务逻辑，先确认环境和路径策略。

## 类型检查过了，但 surface verify 还在红

这通常说明问题不在类型层，而在：

- fixture 断言过时
- summary surface 新增字段没有在 verify 里补齐
- 前后端都能编译，但字段语义没对齐

这时候直接去看：

- 对应 verify 脚本
- fixture 生成脚本
- UI / API 之间的 payload shape

## 什么时候该开独立票

满足下面任一条，就不要继续混在当前票里：

- 红点不在当前 diff scope 内
- 修复需要跨 backend / frontend / runtime 三层一起改
- 同一个症状可能是性能问题，不是当前功能回归

一旦拆票，就在 review 里明确写清「当前票修了什么，没有修什么」。
