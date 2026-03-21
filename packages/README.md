# Packages

这个目录放系统核心模块。

第一批包只覆盖 `Milestone 0` 的基础能力：

- `domain`: 核心对象模型和 schema
- `state-store`: 文件系统状态存储
- `event-log`: NDJSON 事件日志
- `planner`: 把 goal 转成计划产物
- `worker-adapters`: Codex CLI worker 接入
- `context-manager`: 共享上下文与快照管理
- `judge`: 分支评分与推荐
- `report-builder`: current report 聚合
- `orchestrator`: branch 调度与状态推进
