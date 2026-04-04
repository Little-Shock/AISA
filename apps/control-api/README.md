# Control API

职责：

- 提供 `goal` 创建、查询、计划生成等命令入口
- 暴露后续 dashboard 读取所需的基础查询接口
- 在 MVP 中同进程托管 `orchestrator`，形成最小执行闭环

当前输入：

- HTTP 请求
- `state/`、`events/`、`plans/` 下的文件
- `.env` 中的统一 Codex / API 配置

当前输出：

- JSON 响应
- 对应的状态文件和事件日志
- branch launch、steer、rerun 等命令会驱动后台 orchestrator 推进

当前还额外承担两类入口：

- `run` 级入口，比如创建、启动、读取和恢复
- project attach / project-first run 入口，用来把外部仓库先收成 project profile、baseline snapshot、capability snapshot，并从 attached project 直接创建 run
