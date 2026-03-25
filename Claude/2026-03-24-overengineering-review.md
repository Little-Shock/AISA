# 对合并路线图的过度工程化审查

- 日期：`2026-03-24`
- 审查对象：[Codex/2026-03-24-merged-roadmap.md](file:///Users/atou/AISA/Codex/2026-03-24-merged-roadmap.md)
- 审查视角：是否存在过度工程化，哪些可以更简单

---

## 总体判断

路线图方向正确，但 **Phase 1 和 Phase 3 存在过度工程化风险**。核心问题是：一份声称要"收窄承诺"的路线图，实际上在第一阶段就引入了 execution branch + 隔离现场 + 证据 schema，这本身就是一个不小的工程量。

**一句话版本：路线图的思考是 V1 级别的，但执行节奏应该更 MVP。**

---

## 具体风险点

### 风险 1：Phase 1 要求 execution branch，可能把"钉死任务模型"变成大工程

路线图说 Phase 1 "先不要急着加功能"，但同时要求：

- 加入 `branch_type`（research / execution / verification）
- 固定 worker contract + evidence schema
- 明确 execution branch 的最小职责
- 写正式决策文档

这已经不是"钉死模型"了，这是在设计一个新的类型系统。

**建议简化：** Phase 1 只需要做两件事——
1. 在 `domain` 的 `BranchSpec` 里加一个 `branch_type` 字段（string enum），默认值 `research`
2. 写一份半页纸的黄金路径描述，不需要正式 evidence schema

execution branch 的详细设计推到 Phase 3，因为你在没有真正跑过 execution 之前，设计出来的 contract 大概率需要改。

### 风险 2：evidence schema 过早固化

路线图要求 writeback 有"明确证据结构，至少包括命令、patch、日志、验证结果中的一部分"。

问题是，**当前甚至还没有一个 execution branch 跑过**。在没有真实执行经验的情况下定义 evidence schema，大概率会定错。

**建议简化：** 现阶段 writeback 已经有 `findings[].evidence` 数组（string 类型），够用了。不需要新 schema。等真正有 execution branch 产出后，再根据实际产物定义结构化 evidence。

### 风险 3：execution branch 的隔离现场

路线图说"execution branch 落地最小隔离现场，至少能保留 patch、stdout、stderr 和验证结果"。

当前代码已经为每个 branch 保留了 `stdout.log`、`stderr.log`、`writeback.json` 和 `output/` 目录。**隔离现场已经存在了，只是没有起名叫"隔离现场"。**

真正的增量工作是让 worker 能写文件（从 `read-only` 改为 `workspace-write`），但这只是一个 sandbox 参数的变化，不需要一个完整的"隔离现场"工程。

**建议简化：** 把 `CODEX_SANDBOX` 从 `read-only` 改成 `workspace-write`，给 execution branch 指定一个独立的 `--cd` 工作目录（可以是 git worktree 或 temp copy），就算做完了。不需要新的抽象。

### 风险 4：三类 branch 全部前置

路线图把 research / execution / verification 三类 branch 都放在 Phase 1 定义。

**但 MVP 只需要 research。** verification branch 在没有 execution branch 产出的情况下没有东西可以验证。而 execution branch 在 planner 还是硬编码的情况下也不会被自动生成。

**建议简化：** Phase 1 只定义 `research` 和 `execution` 两种。`verification` 完全推到 Phase 4。

### 风险 5：planner 策略化可能过早

Phase 3 要求 planner 从固定模板升级为"按 goal 类型选策略"。

但当前连第二种 goal 类型都还没有。在只有一种场景的阶段做策略选择器，是典型的过早抽象。

**建议简化：** Phase 3 的 planner 改进只做一件事——**让 branch 数量和 hypothesis 从 goal 的 description/criteria 派生**，而不是写死。不需要"策略选择器"。

---

## 不存在过度工程化的部分

以下内容是合理的，不需要简化：

- **Phase 2 全部内容**（mock adapter、adapter interface、.env 修正、错误处理）——都是实打实的短板
- **V1 DoD**——作为方向性描述是对的，只是不应该全部变成 Phase 1 的工作量
- **SSE 放在 Phase 3**——位置合理
- **Phase 4 的所有内容继续压后**——正确

---

## 建议的精简版路线图

如果要把这份路线图的过度工程化风险压下来，我建议这样改：

### Phase 1：最小模型变更（1-2 天）

- `domain` 加 `branch_type` 字段（`research | execution`），默认 `research`
- 写半页黄金路径描述存入 `docs/decisions/`
- **不做** evidence schema、worker contract、verification branch 定义

### Phase 2：开发闭环（2-3 天）

- 抽象 `WorkerAdapter` interface
- 实现 `MockWorkerAdapter`
- 修 `.env.example`
- 改善错误处理
- 补决策记录

### Phase 3：最小 execution 能力（3-5 天）

- 让 Codex adapter 支持 `workspace-write` sandbox
- execution branch 使用独立工作目录（git worktree 或 temp copy）
- planner 从 goal 描述派生 branch hypothesis（不做策略选择器）
- judge 评分对齐 success criteria
- dashboard 改善 run page

### Phase 4：扩展（以后）

- verification branch
- SSE
- trigger engine
- 长期记忆
- 多实例

---

## 最终建议

Codex 的路线图在**思考层面**是对的——先闭环再扩展。但在**执行层面**，它把太多设计工作前置了。一个还没跑过 execution branch 的系统，不应该先花时间定义 execution 的完整 contract。

**更好的做法是：先用最少的代码改动跑通一次 execution（改个 sandbox 参数 + 指定工作目录），看到真实产出后，再回来定义 contract 和 schema。** 这才是真正的"文件系统优先、可观察优先"精神。
