# 05 — 保护 Active Mode 的故障与取消边界

**What to build:** Active Mode 遇到路由拒绝或故障时能在发送上游请求前按固定规则回退；上游开始向客户端输出后如实报告失败；用户取消时停止正在等待的 Jev 或上游工作。

Blocked by: 04 — 在 Active Mode 逐次应用 Jev 选出的组合。

Status: ready-for-agent

- [ ] OFF、隐私拒绝、Routing State 不足、Jev 超时或失败、无效 Choice、低信心和 Guard 拒绝均在上游发送前选择同一已验证 Fallback Baseline，最多发送一次请求并记录各自原因；固定组合不可请求时明确失败。
- [ ] 上游输出已开始后发生错误，不在同一次 Model Call 上改模、重放或重复执行工具；客户端看到该次失败。
- [ ] 在 Jev 等待或上游生成期间取消，会终止对应工作，不转换成固定组合请求，并记录取消而非正常完成。
- [ ] 完整 HTTP 链路测试核对各失败情形的实际上游请求次数，以及提议、应用、观测和 `UNKNOWN` 的独立记录。
