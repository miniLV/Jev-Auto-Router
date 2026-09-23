# 15 — 在 Shadow 记录 Jev 失败的具体原因

**What to build:** Shadow 始终执行固定基线，但维护者能够分别统计 Choice 成功、超时、传输失败、无效回答、低信心及 Guard 拒绝，不把它们全部归到 `shadow_mode`。

Blocked by: None — can start immediately.

Blocks: 03 — Shadow Jev Choice；07 — 配对评估 Main Task 质量与完整成本。

Status: resolved

Related: `src/proxy.ts` 的 Shadow 分支与 `fallbackReasonOf()`；`src/receipt.ts` 的 `CallRecord`；Shadow 失败率发布门槛。

## Problem

当前 `reason` 在 Shadow 决策后总被设成 `shadow_mode`。`CallRecord` 没有持久保存 `decision.failure_reason/subreason`，导致同样执行 baseline 的超时、网络失败和低信心在 `/decisions` 中无法可靠区分。

## Solution

1. 保持两个独立维度：`route_source/reason` 说明 Shadow 为什么执行基线；新增或复用明确的决策结果字段保存 Jev/Guard 的失败种类和受控子原因。不要把 Shadow 改成执行 Jev 提议。
2. 将适配器已有的 `failure_reason`、`failure_subreason` 映射到有限枚举或受控字符串。避免存入底层异常消息、HTTP body、提示词或凭据。
3. 对成功提议也记录 `choice_accepted` 与 Guard 结果，使统计分母明确：一次合格调用最多一次 Choice，预准入 fallback 不计为 Jev 服务失败。
4. 用完整 HTTP 链路覆盖超时、认证/网络失败、无效 pair、低信心、版本漂移、Guard 拒绝和成功提议。断言所有情况只向上游发送固定基线一次，且分类在最终遥测中保留。

## Acceptance criteria

- [x] Shadow 的执行原因仍为固定基线，Choice/Guard 失败原因另列且可分别统计。
- [x] 无 Jev 调用时不虚构 Jev 失败；未知底层错误不会把原始信息写入日志。
- [x] 测试覆盖每个分类及提议、应用、观察三列的独立性。

## Boundaries and verification

不引入新路由策略或失败后的第二次 Jev 请求。运行遥测及 HTTP 测试，再运行 `npm test` 与 `npm run typecheck`。

## Answer

`CallRecord` now exposes `jev_choice_result` and a bounded `jev_failure_subreason` independently of the Shadow `reason`. Successful Choice and Guard verdict/reason remain separate fields. Calls rejected before Jev produce no Choice classification, and unknown subreasons are reduced to `other`; underlying error text is not retained.

Verification passed: targeted receipt/proxy/HTTP-chain tests (55/55), `npm test` (149/149), `npm run typecheck`, and `git diff --check`.

Evidence gap: HTTP-chain tests use local Jev and caller-edge stubs. They verify router attribution and the single fixed-baseline request, but do not prove behavior against a real Jev service or authenticated production caller edge.
