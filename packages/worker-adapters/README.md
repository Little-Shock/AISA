# Worker Adapters

职责：

- 封装底层 worker 调用方式
- 当前 MVP 只实现 `codex` CLI adapter
- 所有 worker 统一继承控制面的 API 配置和环境变量

边界：

- adapter 只负责执行和标准化输出
- 不负责调度、评分、报告聚合
