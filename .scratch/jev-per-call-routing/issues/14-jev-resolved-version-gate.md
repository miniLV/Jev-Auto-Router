# 14 — Jev 实际版本未知时禁止 Active Apply

**What to build:** 只有返回可核对的精确 Jev 版本且与请求版本一致的 Choice 才能进入 Active；版本缺失、漂移或未固定时仍执行一次已验证基线，并保留具体原因。

Blocked by: None — can start immediately.

Blocks: 03 — Shadow Jev Choice；04 — Active 逐次 Apply；06 — 真实 Codex 证据。

Status: resolved

Related: `src/jev-adapter.ts` 的 `choose()`、`isPinnedJevVersion()`；`src/policy-guard.ts` 的版本校验；`src/proxy.ts` 的 Active 分支。

## Problem

响应不带 Jev `model` 时，适配器会把实际版本记为 `UNKNOWN`，但仍可把 Choice 标为 valid；Guard 只拒绝“已知且不一致”的版本。这样无法证明候选来自已 Shadow 验证的精确版本，却能 Active Apply。

## Solution

1. 明确“请求固定版本”和“响应证实实际版本”是两个事实。Active 版本门禁要求两者均为具体值且一致；缺失响应版本不能视为匹配。
2. 在适配器或 Guard 的单一边界给出缺失与漂移的确定性结果，保留 `jev_requested_version`、`jev_resolved_version` 的真实值，不用请求值回填观察值。
3. 版本不满足时，不再调用 Jev 第二次、不更换候选；本次请求只走一次固定 Fallback Baseline，并记录 `UNKNOWN` 与明确的版本原因。Shadow 可以继续记录这种观察以供排查，但不能把它计作 Active 合格 Choice。
4. 用受控 Jev 响应分别覆盖版本相同、版本不同、版本缺失、请求别名；断言上游模型/effort、一次请求次数及提议/应用/观察列。

## Acceptance criteria

- [x] Jev 版本缺失或漂移时，Active 不应用提议组合，只执行一次固定基线。
- [x] 版本相同且其他 Guard 条件满足时正常 Apply；版本记录不互相补填。
- [x] Shadow 对未知版本的记录可区分，不能被后续发布报告误算为版本验证通过。

## Boundaries and verification

若真实 Jev API 不提供可核对版本，不能以假值放行；应留在 Shadow 并把外部接口缺口记录为阻塞。运行适配器、Guard、HTTP 测试，再运行 `npm test` 与 `npm run typecheck`。

## Answer

- Guard 现在只接受非别名请求版本与响应实际版本均已知且精确相同的 Choice。缺失、漂移或 `jev-latest` 都拒绝 Active Apply，使用一次固定基线并记录 `jev_version_mismatch`；Shadow 保留提议用于诊断，并将 Choice 标记为版本不合格。
- Jev 请求/响应版本独立记录。无效 pair、无效 confidence、低置信度等已收到响应的失败也保留响应版本；缺少响应版本保持 `UNKNOWN`。受控 HTTP 测试确认 Jev 仅请求一次，且 proposed/applied/observed 三列独立。
- 外部发布缺口：TypeSafe [OpenAPI](https://api.typesafe.ai/openapi.json) 要求响应含 `model`，但定义为回答问题的模型名称，并允许它与请求别名不同；接口契约没有保证该名称是不可变的精确 release ID。本次没有使用真实账号调用 API，因此真实响应是否能核对固定 release 仍未验证。取得真实 Shadow 响应证明精确版本匹配前，Active 发布仍应阻塞并保持 Shadow。
- 验证通过：适配器、Guard、回执及 HTTP 定向测试；`npm test`（172 项）；`npm run typecheck`；`git diff --check`。
- 上述勾选仅指本地受控响应的代码行为；真实 Jev 固定版本回报尚待实机核对，不据此关闭原 Issue 03/04/06。
