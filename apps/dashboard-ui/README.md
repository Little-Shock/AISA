# Dashboard UI

职责：

- 作为 orchestration control plane 的前端可视化入口
- 以 `run-centered` 视角展示运行池、介入队列、尝试证据、恢复提示和运行报告
- 兼容展示旧的 `goal / branch / shared context / report / events` 视图
- 承接用户查看状态、识别卡点和发起 steer 的操作

当前边界：

- 当前已经接入 `/runs`、`/runs/:id` 和 `/runs/:id/stream`，不是静态骨架页
- 运行台优先服务 operator：先暴露 blocked reason、intervention need、recovery hint，再看 legacy goal 面板
- run detail 已按 operator 视角拆成 overview / attempt timeline / report / journal 等面板，避免主页面继续膨胀
- run detail 现在支持直接提交 `run steer`，把人工干预落到单条 run，而不是只能停留在 goal 级别
- run detail 也把 verification lane 抬到前面，直接显示 replay readiness、运行时回放结果和证据缺口
- run inbox 现在支持两阶段筛选：先按运行状态分组，再按 waiting human / replay gap / runtime fault / unstarted 等 operator lens 缩小范围
- run inbox 还补了一层 operator presets，把常见 triage 组合做成一键入口，减少频繁切换 filter / lens
- run inbox 会显式展示当前 preset / slice 在看什么，并在每条 run 卡片上标出命中当前视角的原因，减少 operator 来回切换详情确认
- run inbox 现在还会按 operator urgency 自动排序，把人工接球、runtime 故障、回放债务、冷启动等优先级直接前置到列表层
- run inbox 的摘要文本已开始接入 `@chenglou/pretext`，通过 `prepareWithSegments / layoutWithLines` 按真实宽度和字体做多行裁剪，减少靠字符数硬截断带来的跳动
- 前端会基于现有运行摘要推导 signal badges 和 operator checklist，帮助快速判断先看哪里
- 基础 UI primitive 已开始从 `globals.css` 抽离到组件级 CSS Module，后续会继续把页面级布局和业务卡片样式分层
- 前端只做观测、筛选、展示和用户操作，不在浏览器内实现调度、状态推进或 adapter 行为
