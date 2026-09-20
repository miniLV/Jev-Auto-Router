# Architecture

Five runtime modules, one selection authority: **Jev chooses; the Guard
validates; Codex executes; independent verification proves.** The unit of
routing is the model call inside one live Codex session.

## Modules and seams

| Module | Interface | Responsibility hidden behind it |
| --- | --- | --- |
| proxy | Codex Responses request → routed native response | OFF/infra/privacy gates, route application, unchanged streaming events, usage capture |
| routing | RoutingState + candidates → RouteDecision | Compact state construction, candidate pairs, GPT-6 gate, one Jev Choice, fixed fallback |
| verification | Completed task → PASS/FAIL + evidence refs | Acceptance reading, independent checks, fixed verification tier, correction-cycle counting |
| telemetry | Records → local log + Compass aggregates | Private persistence, UNKNOWN discipline, bounded metrics |
| entry | Environment → running proxy | Startup, host model discovery, configuration |

The Jev wire schema appears in exactly one place: the adapter seam inside
`routing`. The proxy forwards native Responses events unchanged; it never
rewrites response content or injects routing labels into the content stream.

## P0 readiness gate

The proxy exists to route mid-loop model calls — the one thing the Codex
App Server turn API cannot do. Before any routing logic is trusted, the
implementation must demonstrate on real Codex CLI with real four-tier
models, in one session, an A→B→A tool loop with intact: authentication,
requested-vs-response model/effort, tool-call IDs, SSE events,
cancellation, continuation and compaction. A critical failure stops per-call
promotion and reopens the host interface question. Everything below is
UNVERIFIED until this gate passes.

## End-to-end flow

1. Codex emits a Responses request through the local proxy.
2. Router OFF → forward with the host's original model, `mode = bypass`.
3. Infrastructure call (compaction-style) → stable configured profile.
4. Privacy check: routing state fails the send policy → skip Jev,
   configured baseline, `route_source = bypass`.
5. Build compact routing state and validated `(model, effort)` candidate
   pairs from trusted discovery; apply hard constraints (forced model,
   GPT-6 gate).
6. One Jev Choice over the pairs, under the pinned version and hot-path
   deadline. Timeout/malformed/low-confidence/transport failure → the
   configured baseline with recorded reason; a transport failure skips Jev
   for the remainder of the task.
7. Guard validates the selection deterministically; DENY → baseline.
8. Forward natively; record actual pair, usage and latency (UNKNOWN
   preserved).
9. Task end → independent verification outside the routing loop: acceptance
   from the original request, diff/tests/artifacts/run results checked,
   semantic judgment on the fixed verification tier, cost counted.
10. PASS → task record. FAIL → bounded failure facts to the same session
    (`correction` next call); at most 2 correction cycles, then Root
    takeover. Immediate takeover on repeated defect, scope runaway,
    permission problems, unclear identity, or Jev persistently avoiding a
    necessary GPT-6 call.

## Observation

Telemetry records per-call and per-task facts only; Compass computes
bounded aggregates from records and never feeds back into online routing.
Shadow mode (`mode = shadow`) logs would-be routes while execution uses the
baseline; it calibrates the hot-path deadline and evaluates `jev-latest`
against the pin. No quota, account, usage, credit, model-mix or latency
history is a routing input.

## Failure posture

Routing failure degrades to the explicit baseline, never escalates to
GPT-6, never switches external provider silently, and never crashes the
user's task. The kill switch restores the host's originally specified model
without downgrading user-chosen Sol/GPT-6. Closed routing never means
abandoned work: the session continues on the baseline and verification
still gates completion.
