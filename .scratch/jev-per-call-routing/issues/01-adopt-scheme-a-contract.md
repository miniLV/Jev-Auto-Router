# 01 — 统一方案 A 的权威路由契约

**What to build:** 让维护者从 Codex 的 `jev/auto` 入口一路读到 Jev 决策、真实执行、回退和任务评估时，只会遇到一套可实施的方案 A 规则。明确替换当前与方案 A 冲突的规范和架构决策，为后续切片提供唯一依据。

Blocked by: None — can start immediately.

Status: resolved

- [x] 权威规范一致定义：只有 `jev/auto` 进入逐次 Model Call 路由；用户显式选择的真实模型保持原请求并绕过 Jev。
- [x] 明确定义经认证且不递归的 caller edge、已实测的固定 Fallback Baseline，以及 OFF、隐私拒绝、Routing State 不足、Jev 或 Guard 失败时的不同原因；旧的 Terra/medium 默认值和 OFF 恢复虚拟原请求的冲突规则得到显式废止。
- [x] 统一 Routing State 白名单、可请求的 Candidate Pair、每次调用一次固定版本 Jev Choice、Guard 和仅改 `model` 与 `reasoning.effort` 的 Apply 契约；提议、应用和上游观测分别记录，缺失事实保留 `UNKNOWN`。
- [x] 架构决策明确 Shadow Mode 先于 Active、输出开始后不重放、取消传播、同一 Codex 工具循环延续，以及任务质量和完整成本的上线证据门槛。

## Answer

方案 A 已迁移到根 `spec.md`、唯一运行时策略、ADR 0017 和
`docs/solution.md`。README、可分发 Skill 与领域术语已同步；旧 SDD、
benchmark 说明和历史方案已明确标为不具规范性的原型库存。

迁移后的契约以 `jev/auto` 为唯一自动入口，真实模型直通；固定回退组合
绑定当前认证且不递归的 caller edge；Routing State、Candidate Pair、一次
固定版本 Choice、Guard、两字段 Apply，以及 Proposed/Applied/Observed 与
`UNKNOWN` 均有唯一含义。Shadow、流式、取消、无重放、同一工具循环和
质量/完整成本门槛已写入权威文档。

验证：`git diff --check`、`npm test`（87/87）和
`npm run typecheck` 均通过。现有运行时测试仍验证旧行为，按依赖留给
ticket 02–05 迁移。
