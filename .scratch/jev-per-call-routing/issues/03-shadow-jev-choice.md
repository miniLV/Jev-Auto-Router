# 03 — 在 Shadow Mode 运行一次受控 Jev 决策

**What to build:** 对符合条件的 `jev/auto` Model Call，Jev 基于最小 Routing State 提出一个经过 Guard 检查的 Candidate Pair；用户实际收到的仍是固定组合的原生响应，维护者能看到提议与执行的区别。

Blocked by: 02 — 打通 `jev/auto` 的固定基线路径。

Status: ready-for-agent

- [ ] 发给 Jev 的 Routing State 只含获准的结构化事实，不含原始用户文本、工具输出、文件内容、密钥或未经批准的标识符；信息不足时不请求 Jev。
- [ ] Candidate Pair 仅来自当前认证入口实测可请求的 `(model, effort)` 组合；每次合格调用只向固定版本 Jev 发起一次有截止时间的 Choice，Guard 拒绝不在候选集内或违反硬约束的回答。
- [ ] Shadow Mode 始终执行固定 Fallback Baseline；OFF、隐私拒绝、信息不足、Jev 超时或不可用、无效回答与 Guard 拒绝都只执行一次固定组合，并各自记录明确原因。
- [ ] 从完整 HTTP 链路可关联 Jev 提议、Guard 结果、应用的固定组合和上游实际观测；匹配、不匹配与缺失观测可区分，缺失模型或用量保持 `UNKNOWN`。
