# Event Log

职责：

- 将关键系统动作追加到 `events/goals/<goal_id>.ndjson`
- 提供按 goal 查询事件的基础能力

边界：

- 只负责事件事实流，不负责状态聚合
- 不推断业务状态，读取方自行解释事件
