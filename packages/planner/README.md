# Planner

职责：

- 根据 goal 生成初始 `plan.md`
- 产出 `branch_specs.json` 和 `eval_spec.json`
- 只做计划生成，不负责执行和状态推进

边界：

- 当前版本是稳定、可预测的规则型 planner
- 后续如接入 LLM planner，也必须保持输出工件格式稳定
