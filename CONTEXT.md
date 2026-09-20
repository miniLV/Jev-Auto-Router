# Shared Context

This glossary describes the Jev Auto Router contract. The
[Runtime Router Policy](skills/jev-auto-router/references/routing-policy.md)
is the sole canonical runtime routing policy; [spec.md](spec.md) is the
normative product specification. This file is explanatory context and cannot
define a route.

| Term | Definition |
| --- | --- |
| Main Task | The user-visible task: one request, one delivered result, one Router Compass task record. |
| Model Call | One request/response round of the Codex agent loop against the Responses API. The unit of routing. Tools themselves are never routed; what is routed is the next model call after a tool result. |
| Responses Proxy | The local module that sits on the Codex Responses request path: router OFF check, infrastructure bypass, privacy check, routing, native forwarding, and usage recording. It forwards native streaming events unchanged. |
| Routing State | The compact per-call facts given to Jev: step type, allowlisted bounded facts, current model, context-size bucket when observable. Never a copy of the session. |
| Step Type | Classification of a model call: `user_turn`, `tool_step`, `correction`, `verification`, `other`, or `infrastructure`. A routing context, never a model selector. |
| Candidate Pair | One validated, host-requestable `(model, reasoning_effort)` combination. Candidates are pairs, not independent model and effort answers; Jev selects one pair in a single Choice. |
| Jev | The sole automatic route-selection intelligence for model calls. One Choice over eligible candidate pairs. Never advisory, never a second opinion, never duplicated by a local heuristic. |
| Jev Version Pinning | Production routing uses a validated, pinned Jev version. `jev-latest` runs in shadow evaluation only. Requested and resolved versions are always recorded; comparisons are segmented by version, question schema, and policy. |
| Route Decision | The outcome of one routed call: the Jev-selected pair executed, or an explicitly recorded fallback/bypass. |
| Fallback Baseline | The deterministic failure route for low confidence, timeout, or malformed Jev responses: the configured baseline (default Terra/medium), with `fallback_reason` recorded. Fixed reliability handling, never a semantic second selector. If the baseline is unavailable, keep the host's original request or fail explicitly; never silently switch external provider. |
| Kill Switch | A zero-friction local OFF control. When off, Jev is bypassed and the host's originally specified model is restored. A user-chosen Sol or GPT-6 request is never secretly downgraded to Terra by the kill switch or fallback. |
| GPT-6 Eligibility | "Allowed to consider GPT-6": one verified reasoning-blocker evidence grants one temporary eligibility for the next call targeting that blocker; it is cleared after use or resolution. GPT-6 is otherwise absent from candidates. |
| GPT-6 Mandate | "Must use GPT-6": an explicit user requirement is a hard constraint enforced over its stated scope. Eligibility and mandate are distinct; conflating them violates either the user or the scarcity goal. |
| Privacy Boundary | The minimal field whitelist and send policy for routing state. Prefer tool name, exit status, error codes, and fixed-length error digests; treat text as untrusted; refuse to send sensitive content. No send eligibility means Jev is skipped for that call. Logs persist no raw text by default. |
| Hot-Path Deadline | The short Jev deadline derived from shadow latency data. After a transport failure, Jev is skipped for the remainder of the task and the explicit baseline is used. |
| Task Boundary | The end of a Main Task, where independent verification runs. It is outside the economic routing loop. |
| Independent Verification | The task-boundary PASS/FAIL gate: acceptance conditions read from the original user request; diff, tests, artifacts, and run results checked independently; semantic judgment by the fixed verification tier; cost counted in the task. Model self-report is never evidence; missing evidence is never PASS. |
| Verification Tier | The fixed model/effort profile used for necessary semantic judgment at verification. Not economically routed. |
| Correction Cycle | One round from an independent FAIL at a task boundary to the end of the next task-boundary verification. All model and tool calls in between count as one cycle. Default maximum: 2, then Root takeover. |
| Root Takeover | Root stops economic routing and completes the task itself. Triggered after the correction-cycle limit, or immediately on a repeated defect, scope runaway, permission problems, or unclear context/execution identity — including when Jev persistently avoids a GPT-6 call that evidence shows necessary. Jev's answer is never silently rewritten. |
| Router Compass | The observation product: per-call and per-task records plus bounded aggregates. It consumes records only and never feeds back into online routing. |
| Shadow Mode | Jev decides and the would-be route is logged while the actual request uses the configured baseline model. Measures route distribution and Jev behavior without changing execution. |
| Historical Replay | The offline research script that re-prices real session token traces under hypothetical routes. An economic estimate labeled `ESTIMATED/COUNTERFACTUAL`, never a runtime dependency or launch proof. |
| Controlled Benchmark | The fixed-Terra comparison on a defined task group with equivalent acceptance, declared cache conditions, and complete cost accounting. The only basis for causal savings claims. |
| UNKNOWN | The value of any unobserved usage or model fact. Never converted to zero, never counted as verified routing attribution. |
| Routing Label | The per-call visible tag (e.g. `Terra:medium`). Shown via host UI metadata or a separate event channel; if no such interface exists, only in the completion summary. Never injected into the Responses content stream. |
| Competing routing authority | Any other routing/orchestration layer governing the current requests. The router detects it and bypasses to the host's original request instead of competing. |

The contract deliberately keeps route selection intelligence in exactly one
place — Jev, reached through one adapter seam — with deterministic candidate
construction, a fixed failure fallback, task-boundary verification, and
observation-only telemetry. There is no heuristic classifier, no task-kind
table, no tier ladder, no worker/capsule machinery, no cache/price optimizer,
no online learning loop, and no second selector in this repository.
