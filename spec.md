# Jev Auto Router — Specification

Normative product requirements for **Jev Auto Router**. The [Runtime Router
Policy](skills/jev-auto-router/references/routing-policy.md) is the sole
canonical runtime routing policy; [SDD](docs/sdd/README.md) documents expand
the interfaces referenced here. Neither may relax the other. A conflict closes
automatic routing; an implementation must not choose the more permissive
wording. Research notes and product copy do not define runtime behavior.
[ADR 0017](docs/adr/0017-per-call-responses-routing.md) records the
architectural decision.

## 1. Objective

**Use Jev to dynamically choose the cheapest GPT model tier and reasoning
effort that can reliably handle each Codex model call — while proving, at
task completion, that the work was actually completed correctly.**

The product value is not "Jev picked a cheaper model". It is: Jev picked
cheaper pairs, the task still completed, the full delivery consumed less
frontier capacity, and the evidence connects all three.

- Routing granularity is the **model call inside one Codex session**. Tools
  are never routed; the next model call after a tool result is.
- Quality is proven by **independent verification at the task boundary**,
  outside the economic routing loop (§10).
- Economics are proven only by the evidence ladder of §14. No savings claim
  precedes its evidence level.

## 2. Scope

- Codex-only host, GPT-family-only models, one live Codex session.
- V1 ships five runtime modules — proxy, routing, verification, telemetry,
  entry — plus offline evaluation scripts ([architecture](docs/sdd/architecture.md)).
- The router is a local Responses proxy on the request path. It forwards
  native streaming events unchanged and never rewrites response content.

## 3. Model-call switching prerequisite (P0)

The entire per-call plan rests on one unproven assumption: **the same Codex
tool loop tolerates per-call model switching**. The Codex App Server can
select a model for a new turn, but mid-turn switching requires the Responses
request path. Cross-model continuation (encrypted reasoning, compaction
content, tool-call IDs, event-stream shape) may fail silently or loudly.

Therefore the first implementation slice is a runtime proof, not a feature:

- Real Codex CLI, real four-tier models, one session, an A→B→A tool loop.
- Checked items: authentication, requested-vs-response model and effort,
  tool-call ID integrity, SSE event fidelity, cancellation, continuation and
  compaction across model switches.
- Any critical item failing stops per-call promotion and reopens the host
  interface question. No routing product ships on an unproven switch path.

## 4. Model tiers

| Tier | Product profile | Role | Ordinary availability |
| --- | --- | --- | --- |
| T0 | **Luna Max** | cheap mechanical / explicit work | Yes |
| T1 | **Terra** | default workhorse; `Terra/medium` is the default reliability baseline | Yes |
| T2 | **Sol** | strong reasoning / difficult implementation; selected per call | Yes |
| T3 | **GPT-6** | scarce frontier escalation | **No — gated** (§8) |

- **Luna Max binds to `gpt-5.6-luna` at `max` reasoning effort.** If `max` is
  a brand label rather than a distinct requestable effort level for this
  model, the catalog must expose the actually supported pairs and this spec's
  naming must be corrected; a tier name must never imply an effort the host
  cannot request.
- Terra, Sol and GPT-6 resolve their concrete model identifiers from trusted
  host discovery; tier-to-identifier bindings are recorded per session.
- Model IDs appear only in the catalog, proxy forwarding and records — never
  in routing logic. There is no task-kind table, no tier ladder and no
  per-tier task type restriction.

## 5. Candidates and the single Choice

Candidates are **validated `(model, reasoning_effort)` pairs** — never
independent model and effort answers. One Jev request carries exactly **one
Choice** over the eligible pairs; Jev decides model and effort together.
Asking them separately can produce host-unsupported combinations or a hidden
local second selector that patches the mismatch.

Candidate construction is deterministic admission only:

- a pair is eligible iff the host can request it now (discovered model +
  supported effort) and no hard constraint excludes it;
- hard constraints: user-forced model or pair (a hard constraint, not a
  preference), GPT-6 absent unless §8 applies, router-mode rules;
- construction never ranks, never trims for preference, and never sorts by
  task shape. Every exclusion is recorded with a reason.

The adapter resolves the chosen ID by exact lookup into the validated pair
list. It cannot fill, substitute or repair a selection.

## 6. Jev version policy

- **Production routing pins a validated Jev version.** Confidence floors are
  calibrated per version; a floating alias can drift the Choice distribution
  under a frozen threshold.
- **`jev-latest` runs in shadow evaluation only**: Jev decides, the would-be
  route is logged, execution uses the configured baseline.
- Every decision records `jev_requested_version` and `jev_resolved_version`
  (UNKNOWN when the provider does not expose it), plus `question_schema_version`
  and `policy_version`. Comparisons are segmented by version, schema and
  policy. Upgrading the pin is a single configuration change made after the
  segmented shadow comparison passes.
- If a deployment insists on actively routing with `jev-latest`, a detected
  change in resolved version must automatically demote it to shadow/baseline
  until the new version is validated — which is a more complicated pin, not an
  alternative to pinning.

## 7. Failure behavior and kill switch

| Trigger | Behavior |
| --- | --- |
| Valid Choice below the frozen confidence floor | Fallback baseline (default `Terra/medium`); `fallback_reason = low_confidence` |
| Jev timeout (short hot-path deadline, §9) | Fallback baseline; `fallback_reason = timeout` |
| Malformed / schema-invalid response | Fallback baseline; `fallback_reason = malformed` |
| Jev transport failure | Jev skipped for the remainder of this task; explicit baseline; recorded |
| Baseline pair unavailable | Keep the host's original request, or fail explicitly. Never silently switch external provider |
| Router OFF (kill switch) | Bypass Jev entirely; the host's originally specified model is restored |
| No send eligibility (privacy, §9) | Jev skipped for that call; configured baseline; `route_source = bypass` |
| Competing routing authority detected | Bypass to the host's original request |

The fallback is fixed reliability handling, **never a semantic second
selector**. Neither the kill switch nor the fallback may secretly downgrade a
user-chosen Sol or GPT-6 request to Terra. `route_source` distinguishes
`jev | fallback | bypass` in every record.

## 8. GPT-6 gating

GPT-6 is absent from the normal candidate set. Two distinct mechanisms
admit it, and conflating them violates either the user or the scarcity goal:

- **Eligibility ("allowed to consider GPT-6")**: one verified
  reasoning-blocker evidence (a Sol-class attempt produced an unresolved
  failure that evidence attributes to reasoning capability) grants one
  temporary eligibility for the next call targeting that blocker. The
  eligibility is cleared after use or after the blocker resolves. An ordinary
  Sol test failure must not leave ten routine tool calls exposed to GPT-6.
- **Mandate ("must use GPT-6")**: an explicit user requirement is a hard
  constraint enforced over its stated scope. "Please review this change with
  GPT-6" means that call runs on GPT-6; Jev is not asked to prefer Terra.

When eligibility opens, the next decision sees the four-tier candidate set
and Jev still selects the pair. The router never implements
"Sol failed → automatically GPT-6". If Jev persistently avoids a GPT-6 call
that evidence shows necessary, Root stops economic routing and takes over
(§11); Jev's answer is never silently rewritten. Records carry
`gpt6_eligibility_reason` only while open.

## 9. Privacy boundary and hot path

- Routing state is a **minimal field whitelist** under an explicit send
  policy. Prefer tool name, exit status, error codes, fixed-length error
  digests. Text fields are untrusted data; sensitive content is refused
  rather than truncated — a length cap is not send authorization.
- A call with no send eligibility skips Jev (§7) rather than sending.
- Logs persist no raw prompt or tool-output text by default.
- The Jev deadline is **short and derived from shadow latency data**, not a
  generic long timeout. Per-call latency and failure waits, not Jev token
  price, are the realistic overhead risk: a long timeout multiplied by a
  hundred follow-up calls stalls tasks by minutes.
- After a transport failure, Jev is skipped for the remainder of the task.

## 10. Independent verification at the task boundary

Per-call routing optimizes execution; it never proves success. At the end of
a Main Task, verification runs **outside the economic routing loop**:

- Acceptance conditions are read from the original user request, not from
  any model's summary.
- Diff, relevant tests, artifacts and run results are checked independently.
- Model self-report is never evidence; missing evidence is never PASS.
- Necessary semantic judgment uses the **fixed verification tier**; its cost
  counts in the task. Sensitive changes may trigger one independent recheck.

**PASS** requires every acceptance condition evidenced. **FAIL** records the
specific failing items, test results and diff locations, and bounded failure
facts are returned to the same session for correction. A task that cannot
complete verification remains unverified — never counted as PASS. Exact
contract: [verification](docs/sdd/delivery-lifecycle.md).

## 11. Correction cycles and Root takeover

- One **correction cycle** runs from an independent FAIL at a task boundary
  to the end of the next task-boundary verification. All model and tool
  calls in between count as one cycle. Per-call routing decisions are never
  counted individually.
- Default maximum **2 correction cycles**, then Root takeover: economic
  routing stops and Root completes the task itself.
- **Immediate** takeover: the same defect recurring, scope runaway,
  permission problems, or unclear context/execution identity — including Jev
  persistently avoiding a GPT-6 call that evidence shows necessary.
- Ordinary in-scope correction needs no new authorization; materially new
  scope does. Native permissions apply throughout; the router never
  overwrites the user's pre-existing changes (pre/post-task diff is
  recorded).

## 12. Cache economics

V1 **measures, never optimizes**: no cache-aware selector, no deadband, no
price-penalty formula. Every call records `model_input_tokens`,
`cached_input_tokens`, `cache_write_input_tokens` when observable, output
and reasoning tokens, switches and latency; unobserved values stay UNKNOWN.
The current model is given to Jev only so it can judge whether switching is
worth it — V1 sets no deadband.

V1 bypasses Jev routing only for: compaction-style infrastructure calls,
non-model tool operations, explicitly forced-model calls, calls refused for
egress, and the task's Jev-failure period. Tool-follow-up model calls
participate. If the controlled comparison (§14) shows switching worsens total
cost or completion, a minimal switch threshold may be trialed under a **new
policy version** — never retrofitted silently.

## 13. Router Compass

Per-call and per-task records only; aggregates are computed from them, not
re-persisted. Schema: [decision receipt](docs/sdd/decision-receipt.md).
UNKNOWN is never converted to zero and never counted as verified routing
attribution. Top-level product metrics are capped at eight: final completion
rate, first-pass rate, critical failure rate, Root takeover rate, actual
weighted cost per task, frontier tokens per task, Jev cost share, actual
model switches per task. Correction cycles, latency, tier shares, cache hits
and GPT-6 usage are diagnostic views. Compass consumes records and never
feeds back into online routing.

## 14. Savings claims

| Evidence level | May claim | May not claim |
| --- | --- | --- |
| Production observed | Actual model shares, usage, cache behavior, Jev overhead, verification pass rate, observed task cost | "Routing saved X%"; there is no same-task counterfactual |
| Historical replay | A re-priced estimate over real token traces under a stated price table, labeled `ESTIMATED/COUNTERFACTUAL` | That cheaper models produce the same tokens, tool paths, cache hits or quality |
| Controlled benchmark | Fixed-Terra comparison on a defined task group with equivalent acceptance, declared cache conditions and complete cost accounting, with intervals and failure stratification | Extrapolation to untested workloads or to subscription savings |

Historical replay is a small offline research script — the fastest
price-potential screen, never a runtime dependency or launch proof.
Benchmark design: [benchmark](docs/sdd/benchmark.md). The benchmark counts
Jev, verification, failures, corrections, takeover and all model calls in
every arm; quality is checked before cost.

## 15. What V1 does not build

Semantic demand formulas; task-kind tables; forced tier ladders; global
deadbands; runtime price/cache optimizers; multi-provider abstraction;
per-call worker isolation state machines; Task Capsules; fresh/continuation
worker paths; baseline/publication transactions for ordinary calls; online
learning from history; quota- or usage-driven selection; Skills/MCP/agent
candidate combinatorics (candidates are `(model, effort)` pairs only); any
second semantic selector. If a proposed subsystem does not demonstrably
improve routing quality, completion, safety or measured savings, it does not
belong in V1.

## 16. Validation

`npm test`, `npm run typecheck`, `git diff --check`. Tests concentrate on
real host switching, tool-call/streaming integrity, explicit model
constraints, shadow/off behavior, task verification and cost attribution —
not per-function replicas of implementation logic. UNKNOWN values must never
be coerced to zero anywhere in the accounting path.
