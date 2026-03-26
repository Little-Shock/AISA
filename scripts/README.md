# Scripts

这个目录放最小验证脚本。

- `smoke-plan.ts`: 从 fixture goal 生成状态、事件和计划工件
- `verify-runtime.ts`: 回放 runtime 主套件，并锁住历史 contract 漂移体检的旧基线
- `verify-history-contract-drift.ts`: 只读扫描历史 execution attempt 的 contract 漂移，发现后以非零退出
- `verify-run-loop.ts`: 运行 run-centered runtime smoke cases，验证 loop、恢复和失败暴露语义
- `verify-drive-run.ts`: 验证本地 run driver 可以推进 run，并覆盖 execution sandbox 选择
- `verify-run-detail-api.ts`: 验证 `/runs/:runId` 会返回 attempt 的结果、判断和 runtime 验证证据
- `verify-worker-adapter.ts`: 验证 worker 非零退出时会把 stderr 里的根因带回阻塞信息
- `bootstrap-self-run.ts`: 生成并可直接启动一个面向当前仓库的 self-bootstrap run
- `drive-run.ts`: 不依赖 control-api，直接在本地推进一个 run，适合 self-bootstrap 和后端调试
- `verify-self-bootstrap.ts`: 验证 self-bootstrap 模板、seeded steer 和首个 attempt 的接线是否成立
