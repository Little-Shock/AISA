# Dashboard UI

职责：

- 作为 orchestration control plane 的前端可视化入口
- 展示 goal、branch、shared context、report 和 events
- 承接用户发起 steer、查看预算和状态的操作

当前边界：

- 现在只提供静态骨架页，用来固定信息架构和后续对接点
- 不在前端内实现调度、状态推进或 adapter 行为
