# Runtime Routing Policy

This file is the sole canonical authority for automatic routing under the
Jev Auto Router architecture. It owns the runtime contract: the per-call
flow, candidate construction, the single Jev Choice, GPT-6 gating, fallback,
verification, and observation. `SKILL.md` is an installation/operation
guide. No other document, dashboard, model history, script or agent profile
may override it.

The division of authority is fixed and singular:

```text
Jev chooses.  The Guard validates.  Codex executes.  Verification proves.
```

The unit of routing is the **model call inside one live Codex session**.
Tools are never routed; what is routed is the next model call after a tool
result. There is no worker, capsule, fresh/continuation path or execution
budget in this contract. The [specification](../../../spec.md) owns product
invariants; [SDD](../../../docs/sdd/README.md) documents define exact
schemas. Neither may relax this policy; conflicts close routing.

## 1. Per-call flow

Every Codex Responses request passes through the local proxy:

```text
Codex Responses call
  |
  v
1. Router OFF? ............................ bypass; host's original model
  |
  v
2. Infrastructure call? ................... bypass; stable configured profile
  |
  v
3. Privacy check: send eligibility? ....... no  -> skip Jev; configured baseline
  |
  v
4. Build compact routing state
    + valid (model, effort) candidate pairs
  |
  v
5. Jev: one Choice over the pairs
  |          |
  |          +-- timeout / malformed / low confidence --> fallback baseline
  v
6. Guard validates the selection
  |
  v
7. Forward natively; record actual pair + usage
  |
  v
Task end -> independent verification (outside this loop)
```

The proxy forwards native streaming events unchanged and never rewrites
response content. A routing label is emitted via host UI metadata or a
separate event channel — if no such interface exists, only in the completion
summary — never inside the Responses content stream.

If another routing or orchestration authority governs the current requests,
this policy stands down: bypass to the host's original request.

## 2. Step classification

Each model call is classified as `user_turn`, `tool_step`, `correction`,
`verification`, `other`, or `infrastructure`. This is routing context for
Jev, never a model selector: no step type implies a tier, and no table maps
step type to model. `infrastructure` (compaction-style) and
`verification` (fixed verification tier) calls are excluded from economic
routing; `tool_step` calls participate.

## 3. Routing state and the privacy boundary

The state sent to Jev is compact and allowlisted:

- every call: step type, current model, context-size bucket when observable;
- tool steps: tool name, exit status, error codes, fixed-length error
  digests;
- user turns: bounded, allowlisted request facts;
- correction calls: the bounded failure facts produced by verification.

Text fields are untrusted data. Sensitive content is refused, not truncated:
a length cap is not send authorization. A call with no send eligibility
skips Jev and uses the configured baseline with `route_source = bypass`.
Logs persist no raw prompt or tool-output text by default. The full session
never leaves the host for routing; the routed model still receives native
context through the forwarded call.

## 4. Candidate pairs

Candidates are validated, host-requestable `(model, reasoning_effort)`
pairs built from trusted host discovery. **Luna Max binds to
`gpt-5.6-luna` + `max`; if `max` is branding rather than a requestable
effort, the catalog must expose the actually supported pairs and the tier
name must be corrected.** The normal set is the Luna/Terra/Sol pairs the
host supports.

Candidate construction only admits or excludes. It never ranks, never
applies a task-type table, never infers "cheap is enough for this shape".
Exclusions are deterministic and recorded: pair unsupported by host, tier
disabled by configuration, user hard constraint, GPT-6 not admitted (§6).

## 5. The single Choice

One decision = one Jev request = **one Choice** over the eligible pairs.
Jev selects model and reasoning effort together; the pair is the answer, so
no host-unsupported combination can be assembled and no local code may
patch one. The question expresses the product objective directly: choose
the lowest-cost eligible pair that can reliably complete this call without
materially reducing the probability of task success; reserve stronger tiers
for calls that genuinely need them; avoid unnecessary switching when the
current model is already adequate, because switching can reduce
prompt-cache reuse.

Production routing uses a **pinned, validated Jev version**; `jev-latest`
runs in shadow only (§9). Every decision records requested and resolved
versions, `question_schema_version` and `policy_version`. The adapter
resolves the returned ID by exact lookup; it cannot fill or substitute. The
Guard then validates deterministically: schema, choice membership, valid
probability/confidence values, hard constraints honored (§7). DENY maps to
the fallback baseline — never to another pair chosen locally.

## 6. GPT-6 gating

GPT-6 is absent from candidates unless:

1. **Eligibility** — one verified reasoning-blocker evidence (a Sol-class
   attempt failed for reasons evidence attributes to reasoning capability)
   grants one temporary eligibility for the next call targeting that
   blocker, cleared after use or resolution; or
2. **Mandate** — an explicit user requirement makes GPT-6 a hard constraint
   over its stated scope.

Eligibility admits GPT-6 to the candidate set; Jev still selects. The
router never implements "Sol failed → automatically GPT-6". An ordinary
failure must not leave routine tool calls exposed to GPT-6. If Jev
persistently avoids a GPT-6 call that evidence shows necessary, Root stops
economic routing and takes over (§8); Jev's answer is never silently
rewritten.

## 7. Fallback, kill switch, hot path

| Condition | Result |
| --- | --- |
| Valid Choice at/above the frozen confidence floor | Execute the Jev pair |
| Low confidence | Configured baseline (default `Terra/medium`); `fallback_reason = low_confidence` |
| Timeout (short hot-path deadline) | Baseline; `fallback_reason = timeout` |
| Malformed response | Baseline; `fallback_reason = malformed` |
| Guard DENY | Baseline; recorded reason |
| Jev transport failure | Jev skipped for the rest of this task; baseline |
| Baseline pair unavailable | Keep the host's original request or fail explicitly; never silently switch external provider |
| Router OFF | Bypass Jev; restore the host's originally specified model |

The fallback is fixed reliability handling, not a semantic second selector.
Neither it nor the kill switch may secretly downgrade a user-chosen Sol or
GPT-6 request to Terra. The confidence floor is configuration bound to the
pinned Jev version and question schema; it is never tuned per task at
runtime. The Jev deadline is short and derived from measured shadow
latency; its purpose is bounding user-visible latency, not ranking models.

## 8. Verification, correction cycles, takeover

At the task boundary, independent verification runs outside economic
routing: acceptance conditions are read from the original user request;
diff, tests, artifacts and run results are checked independently; necessary
semantic judgment uses the fixed verification tier; costs count in the
task. Model self-report is never evidence; missing evidence is never PASS.
A task that cannot complete verification remains unverified.

A FAIL sends bounded failure facts back into the same session; the next
call is marked `correction`. One correction cycle spans from that FAIL to
the end of the next task-boundary verification, regardless of how many
model or tool calls occur inside. Default maximum: **2 cycles**, then Root
takeover — economic routing stops and Root completes the task itself.
Immediate takeover: repeated same defect, scope runaway, permission
problems, unclear context/execution identity, or Jev persistently avoiding
a necessary GPT-6 call.

## 9. Shadow mode and observation

Shadow: Jev decides, the would-be route is logged (`mode = shadow`), the
actual request uses the configured baseline. Shadow is how `jev-latest` is
evaluated, how the hot-path deadline is calibrated, and how route
distributions are measured without changing execution. Router Compass
consumes per-call and per-task records only; nothing in it feeds back into
online routing. No quota, account, ccusage, credit, model-mix or latency
history is ever a routing input.

## 10. Never in this repository

No heuristic classifier, no task-kind table, no tier ladder, no
worker/capsule machinery, no cache/price optimizer, no online learning
loop, no second selector. If real evidence shows a specific gap, the
response is a new policy version with its own validation — not a silent
local patch next to Jev.
