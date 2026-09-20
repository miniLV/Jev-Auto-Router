# Jev Auto Router — Final Solution

> Status: **Approved architecture (V1), corrected per final technical review**
>
> Scope: **Codex-only, GPT-family-only, dynamic per-call routing inside one
> Codex session**
>
> Primary goal:
>
> **Use Jev to dynamically choose the cheapest GPT model + reasoning effort
> that can reliably handle each model call, while still proving at task
> completion that the work was actually completed correctly.**

---

## 1. Final design principles

The architecture is intentionally small:

```text
Every meaningful Codex model call
        ↓
Local proxy: OFF / privacy / infrastructure checks
        ↓
Compact routing state + valid (model, effort) candidate pairs
        ↓
Jev: one Choice over the pairs
        ↓        └─ failure / low confidence → Terra baseline (recorded)
Native Responses forwarding; record actual model + usage
        ↓
At task end: independent verification (outside the routing loop)
        ↓
Router Compass: quality + usage records
```

The core value is not "Jev picked a cheaper model". The real product value
is: **Jev picked a cheaper pair, the task still completed successfully, the
full delivery consumed less frontier capacity — and the records connect all
three.**

## 2. P0 — the per-call switching prerequisite

The entire per-call plan rests on one load-bearing assumption that is not
yet proven in this product: **the same Codex tool loop tolerates per-call
model switching.**

- The Codex App Server can select a model for a *new* turn, but cannot
  modify a running turn; mid-loop switching requires the Responses request
  path (the proxy). The current repository has no such proxy yet.
- Cross-model continuation surfaces (encrypted reasoning blocks,
  compaction content, tool-call IDs, streaming event shape) may break
  visibly or silently; prior cross-model failures in Codex are enough to
  require a runtime proof, not a design assumption.

The first implementation slice is therefore a verification, not a feature:

- Real Codex CLI, real four-tier models, one session, an A→B→A tool loop.
- Checked items: authentication, requested-vs-response model and effort,
  tool-call ID integrity, SSE event fidelity, cancellation, continuation
  and compaction across switches.
- Any critical item failing stops per-call promotion and reopens the host
  interface question. Proving cross-turn switching does not prove
  in-loop switching.

## 3. What changed from the previous design

Routing granularity moved from the TaskUnit/worker level to the **model
call inside the same Codex session**:

```text
User asks for a feature
  Call 1: Sol        — understand / plan
  Call 2: Luna Max   — read / mechanical tool step
  Call 3: Luna Max   — apply known edit
  Call 4: Terra      — resolve implementation issue
  Call 5: Sol        — reason about failing tests
  Call 6: Luna Max   — rerun / mechanical follow-up
Task complete → independent verification
```

Long sessions mix many cheap mechanical calls with few hard reasoning
calls; a fixed TaskUnit model overpays for the easy ones. Removed with the
old design: workers, capsules, fresh/continuation paths, per-call
isolation state machines, publication transactions, review lifecycles,
budget ledgers (see §23).

## 4. Four model tiers

| Tier | Product profile | Role | Ordinary availability |
| --- | --- | --- | --- |
| T0 | **Luna Max** | cheap mechanical / explicit work | Yes |
| T1 | **Terra** | default workhorse | Yes |
| T2 | **Sol** | strong reasoning / difficult implementation | Yes |
| T3 | **GPT-6** | scarce frontier escalation | **No — gated** (§11) |

- **Luna Max binds to `gpt-5.6-luna` at `max` reasoning effort.** If "Max"
  is a brand label rather than a distinct requestable effort, the catalog
  must expose the actually supported pairs and this document's naming must
  be corrected; a tier name must never imply an effort the host cannot
  request.
- Concrete model identifiers are resolved from trusted host discovery and
  recorded per session; model IDs never scatter through routing logic.
- `Terra/medium` is the default reliability baseline (§10).

## 5. Jev version policy

**Production routing pins a validated Jev version; `jev-latest` runs in
shadow evaluation only.**

Confidence thresholds are calibrated for a version; a floating alias can
replace the model without a release and shift the Choice distribution under
the frozen floor — mass fallback to Terra, or high-confidence routing of
hard corrections to Luna. The kill switch only stops losses after damage.

Rules:

- Active routing requests the pinned version and validates every response.
- Every decision records `jev_requested_version` and
  `jev_resolved_version` (UNKNOWN when not exposed), plus
  `question_schema_version` and `policy_version`.
- Comparisons are segmented by version, question schema and policy; an
  upgrade is a single configuration value changed after the segmented
  shadow comparison passes.
- If a deployment insists on active `jev-latest`, a detected resolved-version
  change must automatically demote it to shadow/baseline until validated —
  which is a more complicated pin, not an alternative.

## 6. Runtime flow

The same Codex session stays alive; the router never spawns a worker per
turn. It intercepts each meaningful Responses call:

```text
Codex session → model call → local proxy
  ├─ router OFF            → host's original model
  ├─ infrastructure call   → stable configured profile
  ├─ no send eligibility   → skip Jev; configured baseline
  ├─ Jev one Choice        → selected pair
  └─ failure / low conf.   → Terra baseline, reason recorded
→ native forwarding (streaming events unchanged)
→ usage + route recorded
```

The proxy is a thin decision + forwarding layer: Responses in → choose
route → update model/effort → Responses out. No parallel generic-agent
protocol is created.

## 7. Step awareness and privacy

Each call is classified: `user_turn`, `tool_step`, `correction`,
`verification`, `other`, `infrastructure`. This is context for Jev, never a
model selector. `infrastructure` and `verification` calls are excluded from
economic routing; `tool_step` calls participate.

Routing state is a **minimal field whitelist under an explicit send
policy**:

- every call: step type, current model, context-size bucket when observable;
- tool steps: tool name, exit status, error codes, fixed-length error
  digests;
- user turns and corrections: bounded, allowlisted facts.

Text fields are untrusted data; sensitive content is **refused, not
truncated** — a length cap is not send authorization. A call with no send
eligibility skips Jev and uses the configured baseline (`route_source =
bypass`). Logs persist no raw prompt or tool-output text by default. The
full session never leaves the host for routing; the routed model still
receives real context through the native call.

## 8. Candidate pairs and the single Choice

Candidates are **validated, host-requestable `(model, reasoning_effort)`
combinations** — pairs, not independent model and effort answers. Jev's
within-request questions are independent; asking model and effort
separately can yield a host-unsupported combination, and patching it
locally becomes a hidden second selector.

- One decision = one Jev request = **one Choice** over the eligible pairs;
  Jev decides model and effort together.
- Candidate construction only admits/excludes: pair unsupported by host
  discovery, tier disabled, user hard constraint, GPT-6 not admitted.
  It never ranks, never applies a task-type table, never shapes a
  shortlist.
- The adapter resolves the returned ID by exact lookup; it cannot fill or
  substitute.

The question expresses the objective directly: choose the lowest-cost
eligible pair that can reliably complete this call without materially
reducing the probability of task success; reserve stronger tiers for calls
that genuinely need them; avoid unnecessary switching when the current
model is already adequate, because switching can reduce prompt-cache reuse.
No local `complexity × weight` formula, no task-kind table, no fixed
ladder.

## 9. Failure behavior

| Trigger | Result |
| --- | --- |
| Valid Choice at/above the frozen floor | Execute the Jev pair |
| Low confidence | Configured baseline (default `Terra/medium`); recorded `fallback_reason` |
| Timeout (short hot-path deadline) | Baseline; `fallback_reason = timeout` |
| Malformed response | Baseline; `fallback_reason = malformed` |
| Jev transport failure | Jev skipped for the remainder of this task; baseline |
| Baseline unavailable | Keep the host's original request or fail explicitly; never silently switch external provider |
| Router OFF (kill switch) | Bypass Jev; restore the host's originally specified model |

This is fixed reliability handling, never a semantic second selector.
Neither the kill switch nor the fallback may secretly downgrade a
user-chosen Sol or GPT-6 request to Terra. The confidence floor is
configuration bound to the pinned Jev version and question schema,
observable in records, never tuned per task.

The **hot-path deadline** is short and derived from shadow latency data.
Jev's input price (~$0.042/M tokens public list) makes small-payload cost
negligible; per-call latency and failure waits are the realistic risk — a
20-second timeout across a hundred follow-up calls stalls a task for tens
of minutes. After a transport failure, Jev is skipped for the whole task.

## 10. GPT-6 gating

GPT-6 is rare and absent from the normal candidate set. Two distinct
mechanisms, never conflated:

- **Eligibility — "allowed to consider GPT-6."** One verified
  reasoning-blocker evidence (a Sol-class attempt produced an unresolved
  failure attributed by evidence to reasoning capability) grants **one
  temporary eligibility for the next call targeting that blocker**, cleared
  after use or resolution. An ordinary Sol failure must not leave ten
  routine tool calls exposed to GPT-6. Records carry
  `gpt6_eligibility_reason` only while open.
- **Mandate — "must use GPT-6."** An explicit user requirement is a **hard
  constraint enforced over its stated scope**. "Please review this change
  with GPT-6" means that call runs on GPT-6; Jev is not asked to prefer
  Terra.

With eligibility open, the next decision sees the four-tier set and Jev
still selects. The router never implements "Sol failed → automatically
GPT-6". If Jev persistently avoids a GPT-6 call that evidence shows
necessary, Root stops economic routing and takes over (§12); Jev's answer
is never silently rewritten.

## 11. Dynamic switching and prompt cache

Per-call routing trades a better-fit cheaper model against cache loss from
switching. Different models maintain separate caches; excessive flapping
can erase savings. A scenario to watch: long context alternating
Terra↔Luna, where the cheap model's output savings are smaller than new
cache writes plus latency.

**V1 measures, never optimizes.** No cache-aware selector, no deadband, no
price-penalty formula. Three mechanisms only:

1. **Jev sees the current model** — to judge whether switching is worth it.
   V1 sets no deadband.
2. **Every call records** input/cached/cache-write/output/reasoning tokens,
   switches and latency (unobserved stays UNKNOWN).
3. **Compass proves whether switching pays** — switches per task,
   cached-input ratio, cost of switched vs non-switched calls,
   first-pass/completion quality.

If the controlled comparison shows switching worsens total cost or
completion, a minimal switch threshold may be trialed under a **new policy
version** — never retrofitted silently.

V1 bypasses Jev routing only for: compaction-style infrastructure calls,
non-model tool operations, explicitly forced-model calls, calls refused for
egress, and the task's Jev-failure period. Tool-follow-up model calls
participate.

## 12. Task boundary: independent verification

Per-call routing optimizes execution; it never proves success.
**Verification lives at the task boundary, outside the economic routing
loop** — otherwise the executor and the verifier can both be the low tier
of the same session, and Compass records self-reported success.

- Acceptance conditions are read from the **original user request**, never
  from a model summary.
- Diff, relevant tests, artifacts and run results are checked
  independently; the verification step runs the checks itself.
- Necessary semantic judgment uses the **fixed verification tier** (not
  economically routed); its cost counts in the task. Sensitive changes may
  trigger one independent recheck.
- **PASS** requires every acceptance condition evidenced — complete diff,
  file scope, required artifacts, sensitive constraints. Model self-report
  is never evidence; missing evidence is never PASS.
- **FAIL** records the specific failing items, test results and diff
  positions; bounded failure facts return to the same session; the next
  call is marked `correction`. A task that cannot complete verification
  stays unverified — never counted as PASS.

### Correction cycles and Root takeover

One **correction cycle** = from an independent FAIL at a task boundary to
the end of the next task-boundary verification; everything in between
counts as one cycle. Default maximum **2 cycles**, then **Root takeover**:
economic routing stops and Root completes the task itself.

**Immediate takeover:** the same defect recurring, scope runaway,
permission problems, unclear context/execution identity — including Jev
persistently avoiding a GPT-6 call that evidence shows necessary.

Ordinary in-scope correction needs no new authorization; materially new
scope does. Native permissions apply throughout; pre/post-task diffs are
recorded and the user's pre-existing changes are never overwritten.

## 13. Router Compass

Every task answers one question: **what did Jev choose, did the task
finish correctly, and what was the complete cost?** Compass stores call
facts and one task conclusion; switch counts, tier shares and totals are
computed from the log, not re-persisted. Raw prompts and tool outputs
never enter default logs.

### 13.1 Call record

```text
task_id, call_index, step_type, mode(active|shadow|bypass)
policy_version, question_schema_version
jev_requested_version, jev_resolved_version
eligible_pairs, jev_choice, confidence
actual_model, actual_effort, route_source, fallback_reason
gpt6_eligibility_reason?                 # only while open
jev_input/output_tokens, jev_latency_ms
model_input/cached/cache_write/output/reasoning_tokens
model_latency_ms, call_status
```

### 13.2 Task record

```text
task_id, verification(PASS|FAIL), evidence_refs
first_pass, correction_cycles, root_takeover, critical_failure
```

**UNKNOWN is never converted to zero and never counted as verified routing
attribution.**

### 13.3 Metrics

At most eight top-level product metrics: final completion rate, first-pass
rate, critical failure rate, Root takeover rate, actual weighted cost per
task, frontier tokens per task, Jev cost share, actual model switches per
task. Correction cycles, latency, tier shares, cache hits and GPT-6 usage
rate remain diagnostic views.

## 14. Observed facts vs savings claims

| Evidence level | May claim | May not claim |
| --- | --- | --- |
| Production observed | Actual model shares, usage, cache behavior, Jev overhead, verification pass rate, observed task cost | "Routing saved X%"; no same-task counterfactual exists |
| Historical replay | Re-priced estimates over real token traces under a stated price table, labeled `ESTIMATED/COUNTERFACTUAL` | That cheaper models produce the same tokens, tool paths, cache hits or quality |
| Controlled benchmark | Fixed-Terra comparison on a defined task group, equivalent acceptance, declared cache conditions, complete cost accounting, with intervals and failure stratification | Extrapolation to untested workloads or subscription savings |

Historical replay is a **small offline research script** — the fastest
price-potential screen, never a runtime dependency or launch proof.
Its estimates assume identical token traces, cache behavior and execution
trajectories under the hypothetical route, which is exactly why they stay
labeled estimates.

Product savings claims require the controlled comparison: same
tasks/repository snapshot/acceptance, randomized order, declared cold/warm
cache conditions, counting Jev, verification, failures, corrections,
takeover and all model calls in both arms; quality checked before cost.

## 15. Shadow mode and replay

- **Shadow:** Jev decides, the would-be route is logged (`mode = shadow`),
  execution uses the configured baseline. Measures route distribution and
  Jev behavior without changing execution; calibrates the hot-path
  deadline; evaluates `jev-latest` against the pin.
- **Historical replay (offline):** extract real session calls, replay
  compact routing state through Jev, record would-be choices, re-price
  real token traces under hypothetical routes, report estimates labeled
  `ESTIMATED/COUNTERFACTUAL`.

## 16. Visible routing UX

A small per-call tag (e.g. `Terra:medium`) and a concise completion
summary (calls by tier, switches, verification result). The tag is emitted
via host UI metadata or a separate event channel; if no such interface
exists it appears only in the completion summary. **It is never injected
into the Responses content stream** — injected tags can corrupt structured
output or tool arguments. No verbose routing prose per turn.

## 17. Security boundary

Local-only service binding; secrets never logged; bounded allowlisted
routing state; sensitive content refused rather than truncated; no
arbitrary file content sent solely for routing; no hidden external
provider fallback; the actual selected pair always recorded; Jev failure
never crashes the user's task (explicit baseline). Failure degrades to
Terra, never escalates to GPT-6.

## 18. What V1 deliberately does not build

Weighted semantic demand formulas; task-kind-to-model tables; forced tier
ladders; global deadband/hysteresis; cache-dollar optimizers; generic
multi-provider abstraction; per-call worker isolation state machines; Task
Capsules; fresh/continuation worker paths; baseline/publication
transactions for ordinary calls; online adaptive learning from Compass;
model choice from account quota/ccusage; Skills/MCP/agent candidate
combinatorics; any second semantic selector. If a future feature cannot
demonstrate measurable value, it stays out.

## 19. Minimal runtime modules

Five runtime modules plus offline evaluation scripts; names are
responsibility suggestions, not required directories:

```text
proxy/         local Responses forwarding, shadow/off, short timeout,
               native streaming events unchanged
routing/       compact state, four-tier valid candidate pairs,
               GPT-6 temporary gate, one Jev Choice, fixed failure fallback
verification/  task-boundary PASS/FAIL, two correction-cycle counting,
               Root takeover
telemetry/     private local call log, task outcomes, Compass aggregation
entry/         startup, host model discovery, small configuration

bench/ (offline)  historical replay + fixed-Terra controlled comparison
```

## 20. Core pseudocode

```ts
async function routeModelCall(call, taskState) {
  if (routerOff()) return forward(call, call.originalModel);

  const step = classifyStep(call);
  if (step === "infrastructure" || step === "verification")
    return forward(call, FIXED_PROFILE[step]);

  const state = buildRoutingState(call, step);       // allowlisted fields
  if (!state.hasSendEligibility())
    return recordAndForward(call, BASELINE, "bypass", "privacy_refusal");

  const pairs = buildEligiblePairs(taskState);       // validated tuples
  const decision = await jevChoose(pinnedJev, state, pairs);  // one Choice

  const route =
    decision.valid && decision.confidence >= CONFIDENCE_FLOOR
      ? decision
      : fallbackToBaseline(decision.failureReason);  // fixed handling

  const result = await forwardWithRoute(call, route);
  recordCall(step, route, result);
  return result;
}
```

At the task boundary:

```ts
async function finishTask(task) {
  const verification = await independentVerify(task);  // fixed tier,
                                                       // outside routing
  recordTaskOutcome(task, verification);
  if (verification.pass) return accept(task);

  sendBoundedFailureFacts(task, verification);   // next call: correction
  maybeUnlockGpt6(task, verification);           // one-shot eligibility

  if (task.correctionCycles >= MAX_CORRECTION_CYCLES)  // default 2
    return rootTakeover(task);

  return continueSameSession(task);
}
```

## 21. Final architecture diagram

```text
                          ONE CODEX SESSION

User / Tool / Correction call
             |
             v
      +--------------------------------------+
      | local Responses proxy                |
      |  OFF? -> host model                  |
      |  infra call -> fixed profile         |
      |  privacy refusal -> baseline         |
      +------------------+-------------------+
                         |
                         v
      +--------------------------------------+
      | compact routing state                |
      | + valid (model, effort) pairs        |
      |   Luna / Terra / Sol (+GPT-6 gated)  |
      +------------------+-------------------+
                         |
                         v
                  +-------------+
                  | Jev: one    |
                  | Choice      |
                  +------+------+
                         |
            fail/low-conf+------> Terra baseline (recorded)
                         |
                         v
      +--------------------------------------+
      | native forwarding, unchanged events  |
      | record actual pair + usage           |
      +------------------+-------------------+
                         |
                 next model call ...
                         |
                         v
               Task completion boundary
                         |
                         v
      +--------------------------------------+
      | independent verification (fixed tier)|
      +---------+----------------------------+
                |
              PASS                FAIL
                |                   |
                v                   v
           Complete      bounded failure facts -> same session
                                    (correction)
                                    after 2 cycles -> Root takeover
                |
                v
      +--------------------------------------+
      | Router Compass: records only         |
      +--------------------------------------+
```

## 22. Why this solution is differentiated

A simple per-call router can show "Jev chose Luna" and estimate Luna is
cheaper. This solution adds the missing proof loop: the same session
actually executed on the chosen pairs, an independent gate verified
completion, real usage was recorded, and Compass measures quality,
routing overhead, model mix and frontier usage together. That combination
answers the central product question:

> **Did dynamic model switching actually save frontier capacity while still
> getting the coding task done?**

## 23. Repository migration summary

[ADR 0017](adr/0017-per-call-responses-routing.md) records the decision.
The prior TaskUnit/worker implementation (capsule, lifecycle,
baseline, exec, qualification, review, service, dashboard modules and their
tests) is replaced by the five-module V1 path; the old credit dashboard is
not Compass and moves out of routing V1 if it still has users. The old
benchmark harness converted UNKNOWN Jev usage to zero — its passing tests
are not economic evidence and must not be migrated as such. Exact file
actions live with the implementation tickets; this document is the target
they implement.

## 24. Final invariant

> **Every meaningful Codex model call goes through the local proxy; Jev
> makes one Choice over valid (model, effort) pairs; GPT-6 appears only
> under one-shot eligibility or explicit user mandate; failures fall back
> to a recorded Terra baseline; the same session continues; independent
> verification gates completion; Router Compass proves whether the routing
> was actually valuable.**

If a proposed subsystem does not clearly improve routing quality, task
completion, operational safety or measurable savings, it does not belong
in V1.
