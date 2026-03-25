# 两份计划交叉审查：Claude vs Codex

- 日期：`2026-03-24`
- 输入文件：
  - Codex: [2026-03-23-aisa-plan-adjustments.md](file:///Users/atou/AISA/Codex/2026-03-23-aisa-plan-adjustments.md)
  - Claude: [2026-03-23_mvp-review-and-adjustments.md](file:///Users/atou/AISA/Claude/2026-03-23_mvp-review-and-adjustments.md)

---

## 1. 共识点

两份计划在以下方面完全一致，可以视为已确认的方向：

| 共识 | Claude 表述 | Codex 表述 |
|------|-------------|------------|
| 主线正确 | 模块边界清晰，闭环完整 | 三个最值钱的判断（control plane、文件系统优先、steer 是主路径）是对的 |
| Planner 需要升级 | P3：太硬编码，写死 3 branch | 从模板生成器升级为会看任务类型的调度层 |
| Judge 需要升级 | 规则评分 MVP 够用，后续要改 | Judge 评的是输出形状，不是任务结果，必须更多依赖 success criteria |
| 不要过早扩展 | 明确列出"不需要调整的部分" | "最不该做的是继续往文档里加大词" |
| Worker Adapter 需要抽象 | P1：抽象 WorkerAdapter Interface | 先补 worker contract，固定三类 branch 的输入输出 schema |

## 2. 分歧与互补

### 2.1 关注层次不同

这是两份计划最核心的差异。

- **Claude 的视角是工程基建层**：Mock Adapter、.env 修复、SSE、错误处理、决策记录。关注的是"让现有代码跑得更稳"。
- **Codex 的视角是产品策略层**：场景收窄、branch 分类（research / execution / verification）、黄金路径定义、V1 Definition of Done。关注的是"让系统变成真正可用的东西"。

**判断：两者互补，不冲突。** Codex 在回答"下一步该做什么"，Claude 在回答"当前代码该怎么修"。一个项目同时需要两层思考。

### 2.2 Mock Adapter 的优先级

- **Claude**：P0，排在最前面。理由是解除对真实 API 的开发依赖。
- **Codex**：没有专门提 Mock Adapter，而是把 worker contract 作为整体来看。

**判断：Claude 的 P0 判断是对的。** 但 Codex 的思路更完整——不只是补一个 mock，而是先定义三类 branch contract，然后 mock 只是其中一个实现。建议合并：**先定义 WorkerAdapter interface + branch type enum，再实现 mock adapter**。

### 2.3 Branch 分类

- **Claude**：没有提到 branch 分类。
- **Codex**：明确提出三类 branch——research（只读归纳）、execution（可写改代码）、verification（复核结论），并认为这是后续 planner/judge/预算控制的基础。

**判断：Codex 的这个观点是这两份计划中最有增量价值的。** 当前代码所有 branch 都是同质的 read-only research，这在 MVP 阶段够用，但只要想往工程任务方向走一步，branch 分类就会变成硬性前置条件。建议尽快把 branch type 加进 `domain` schema，即使 MVP 只实现 `research` 类型。

### 2.4 场景收窄 vs 功能补全

- **Claude**：按功能点逐条列优先级（Mock → .env → Interface → SSE → 错误处理 → 决策记录）。
- **Codex**：认为最该做的是"缩窄第一阶段的承诺"，先只服务一种任务类型，打穿黄金路径。

**判断：Codex 的方向更对。** Claude 的建议都是正确的技术改进，但如果没有先定义"打穿什么场景"，这些改进可能会延缓真正的产品验证。建议先用 Codex 的思路确定黄金路径，再按 Claude 的优先级做技术补全。

### 2.5 Dashboard 方向

- **Claude**：补 SSE 改善实时体验。
- **Codex**：从总览优先改成 run page 优先——用户大部分时间关心的是单个 goal 当前状态，不是全局统计。

**判断：两者都需要做，但 Codex 的 UI 方向更有价值。** SSE 只是传输机制，run page 才是用户体验的核心改进。

### 2.6 V1 Definition of Done

- **Claude**：没有定义。
- **Codex**：给出了非常具体的完成标准——"针对一个真实仓库任务，系统能自动生成合适的 branch 组合，其中至少一条 branch 能执行真实动作并留下完整证据，人工 steer 能在下一轮明确生效，judge 的结论和 evidence 能对得上，最终 report 不是摘要拼接，而是能支持下一步开发决策。"

**判断：这份 DoD 非常有价值，应该直接采纳。**

## 3. 综合建议：合并后的优先级

结合两份计划，建议按以下顺序推进：

### Phase 1：定义黄金路径（Codex 的思路）

1. 确定第一个打穿的场景（建议：对本地代码仓库发起研究分析任务）
2. 把 Codex 的 V1 DoD 写入 `docs/decisions/`
3. 在 `domain` 中增加 `branch_type: research | execution | verification`（MVP 只实现 `research`）

### Phase 2：补技术基建（Claude 的思路）

4. 定义 `WorkerAdapter` interface
5. 实现 `MockWorkerAdapter`
6. 修复 `.env.example` 中的 Windows 路径
7. 改善 control-api 错误处理

### Phase 3：升级核心模块（两者共识）

8. Planner：至少支持两种策略（research / engineering）
9. Judge：评估结果对齐 success criteria，不只看输出形状
10. Dashboard：从总览优先改成 run page 优先
11. 补 SSE 推送

### Phase 4：扩展能力（暂缓）

12. Execution branch（可写工作区）
13. Verification branch
14. Trigger engine
15. 长期记忆

## 4. 对两份计划的总结评价

| 维度 | Claude | Codex |
|------|--------|-------|
| **强项** | 工程细节精准，优先级表格清晰，每条建议都可直接执行 | 产品视角锐利，提出了 branch 分类和黄金路径这两个关键结构性洞察 |
| **弱项** | 缺少场景收窄和完成标准定义，容易变成功能清单 | 没有给出具体代码层面的修改建议，执行路径不够明确 |
| **最大增量贡献** | Mock Adapter P0 优先级判断 | Branch 分类（research / execution / verification）和 V1 DoD |
| **适合的读者** | 写代码的人 | 做产品决策的人 |

**结论：两份计划应该合并使用。** Codex 定方向，Claude 定执行。先按 Codex 的思路收窄承诺、定义黄金路径和完成标准，再按 Claude 的优先级逐条补技术。
