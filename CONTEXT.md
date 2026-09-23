# Shared Context

This glossary describes the Jev Auto Router contract. The
[Runtime Router Policy](skills/jev-auto-router/references/routing-policy.md)
is the sole canonical runtime routing policy; [spec.md](spec.md) is the
normative product specification. This file is explanatory context and cannot
define a route.

## 项目背景与目标

一个 Codex 编码任务通常混合了高难度推理和读取文件、执行已知修改等常规调用。整段任务固定使用同一模型，可能让常规调用消耗不必要的高端模型能力；整段任务固定使用轻量模型，则可能影响困难环节的质量。Jev Auto Router 探索在同一个 Codex 会话中按模型调用选择模型和推理档位，并在任务结束时独立检查交付结果。

项目目标是让 Jev 在宿主当前确实支持的 `(model, reasoning_effort)` 组合中，为每次有意义的模型调用选择成本较低且能可靠完成该调用的组合；保留用户指定模型等硬约束，限制发送给 Jev 的信息，并记录实际执行、用量与验收证据。节省效果必须由等价验收的受控对照证明，不能仅凭 Jev 选择了较低档位就宣称节省。

V1 范围是一个 Codex 会话中的 GPT 系列模型调用。路由决策由一次 Jev Choice 完成；本地代码负责构造可用候选项、执行确定性的约束检查和故障回退。代理转发原生 Responses 流；任务边界验收独立于节省型路由。工具本身不参与选路，路由的是工具结果之后的下一次模型调用。

## 方案与当前实现

预期流程：用户为自动路由选择虚拟模型 `jev/auto` → Codex Router
把该请求交给本地 Jev Router → 路由器从当前认证 caller edge 已实测可请求
的组合构造候选 → Jev 做一次 Choice → Guard 校验 → Apply 只改 `model`
和 `reasoning.effort` → caller edge 用真实模型 ID 执行 → 原生响应立即返回
Codex。用户选择真实模型时走正常通道，不进入 Jev Router。OFF、隐私拒绝、
事实不足和路由故障使用同一个已实测的固定 Fallback Baseline，并分别记录
原因。

代码中的主要边界：`src/index.ts` 提供本地 HTTP 入口及配置；`src/proxy.ts` 编排逐调用路由和转发；`src/route-plan.ts` 构造受限路由状态；`src/catalog.ts`、`src/discovery.ts` 和 `src/jev-adapter.ts` 负责候选目录与 Jev 接口；`src/policy-guard.ts` 校验选择；`src/execution-contract.ts` 处理路由应用和执行观测；`src/verification.ts` 与 `src/receipt.ts` 实现验收状态和记录指标。

当前仓库是迁移中的运行时原型。已有真实 Codex A→B→A 摘要支持跨模型
延续、认证、工具结果 ID 延续和 HTTP 流在完成前抵达；它不是可重跑原始
记录，也尚未独立证明 effort 一致性、取消或压缩。现有代码仍需后续 ticket
迁移到本文所述入口、固定基线、即时流式与取消契约。

## 文档职责

- [AGENTS.md](AGENTS.md)：贡献和协作规则，不作为产品背景或运行时策略来源。
- [README.md](README.md)：中文项目介绍、原型使用方式与当前状态。
- [spec.md](spec.md)：规范性产品要求。
- [Runtime Router Policy](skills/jev-auto-router/references/routing-policy.md)：唯一的自动路由运行时策略。
- [docs/solution.md](docs/solution.md)：已批准的 V1 方案细节；[ADR 0017](docs/adr/0017-per-call-responses-routing.md) 记录关键架构决策。

## 术语表

| Term | Definition |
| --- | --- |
| Main Task | The user-visible task: one request, one delivered result, one Router Compass task record. |
| Model Call | One request/response round of the Codex agent loop against the Responses API. The unit of routing. Tools themselves are never routed; what is routed is the next model call after a tool result. |
| Jev Router | The local adapter entered only by `jev/auto`: admission, one Jev Choice, Guard, two-field Apply, authenticated forwarding and passive observation. |
| Caller Edge | The authenticated, non-recursive upstream entry that has proved the allowed Candidate Pairs requestable. It receives real model IDs and owns upstream credentials. |
| Routing State | The compact per-call facts given to Jev: step type, allowlisted bounded facts, current model, context-size bucket when observable. Never a copy of the session. |
| Step Type | Classification of a model call: `user_turn`, `tool_step`, `correction`, `verification`, `other`, or `infrastructure`. A routing context, never a model selector. |
| Candidate Pair | One exact `(model, reasoning_effort)` combination proved requestable through the current authenticated caller edge. Candidates are pairs, not independent model and effort answers. |
| Jev | The sole automatic route-selection intelligence for model calls. One Choice over eligible candidate pairs. Never advisory, never a second opinion, never duplicated by a local heuristic. |
| Jev Version Pinning | Production routing uses a validated, pinned Jev version. `jev-latest` runs in shadow evaluation only. Requested and resolved versions are always recorded; comparisons are segmented by version, question schema, and policy. |
| Route Decision | The outcome of one `jev/auto` call: the accepted Jev pair or the fixed Fallback Baseline, with the exact reason recorded. |
| Fallback Baseline | One configured Candidate Pair proved requestable through the current caller edge. OFF, refusal, insufficient facts and pre-output routing failures all use it with distinct reasons; there is no universal model default. |
| OFF Mode | Jev is not called and `jev/auto` executes with the Fallback Baseline. Manual real-model requests remain outside automatic routing in every mode. |
| Proposed Pair | The pair returned by Jev, if any. It is not evidence of what was requested upstream or executed. |
| Applied Pair | The pair placed in the authenticated upstream request after mode and Guard handling. |
| Observed Pair | The pair authoritatively reported by the upstream response, or `UNKNOWN` when unavailable. |
| Privacy Boundary | The minimal field whitelist and send policy for routing state. Prefer tool name, exit status, error codes, and fixed-length error digests; treat text as untrusted; refuse to send sensitive content. No send eligibility means Jev is skipped for that call. Logs persist no raw text by default. |
| Hot-Path Deadline | The short Jev deadline derived from Shadow Mode latency data. Expiry uses the fixed Fallback Baseline and records `jev_timeout`. |
| Task Boundary | The end of a Main Task, where independent verification runs. It is outside the economic routing loop. |
| Independent Verification | The task-level check of original acceptance conditions against the delivered diff, tests, artifacts and run results. Model self-report and Jev confidence are never completion evidence. |
| Router Compass | The observation product: per-call and per-task records plus bounded aggregates. It consumes records only and never feeds back into online routing. |
| Shadow Mode | Jev decides and the would-be route is logged while the actual request uses the configured baseline model. Measures route distribution and Jev behavior without changing execution. |
| Historical Replay | The offline research script that re-prices real session token traces under hypothetical routes. An economic estimate labeled `ESTIMATED/COUNTERFACTUAL`, never a runtime dependency or launch proof. |
| Controlled Benchmark | The fixed Fallback Baseline comparison on a defined task group with equivalent acceptance, declared cache conditions, and complete cost accounting. The only basis for causal savings claims. |
| UNKNOWN | The value of any unobserved usage or model fact. Never converted to zero, never counted as verified routing attribution. |
| Routing Label | A per-call visible tag for the Applied Pair. Shown via host UI metadata or a separate event channel, never injected into the Responses content stream. |
| Competing routing authority | Any other routing/orchestration layer governing an automatic request. Jev is skipped and the fixed Fallback Baseline is used with a distinct reason. |

The contract deliberately keeps route selection intelligence in exactly one
place — Jev, reached through one adapter seam — with deterministic candidate
construction, a fixed failure fallback, task-boundary verification, and
observation-only telemetry. There is no heuristic classifier, no task-kind
table, no tier ladder, no worker/capsule machinery, no cache/price optimizer,
no online learning loop, and no second selector in this repository.
