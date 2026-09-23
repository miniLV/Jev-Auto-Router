# 04 — 在 Active Mode 逐次应用 Jev 选出的组合

**What to build:** 在受控开启的 Active Mode 中，连续两次 `jev/auto` Model Call 可以分别应用不同的有效 Jev 选择，而 Codex 仍在同一会话中继续工具循环和原生响应流。

Blocked by: 03 — 在 Shadow Mode 运行一次受控 Jev 决策。

Status: ready-for-agent

- [ ] 一次有效的 Jev Choice 经 Candidate Pair 与 Guard 校验后才在本次调用中 Apply；下一次 Model Call 独立重新选择，能实际到达另一个上游模型与 effort。
- [ ] Apply 只更改本次请求的 `model` 和 `reasoning.effort`；输入、工具定义、工具调用 ID、流式标志、元数据和其他字段保持原语义。
- [ ] 两次调用均经过已认证且不递归的 caller edge；工具结果 ID 在后续调用中延续，SSE 或 JSON 的客户端可见行为保持原生。
- [ ] 每次调用分别记录 Jev 提议、Guard 结果、应用组合与上游观测组合；实际模型或 effort 缺失时显示 `UNKNOWN`，不得用提议值补填。
