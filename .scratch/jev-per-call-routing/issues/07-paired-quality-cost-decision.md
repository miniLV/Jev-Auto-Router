# 07 — 配对评估 Main Task 质量与完整成本

**What to build:** 用相同任务条件对比固定组合与自动路由的交付结果、延迟和完整成本，给出各 Candidate Pair 是否可用于 Active 的明确决定，以及可执行的启用与回退方式。

Blocked by: 06 — 补齐可重跑的真实 Codex 证据。

Status: ready-for-agent

- [ ] 在配对运行前冻结任务集合、仓库状态、验收条件、独立评审方法、质量下限、成本指标和通过规则；相同 Main Task 使用等价输入和验收标准。
- [ ] 按 Candidate Pair 和模式报告完成率、返工、质量、延迟及完整成本，计入所有上游 Model Call、Jev Choice、允许的重试、缓存和 caller edge 开销；未知用量不得按零计算或据此声称节省。
- [ ] 只有传输与取消证据、Shadow Mode 结果、质量和成本门槛均通过的精确模型、effort、Jev 版本与策略版本，才能列入 Active 启用清单；不通过时记录原因。
- [ ] 发布记录说明开启 Active 的配置变更，并演示通过配置回到 Shadow Mode 或固定 Fallback Baseline，不引入额外的部署控制系统。

## Comments

- 2026-09-23：已将旧固定 Terra 的合成对照替换为可运行的配对评估器。评估计划冻结任务/仓库状态/验收/阈值；运行记录带开始时间、随机顺序和独立评审证据引用，全量计入 Model Call、Jev、缓存与 caller-edge 费用，配对不一致或未知成本不会给出节省结论。报告按候选列出 baseline、Shadow、Active 的质量、返工、耗时和完整费用；每个候选还需要绑定同版本配置的 pair-locked 评估，并通过传输、取消、Shadow、质量和成本门槛。PASS 门槛必须引用对应的脱敏证据摘要，缺失引用会使门槛保持 UNKNOWN。`JEV_ACTIVE_CANDIDATES` 在 Shadow 收窄候选，Active 必须同时加载评估报告并校验 release、caller-edge、候选目录、Jev、策略、schema 和逐候选通过状态。当前没有真实配对运行数据，且 Issue 06 实机证据未完成，因此本 issue 仍未完成，也没有 Active 候选被批准。
