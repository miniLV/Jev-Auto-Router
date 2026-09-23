# 23 — 证明真实会话压缩后仍延续工具循环并重新选路

**What to build:** 同一个真实 Codex 会话经过上下文压缩后，继续提交工具结果、发起下一次 Model Call，并在已证明候选集合内重新进行一次 Jev Choice。

Blocked by: 08 — 受控 Active 评估入口；10 — 已证明可请求组合；11 — 任务标识隐私；12 — 工具事实白名单；14 — Jev 实际版本；16 — SSE 失败终态；17 — Jev 参数绑定；18 — 派生目录身份。

Blocks: 06 — 补齐可重跑的真实 Codex 证据。

Status: ready-for-agent

Related: 原 Issue 06 的第 3、4 项；`src/proxy.ts` 的逐次调用与工具结果摘要；`spec.md` §7、§9。

## Problem

当前证据摘要没有压缩情形。没有真实试验就无法确认 Codex 在压缩上下文后继续同一工具循环，以及下一次 Model Call 是否仍独立选路、保留结果 ID。

## Solution

1. 固定能够触发或明确执行 Codex 会话压缩的可重跑测试步骤。明确记录压缩前后的同一会话标识、压缩事件或命令、工具调用和后续结果 ID 摘要。
2. 压缩前后分别记录请求与上游观测的模型、请求 effort、`UNKNOWN` 的实际 effort、候选 pair ID、Jev 决策 ID、HTTP 终态和策略/目录版本，证明新调用确实重新选路而非沿用旧决定。
3. 验证压缩后的下一次 Responses 请求继续携带 Codex 应携带的工具结果引用，代理只改变获准的 `model` 和 `reasoning.effort`，未改写原生上下文或工具载荷。
4. 保存脱敏时间线、关联摘要和运行说明，另一位维护者能够复核。若 Codex 当前 CLI 无法稳定触发压缩，记录具体限制和未通过项，不用模拟的“第二次普通调用”冒充压缩。

## Acceptance criteria

- [ ] 有可证实的真实压缩事件，随后同一会话继续工具循环并发出新的 Jev Choice。
- [ ] 压缩后工具结果 ID 与先前工具调用相关联；请求、应用、观测模型/effort 分列且未知保持 `UNKNOWN`。
- [ ] 记录可重跑并脱敏，能区分真实压缩后续跑与普通多轮调用。

## Boundaries and verification

不要在代理里实现新的上下文压缩器；Codex 仍拥有会话和工具循环。运行相关测试、`npm test`、`npm run typecheck` 后再做真实试验。
