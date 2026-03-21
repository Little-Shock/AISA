# State Store

职责：

- 维护 `state/` 与 `plans/` 下的结构化文件
- 提供按 goal 组织的目录约定
- 负责基础 JSON / Markdown 工件的读写

边界：

- 不负责事件追加
- 不负责调度推进
- 不负责业务评估逻辑
