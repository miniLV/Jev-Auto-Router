# Issue 24: draft real paired task corpus

**Status:** DRAFT preparation only (2026-09-26). This file is for Root review;
it is not the frozen evaluation plan and does not authorize an arm to run.

This draft proposes four historical repository tasks as a small, representative
coding corpus. The source ticket is the canonical prompt and acceptance source.
The benchmark agent receives the task prompt and the matching archive; it does
not receive a post-fix diff, an answer patch, or a Git checkout containing
future history.

## Deliberately unset until the real run is frozen

The following are intentionally absent: `release`, `frozen_at`, the overall
repository revision, caller-edge ID, candidate catalog and exact Candidate
Pairs, Jev/policy/question-schema versions, confidence/deadline values, prices
and price source, the randomization seed, per-task `first_arm` order, intent or
acceptance digests, and any gate result (`PASS`, `FAIL`, or eligibility). A
maintainer must fill these in a new immutable `EvaluationPlan` before the first
baseline, Shadow, or policy arm. Changing the task set, acceptance, thresholds,
runtime binding, or price release requires a new plan and batch.

## Candidate task manifest

The IDs below are opaque draft IDs. Their source links are retained for audit;
they are not task IDs to use in a frozen run until their sanitized intent and
acceptance digests are computed.

| Draft ID | Source ticket | Snapshot commit | Reproducible archive command | SHA-256 of unprefixed tar |
| --- | --- | --- | --- | --- |
| `task-corpus-a` | [Issue 09: production upstream cancellation](../issues/09-production-upstream-cancellation.md) | `785619d1d1856b24e825bf07d90a28b425e546a6` | `git archive --format=tar 785619d1d1856b24e825bf07d90a28b425e546a6 > task-corpus-a.tar` | `99b629422ea2f022ad307190e1e35a580ba641c5697c41d935e07db05b270c12` |
| `task-corpus-b` | [Issue 12: allowlisted tool facts](../issues/12-allowlisted-tool-facts.md) | `856b15cf8aa7a001950c3a3b054acca1eff595ca` | `git archive --format=tar 856b15cf8aa7a001950c3a3b054acca1eff595ca > task-corpus-b.tar` | `bae507cdae80fb513c1a247e88e8ed526d697257d319262d940587b3355e7570` |
| `task-corpus-c` | [Issue 16: SSE terminal failure status](../issues/16-sse-terminal-failure-status.md) | `46ee3e74196d0f4ab9b28f2cc1c76e329415f719` | `git archive --format=tar 46ee3e74196d0f4ab9b28f2cc1c76e329415f719 > task-corpus-c.tar` | `c6edbba87f66f1457c51aa807b14dbc059eb426504d4406361abf238f3a67455` |
| `task-corpus-d` | [Issue 20: paired metric aggregation](../issues/20-unify-paired-metric-aggregation.md) | `a2378b826e5aa4853a3005ce69ffd92422e0d05d` | `git archive --format=tar a2378b826e5aa4853a3005ce69ffd92422e0d05d > task-corpus-d.tar` | `69a469911d9fc957e2990f770c0e0c9d66e61e81c970f1d1622e6ac1e49f854a` |

The command has no `--prefix`, so the digest is reproducible from the
repository object alone. Each archive is a tree snapshot, not a repository:
the distribution check is `! tar -tf task-corpus-*.tar | rg '(^|/)\.git(/|$)'`.
The four checks run on 2026-09-26 produced the exact digests above, found no
`.git` entries, and found the corresponding source ticket in every tree.

### task-corpus-a: production cancellation

**Plain-language prompt.** Work from this snapshot and make the production
`jev/auto` HTTP path carry the client's cancellation through any Jev wait or
upstream generation. A disconnect must stop the in-flight work and record one
cancelled call without sending a fallback or replay request. Preserve the
request and response behavior outside cancellation, and add a regression test
that exercises the production assembly path.

**Acceptance criteria transcribed from the source ticket.**

- The production upstream fetch receives the non-empty cancellation signal
  originating from the client request.
- A disconnect stops upstream work without fallback, replay, or a second
  upstream request.
- Cancellation while Jev is waiting sends no upstream request; cancellation
  after generation starts records exactly one `cancelled` call.
- A regression test fails if the production assembly drops the signal again.

**Provisional inclusion.** This is a bounded production wiring and transport
task with observable cancellation and request-count outcomes. Exclude it from a
future batch if the archive contains the target fix, the source prompt is
missing, or the run cannot observe cancellation and upstream request count.

### task-corpus-b: untrusted routing facts

**Plain-language prompt.** Work from this snapshot and enforce a small,
source-checked schema for facts sent to Jev. Client-controlled tool headers and
arbitrary model or control strings must not enter routing state, alter the
candidate set, or change Active eligibility. When no permitted facts are
available, use the fixed baseline and preserve the native tool result.

**Acceptance criteria transcribed from the source ticket.**

- With no trusted tool-fact source, values supplied by `x-jev-tool-facts` do
  not appear in the Jev payload; arbitrary header text is not sent out.
- `step_type`, `current_model`, `forced_model`, and boolean controls accept only
  their defined finite values; unknown strings do not enter Jev state or hard
  candidate constraints.
- Without qualified tool facts, no Choice is made on their basis; the fixed
  baseline and native tool-result forwarding remain unchanged.
- Tests cover object/array input, sensitive markers, and overlong input, and
  show that forged headers cannot change Active eligibility or the candidate
  set.

**Provisional inclusion.** This is a bounded privacy and routing-eligibility
task with externally inspectable payload and forwarding behavior. Exclude it
if the archive already contains the target behavior or if the run requires a
new trusted fact source that is not present in the snapshot.

### task-corpus-c: SSE terminal failure

**Plain-language prompt.** Work from this snapshot and keep native SSE bytes
and order while distinguishing completion from failure or incomplete EOF. If
the upstream emits a failure after output has started, the client must see the
original events, the call must be recorded as failed, and the router must not
switch models or replay the request.

**Acceptance criteria transcribed from the source ticket.**

- After `response.failed`, the call is not recorded as `ok` or completed, and
  the client receives the original failure event.
- A normal `response.completed` remains successful; an abnormal EOF without a
  valid terminal event is not treated as success.
- Failure after output never triggers a model switch, replay, or second
  upstream request.

**Provisional inclusion.** This is a bounded streaming-observation task with
  event-order, terminal-status, and request-count checks. Exclude it if the
  snapshot includes the target observer fix or if the harness cannot capture
  both the unmodified stream and the final decision record.

### task-corpus-d: paired metric aggregation

**Plain-language prompt.** Work from this snapshot and make the overall paired
report and each exact-candidate report derive completion, acceptance, quality,
rework, takeover, latency, and full cost from one consistent aggregation path.
Count each physical call once, include Jev, upstream, retry, correction,
verification, cache, and caller-edge accounting, and keep unknown usage as
`UNKNOWN` rather than zero.

**Acceptance criteria transcribed from the source ticket.**

- Completion, quality, rework, latency, and cost use one shared calculation
  rule in the overall and per-candidate report views.
- Tests detect duplicate billing, omitted Jev or caller-edge cost, and treating
  `UNKNOWN` as zero.
- The public report shape and existing valid fixtures remain compatible, or any
  necessary correction is explicitly documented.

**Provisional inclusion.** This is a real benchmark-maintenance coding task
with a bounded pure-function and test surface. Its source ticket labels its
historical behavior examples as synthetic; those old fixtures are not task
outcomes and must not be supplied as solution evidence. Exclude the task if
the benchmark agent is given the post-fix aggregation or fixture patch.

## Inclusion and exclusion rule

Include a task only when its exact pre-fix archive, source prompt, acceptance
criteria, and sanitized task materials are available before arm execution. The
task remains in the denominator if it fails, cannot complete, or needs a Root
takeover. Exclude before freezing only for missing or sensitive materials,
uncontrolled repository state, a target solution already present in the
snapshot, an absent prompt, or an acceptance condition that cannot be checked
independently. Never exclude a difficult task after seeing either arm's result.

The archive audit found **no candidate with a missing prompt or target-solution
marker**: at each listed snapshot the source ticket was present with
`Status: ready-for-agent`, no `## Answer`, no `Status: resolved`, and no checked
acceptance items. The target fix commits and all future Git history are not in
the tar distributions. No answer patch is part of this draft.

## Equivalent starting state and reset plan (DRAFT)

For every task, prepare independent copies from the verified tar bytes:

1. Verify the listed SHA-256 and reject any archive with a `.git` entry. Extract
   a fresh directory for the baseline arm, a fresh directory for the Shadow
   run, and a fresh directory for the policy arm. Do not use the shared dirty
   checkout or a worktree with history.
2. Install the snapshot's locked dependencies and use the same Node/runtime,
   OS settings, environment allowlist, task prompt, acceptance text, and test
   commands in every copy. Keep credentials and endpoints outside the archive.
3. Start each arm in a new session/process with no prior conversation, tool
   output, generated files, or model cache state inherited from another arm.
   Preserve only the declared task input and repository snapshot. The baseline
   executes the frozen Fallback Baseline; Shadow may request one Jev Choice but
   executes that same Fallback Baseline; policy executes the accepted routed
   pair or the same fallback under the runtime policy.
4. Run the same independent acceptance review against all arms. Record each
   physical call, failure, retry, correction, verification call, cache fact,
   elapsed time, and caller-edge charge. Do not copy a patch, answer, or
   generated artifact from one arm to another.

The future plan should use `declared-per-task` cache conditions and assign
`cold` or `warm` per task, but this draft deliberately sets neither values nor
arm order. A cold run starts with a fresh process, extracted directory, and
isolated cache namespace. A warm run may use only a predeclared, identical
warm-up protocol. Warm-up calls and cache reads/writes are part of the measured
cost. If cache state or caller-edge charges cannot be controlled and observed,
record `UNKNOWN` and do not make a savings claim.

## Blinded independent review and counting rubric (DRAFT)

The reviewer is separate from the run operator and is blind to arm, model,
Jev proposal, route reason, cost, and run order. The review packet contains the
opaque task ID, the source acceptance text, the final diff, test output, and
sanitized artifact references. Each arm gets independent evidence references
of the form `kind:sha256:<64 hex characters>`. Two reviewers should score
independently when available; an adjudicator records the reason for any
disagreement. Reviewer identity and adjudication policy remain to be frozen.

Score quality on a 0–5 scale:

| Score | Meaning |
| --- | --- |
| 5 | Every acceptance condition is evidenced; tests and artifacts are usable; the change is scoped and does not introduce a material defect. |
| 4 | All acceptance conditions pass with only minor non-material polish issues. |
| 3 | Partial delivery or a missing non-critical acceptance/evidence item; correction is required. |
| 2 | A substantial acceptance condition fails, or the result has a material correctness, privacy, or reliability defect. |
| 1 | The result is largely unusable or does not address the requested task. |
| 0 | No reviewable delivery, or a critical prohibited behavior makes the result unusable. |

`completed` means the arm produced a reviewable final attempt. `accepted` is
true only when every acceptance condition is independently evidenced; an agent
or model saying “done” is not evidence. Any failed terminal call, missing
artifact, failed test, or prohibited replay remains recorded and cannot be
removed because a later call succeeds.

One rework cycle runs from an independent acceptance FAIL to the next task
boundary review. All model, Jev, retry, correction, and verification calls in
that interval count once toward the cycle. The initial attempt has zero
rework cycles. A Root takeover is recorded whenever Root takes over for an
unresolved or repeated defect, scope/permission problem, or exhausted review
cycle; it remains counted even if Root later produces an accepted result.
Unaccepted and incomplete tasks stay in the denominator.

## Provisional gates (DRAFT, not frozen and not evaluated)

These are starting points for Root review only; they are not values in an
`EvaluationPlan` and do not imply any result:

| `EvaluationPlan.gates` field | DRAFT value | Unit and rule |
| --- | ---: | --- |
| `minimum_quality_score` | `4.0` | Mean independent score on the 0–5 rubric. |
| `maximum_completion_regression` | `0.00` | Policy completion and acceptance rates may not be below baseline by more than this proportion. |
| `maximum_quality_regression` | `0.25` | Policy mean quality may not be below baseline by more than this score. |
| `maximum_added_rework_per_task` | `0.00` | Policy mean rework cycles per task may not exceed baseline by more than this amount. |
| `maximum_added_takeover_rate` | `0.00` | Policy takeover proportion may not exceed baseline by more than this amount. |
| `maximum_policy_cost_ratio` | `0.95` | Complete policy cost divided by complete baseline cost; unknown cost remains `UNKNOWN`. |

The exact values, sample-size interpretation, and any justified changes must
be frozen before execution. No gate is marked `PASS` in this document.

## Complete cost and source policy (DRAFT)

Count every physical Jev Choice, upstream Model Call, allowed retry,
correction, independent verification, cache read/write, and measured
caller-edge charge in the arm that incurred it. Supply input, cached-input,
cache-write-input, output, and reasoning token fields for each call. Cached and
cache-write tokens are input subsets; reasoning tokens are an output subset and
are not charged twice. Unknown usage, price, or caller-edge charge makes the
complete arm cost `UNKNOWN`; it is never silently zero and cannot support a
savings claim.

At freeze time, the maintainer must name an authoritative price source, capture
its currency and effective time, preserve the complete rate table and weights
digest, and bind them to the exact runtime release. This draft intentionally
names no source, price, edge, or candidate. Historical issue text and the
pre-fix archive digest are the task provenance; model self-report, Jev
confidence, historical repricing, and the old Issue 20 synthetic fixtures are
not quality evidence.

## References

- [Issue 24](../issues/24-preregister-paired-evaluation.md) — freeze contract.
- [Product specification, §§9–10](../../../spec.md#9-release-evidence) —
  Shadow/Active evidence and paired task value.
- [Runtime Routing Policy](../../../skills/jev-auto-router/references/routing-policy.md#10-task-evidence)
  — task evidence and complete-cost boundary.
- [Paired evaluator](../../../bench/paired-evaluation.ts) — plan fields,
  pairing validation, UNKNOWN handling, review references, and metric rules.
- [Offline evaluation README](../../../bench/README.md#freeze-before-running) —
  bundle and evidence requirements.
- [Local issue tracker](../../../docs/agents/issue-tracker.md) — source of the
  repository-local ticket convention.
