# Scripts

这个目录放最小验证脚本。

- `smoke-plan.ts`: 从 fixture goal 生成状态、事件和计划工件
- `verify-runtime.ts`: 回放 runtime 主套件，覆盖 run loop、run detail API、control-api supervisor、self-bootstrap 主链，并要求历史 contract 漂移已修复为零
- `verify-judge-evals.ts`: 单跑 judge/evals 小矩阵，覆盖 `evaluateBranch`、`evaluateAttempt`、CLI reviewer/synthesizer 接线，以及 failed runtime / failed-or-missing adversarial verification 的 hard-gate 回归
- `verify-evaluator-calibration.ts`: 验证 settled attempt 会产出 evaluator calibration sample，maintenance plane 能读到它，export 脚本会刷新 online samples manifest，固定 false positive 和 false negative 回归位齐全
- `verify-control-api-supervisor.ts`: 验证 control-api supervisor 会在子进程请求重启后自动拉起新实例
- `verify-history-contract-drift.ts`: 只读扫描历史 execution attempt 的 contract 漂移，发现后以非零退出
- `repair-history-contract-drift.ts`: 显式修复历史 execution attempt 的 contract 和 review packet 漂移
- `verify-history-contract-drift-repair.ts`: 在临时工作区里验证历史漂移修复脚本会先报错、再修复、再归零
- `verify-run-loop.ts`: 运行 run-centered runtime smoke cases，验证 loop、恢复和失败暴露语义
- `verify-drive-run.ts`: 验证本地 run driver 可以推进 run，并覆盖 execution sandbox 选择
- `verify-run-detail-api.ts`: 验证 `/runs/:runId` 会返回 attempt 的 context、failure_context、结果、判断和 runtime 验证证据，也覆盖 project attach、baseline、capability snapshot、project-first run create 和 attached launch gate
- `verify-worker-adapter.ts`: 验证 worker 非零退出时会把 stderr 里的根因带回阻塞信息
- `export-evaluator-calibration.ts`: 从 runtime workspace 导出 evaluator calibration sample 到 `evals/runtime-run-loop/datasets/calibration/online-samples/`，并刷新 manifest
- `bootstrap-self-run.ts`: 生成并可直接启动一个面向当前仓库的 self-bootstrap run
- `supervise-self-bootstrap.ts`: 监督当前 self-bootstrap run，自动修复常见卡点，并在需要时切到新的 self-bootstrap run
- `drive-run.ts`: 不依赖 control-api，直接在本地推进一个 run，适合 self-bootstrap 和后端调试
- `verify-self-bootstrap.ts`: 验证 self-bootstrap 模板、seeded steer 和首个 attempt 的接线是否成立
