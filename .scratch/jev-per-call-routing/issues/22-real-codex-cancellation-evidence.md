# 22 — 证明真实 Codex 取消会停止 Jev 或上游且不重放

**What to build:** 两次独立的真实 Codex 取消试验分别发生在 Jev 等待和上游生成中；关联记录证明对应工作停止、未发替代请求，且状态是 cancelled。

Blocked by: 08 — 受控 Active 评估入口；09 — 正式取消链路；10 — 已证明可请求组合；11 — 任务标识隐私；16 — SSE 失败终态；17 — Jev 参数绑定；18 — 派生目录身份。

Blocks: 06 — 补齐可重跑的真实 Codex 证据。

Status: ready-for-agent

Related: 原 Issue 06 的第 3、4 项；Issue 05 的取消要求；`src/index.ts` 与 `src/proxy.ts` 的取消记录。

## Problem

替身 HTTP 测试覆盖取消逻辑，但此前正式启动接线甚至丢失上游 signal。即使修复代码，仍须证明真实 Codex、代理与认证 caller edge 的实际取消传播和无重放行为。

## Solution

1. 准备两个可重跑的无敏感测试场景：在 Jev Choice 尚未返回时由 Codex 取消；在上游已开始发 SSE、尚未完成时取消。用可观察的 caller edge/上游终止记录，不仅凭客户端连接关闭作结论。
2. 每个场景保存同一调用关联 ID、取消发起时刻、Jev 或上游 abort/连接结束时刻、当次上游请求计数、后续是否有 fallback/重放、最终 `call_status`。若外部服务不提供可权威证明“工作停止”的信息，写明 `UNKNOWN`，不可勾选完整通过。
3. 对照未取消的正常调用，区分客户端主动取消、Jev 超时、上游流失败；取消不得记为正常完成或自动切换模型。
4. 记录精确运行版本、pair、请求 effort、caller edge 配置与可重跑步骤；只保存脱敏摘要，不保存请求/工具原文或凭据。

## Acceptance criteria

- [ ] Jev 等待中取消：无上游请求，Jev 工作停止，有 cancelled 记录。
- [ ] 上游生成中取消：最多一条上游请求，上游工作停止，不出现基线补发或重复工具执行，记录为 cancelled。
- [ ] 两个独立场景都有可复核的关联日志及配置版本；仅有客户端断开不能单独证明上游停止。

## Boundaries and verification

不要通过人为终止整个代理进程替代逐调用取消证明。运行定向测试及 `npm test`、`npm run typecheck`，然后执行真实试验；外部端点或凭据不可用时本票保持未完成。
