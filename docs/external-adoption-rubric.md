# External Adoption Rubric

这份 rubric 用来判断一个外部仓库接进 AISA 后，是否已经达到可用标准。

## Attach

通过标准：

- attach 能产出稳定的 `project_type`
- attach 能产出推荐 stack pack、默认 task preset、默认 verifier kit
- attach 能留下 baseline 和 capability snapshot 引用

不通过：

- 只能人工解释仓库类型，系统自己说不清
- 默认 pack / preset 要靠操作者猜
- attach 成功但没有可回读的 baseline 或 capability 证据

## Launch

通过标准：

- `/projects/:id/runs` 能直接创建 project-first run
- run 会继承 attached project、stack pack、task preset、verifier kit
- launch gate 是 fail-closed 的，缺关键 verifier 条件时必须明确阻断

不通过：

- attach 后还要手写一堆额外配置才能发车
- run 没有继承 attach 时的默认合同
- execution 在 verifier 不可重放时也被放行

## Triage

通过标准：

- run detail 首屏能看到 attached project、推荐 pack、capability、recovery guidance
- 典型失败模式能被明确说出来，不靠人猜
- 问题暴露在结构化字段里，不只在日志里

不通过：

- 项目画像只存在 attach 当时，run detail 看不到
- 错误只是一句泛化报错，没有 failure mode
- recovery guidance 不可读，或者只能靠人工翻状态文件

## Recovery

通过标准：

- 新 attach 的默认恢复路径是可重复回放的 `first_attempt`
- 仓库处在 degraded 状态时，恢复建议会跟着项目状态走
- generic repo 这类没有 verifier plan 的仓库，系统会保持 fail-closed，不会伪装成 ready

不通过：

- recovery path 依赖一次性人工演示
- degraded 项目没有明确恢复入口
- 系统靠 fallback 掩盖缺失的 replay plan

## Verification Discipline

通过标准：

- 至少有一条独立的 external repo smoke suite
- 这条 suite 覆盖 Node backend、Python service、Go service / CLI、repo maintenance
- 这条 suite 已经接进 `pnpm verify:runtime`

不通过：

- 只有内部仓库能证明功能成立
- 外部仓库验证只能手工跑一遍
- runtime 主回归没有把外部可用性当成硬门禁

## 当前建议

先跑 `pnpm verify:external-repo-matrix`，再跑 `pnpm verify:runtime`。

前者证明四类参考仓库成立。后者证明这套证明已经进入统一回归，不会悄悄失效。
