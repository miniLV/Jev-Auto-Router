# V1 acceptance cases

The implementation handoff. Cases are behavioral: exercise the public
module interfaces (proxy, routing, verification, telemetry, entry) with
deterministic fixtures, then prove the host-dependent cases on a real
Codex CLI. Never replace a behavioral case with a prose-presence regex.
Phases: **P0** switching proof → **P1** schemas/offline behavior →
**P2** live single-session routing → **P3** verification/Compass/bench.

## P0 — per-call switching proof (gates everything)

| ID | Required case |
| --- | --- |
| A01 | Real Codex CLI, real four-tier models, one session: an A→B→A tool loop completes with authentication, requested model and effort matching the response, and intact tool-call IDs |
| A02 | SSE events forwarded unchanged across switches (byte-identical event classes/order vs direct call); no injected label or content in the Responses stream |
| A03 | Mid-loop cancellation stops cleanly on both models; late/disarmed Jev responses produce no route application |
| A04 | Continuation and compaction survive a model switch (or fail loudly and are recorded); no silent context loss |
| A05 | Any critical A01–A04 failure marks per-call routing unproven and blocks promotion (state gate, not a warning) |

## Routing core

| ID | Required case |
| --- | --- |
| A06 | Candidates are validated `(model, effort)` pairs from host discovery; unsupported pairs are excluded with recorded reason; construction never ranks or shapes shortlists |
| A07 | One decision = one Choice over pair IDs; the adapter resolves by exact lookup and cannot fill/substitute; a returned unknown ID is `malformed` |
| A08 | Luna Max binds to `gpt-5.6-luna` + `max`; if `max` is unrequestable, the supported pairs surface and the naming defect is reported, not papered over |
| A09 | Low confidence / timeout / malformed → configured baseline with `route_source = fallback` and reason; baseline unavailable → host's original request or explicit error, never a silent external provider switch |
| A10 | Transport failure → baseline **and Jev skipped for the remainder of the task**; subsequent calls record `bypass` without HTTP |
| A11 | Kill switch bypasses Jev and restores the host's originally specified model; a user-chosen Sol or GPT-6 request is never downgraded to Terra by kill switch or fallback |
| A12 | Shadow mode logs would-be routes with `mode = shadow` while execution uses the baseline; shadow never changes execution |
| A13 | Version discipline: active routing requests the pinned Jev version; resolved version recorded (UNKNOWN when unexposed); a resolved-version change under an active `latest` alias demotes to shadow/baseline |
| A14 | Infrastructure (`compaction`-style) and `verification` calls are excluded from economic routing and use their fixed profiles; `tool_step` calls participate |

## GPT-6 gating

| ID | Required case |
| --- | --- |
| A15 | GPT-6 absent from candidates by default; one verified blocker evidence opens exactly one eligibility for the next targeting call; consumed or resolved eligibility cannot admit GPT-6 again |
| A16 | An ordinary Sol failure leaves routine tool calls unexposed to GPT-6 (no persistent eligibility) |
| A17 | An explicit "must use GPT-6" user instruction executes as a hard constraint over its stated scope; the Guard denies a Terra selection for that call |
| A18 | Jev persistently avoiding an evidenced-necessary GPT-6 call triggers Root takeover; Jev's answer is never rewritten in place |

## Privacy

| ID | Required case |
| --- | --- |
| A19 | Routing state is field-whitelisted; tool facts carry name/exit status/error codes/fixed-length digests only; text fields are untrusted and sensitive content is refused, not truncated |
| A20 | A call with no send eligibility skips Jev (zero HTTP) and records `bypass` with reason |
| A21 | Default logs contain no raw prompt or tool-output text; digests only |

## Verification and lifecycle

| ID | Required case |
| --- | --- |
| A22 | Verification reads acceptance from the original user request; a model summary replacing it fails the case |
| A23 | PASS requires per-condition evidence (diff, tests, artifacts, run results); self-report and missing evidence never yield PASS; unverifiable tasks stay `unverified` |
| A24 | One correction cycle = boundary FAIL → next boundary verification end, regardless of intermediate call count; counter monotonic; labels/retries never reset it |
| A25 | Third FAIL-boundary (2 cycles exhausted) → Root takeover recorded; immediate takeover on repeated defect, scope runaway, permission problem or unclear identity |
| A26 | Verification-tier calls run the fixed profile, are never economically routed, and their cost counts in the task |
| A27 | Pre/post-task diff recorded; user's pre-existing changes survive every routed path |

## Telemetry and bench

| ID | Required case |
| --- | --- |
| A28 | Call/task records match the Compass schema; `route_source` separates `jev/fallback/bypass`; no fallback is attributed to Jev |
| A29 | UNKNOWN usage is never coerced to zero anywhere in the accounting path (the retired harness's UNKNOWN→zero defect cannot recur); cached ⊆ input and reasoning ⊆ output are not double-counted |
| A30 | Compass aggregates compute from records without re-persistence and never feed back into online routing; quota/usage/credit/model-mix/latency are never routing inputs |
| A31 | Historical replay output is labeled `ESTIMATED/COUNTERFACTUAL`; it cannot produce a production savings claim |
| A32 | Controlled comparison counts Jev, verification, failures, corrections, takeover and all model calls in both arms, with declared cache conditions; quality is checked before cost |
| A33 | Top-level metrics capped at the eight defined; correction cycles, latency, tier shares, cache hits and GPT-6 usage appear only as diagnostics |

## Static-test migration

Existing tests that assert the old TaskUnit/worker prose are deleted with
their modules. Preserve nothing that validates UNKNOWN→zero accounting or
worker-budget counters. New tests concentrate on the cases above, not on
per-function replicas of implementation logic.
