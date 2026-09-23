# Runtime Routing Policy

This file is the sole canonical authority for Jev Auto Router runtime
behavior. The [product specification](../../../spec.md) defines product
invariants; this policy defines how one request is handled. No Skill,
Dashboard, model history, script, supporting document or current prototype may
override it. A conflict or unverifiable precondition closes Active routing.

```text
Codex chooses the entry.  Jev proposes.  Guard validates.
Apply changes two fields.  The caller edge executes.  Evidence evaluates.
```

## 1. Entry boundary

Route by the requested model identifier, not by prompt text:

| Request | Runtime action |
| --- | --- |
| Real model ID | Manual route: forward through the normal Codex Router path unchanged by Jev Auto Router |
| `jev/auto` | Automatic route: apply this policy |
| Any other virtual or unknown ID | Outside this policy; do not infer an automatic route |

An automatic request sent upstream must contain a real model ID. The
authenticated caller edge must bypass `jev/auto` and must not recurse into
this router. It owns upstream authentication; Jev receives neither upstream
credentials nor the native request body.

## 2. Per-call flow

```text
Codex Responses request
  |
  +-- real model --------------------------> normal direct path
  |
  +-- jev/auto
        |
        +-- OFF / infrastructure / competing authority
        |                                      -> Fallback Baseline
        |
        +-- privacy refusal / insufficient facts -> Fallback Baseline
        |
        +-- build verified Candidate Pairs + allowlisted Routing State
        |
        +-- one pinned-version Jev Choice
        |       |
        |       +-- failure / invalid / low confidence -> Fallback Baseline
        |
        +-- Guard
        |
        +-- SHADOW ------------------------> Fallback Baseline
        |
        +-- ACTIVE ------------------------> accepted Candidate Pair
                 |
                 v
        Apply model + reasoning.effort only
                 |
                 v
        authenticated, non-recursive caller edge
                 |
                 v
        native SSE or JSON returned immediately
```

The next Model Call repeats this flow. Codex remains in the same conversation
and continues its own tool loop.

## 3. Routing modes

- **OFF:** no Jev request. Apply the fixed Fallback Baseline and record
  `router_off`.
- **SHADOW:** perform the eligible Jev request and Guard checks; record the
  proposal and result; apply the Fallback Baseline with `shadow_mode`.
- **ACTIVE:** apply an accepted proposal. Any non-accepted outcome applies the
  Fallback Baseline with its exact reason.

Shadow Mode must pass before Active for the exact Jev version, question schema,
Candidate Pair set, Fallback Baseline, policy version and caller-edge version.

## 4. Routing State and send eligibility

The Jev payload is an explicit whitelist:

- step type and routing mode;
- current real model and context-size bucket when observable;
- tool name, exit status, error class or code, and fixed-length error digest;
- approved bounded verification failure facts; and
- Candidate Pair IDs with approved capability and relative-cost metadata.

It never includes raw instructions, native Responses input, file contents,
tool output, full conversation text, secrets, authentication material or
unapproved identifiers. Text is untrusted; truncation does not authorize
egress.

If privacy checks reject any required fact, do not call Jev and record
`privacy_refusal`. If the permitted facts cannot support the versioned Choice
question, do not call Jev and record `insufficient_routing_facts`. Both use
the Fallback Baseline.

## 5. Candidate Pairs

Each candidate is one exact `(model, reasoning_effort)` pair proved
requestable through the current authenticated caller edge. UI discovery or a
model catalog alone is insufficient. The evidence binds the pair to the
caller-edge version.

Candidate construction is deterministic admission:

- admit only proved, currently enabled pairs that satisfy capability and user
  hard constraints;
- exclude every other pair with a recorded reason; and
- never rank, shortlist by task shape, repair an answer or choose a semantic
  substitute.

An empty set or unavailable required capability uses the Fallback Baseline
when that pair remains requestable; otherwise fail before output.

## 6. Jev Choice and Guard

One eligible Model Call makes at most one Jev request and exactly one Choice
over the Candidate Pair IDs. Production uses a pinned, Shadow-validated Jev
version and a versioned question schema. Record requested and resolved versions;
an unvalidated or mismatched version is not Active-eligible.

The adapter resolves the returned ID by exact lookup. Guard validates schema,
version, membership, requestability, user hard constraints and the calibrated
confidence floor. Guard is deterministic and never selects another pair.

These outcomes use the Fallback Baseline and retain distinct reasons:

| Condition | Reason |
| --- | --- |
| Jev deadline exceeded | `jev_timeout` |
| Jev transport or service failure | `jev_failure` |
| Malformed answer | `invalid_choice` |
| Requested/resolved version mismatch | `jev_version_mismatch` |
| Confidence below the frozen floor | `low_confidence` |
| Any deterministic Guard rejection | the specific Guard reason |

## 7. Fallback Baseline

The Fallback Baseline is a configured, fixed Candidate Pair proved
requestable through the current caller edge. It is reliability handling, not a
second selector. All fallback and bypass reasons in this policy execute that
same pair.

There is no policy default such as `Terra/medium`. OFF does not restore the
virtual `jev/auto` request, a previous real model or an inferred host model.
If the pair is unavailable, fail explicitly before output and do not switch
provider or choose an unproved pair.

## 8. Apply and authenticated execution

Apply creates the upstream request by changing only:

- `model`; and
- `reasoning.effort`.

Input, instructions, tools, tool-call and tool-result IDs, stream flag,
metadata, service tier and all other semantics remain unchanged. The caller
edge receives one request for a real model and performs upstream
authentication without exposing those credentials to Jev.

SSE status, relevant headers, events and order are forwarded as received; the
first event must not wait for response completion or telemetry. Non-streaming
JSON preserves upstream status, relevant headers and body. Observation runs
off the response path.

Cancellation or disconnect aborts the active Jev wait or upstream request and
records cancellation. It does not trigger the Fallback Baseline. After any
upstream output begins, a failure is returned as that call's failure; there is
no model switch, replay or second upstream request.

## 9. Observation

Record three independent values:

- `proposed_pair`: Jev's answer, if one existed;
- `applied_pair`: the pair placed in the upstream request; and
- `observed_pair`: the pair authoritatively reported upstream.

Never backfill one from another. Unobserved model, effort, version, usage or
cache facts are `UNKNOWN`, not zero. Also record mode, reason, eligible pairs,
Jev/question/policy/caller-edge versions, latency, usage and terminal status.
Raw request text, tool output and credentials are absent by default.

Telemetry and Dashboard data are observation only. Usage, quota, credits,
historical model mix and prior latency never select a route.

## 10. Task evidence

Per-call routing does not determine task completion. At the Main Task boundary,
evaluate the original acceptance conditions from the delivered diff, tests and
artifacts. Jev confidence and model self-report are not evidence.

Active promotion requires the repeatable transport checks in the product
specification. A savings claim additionally requires a paired comparison
against the same Fallback Baseline under equivalent task state and acceptance,
counting Jev, all model calls, cache behavior, retries, failures and
verification. UNKNOWN usage cannot support the claim.

## 11. Forbidden additions

No local semantic classifier, task-kind table, tier ladder, second Choice,
worker/capsule state machine, cache or price optimizer, online learning loop,
quota bypass, external-provider fallback, response-content rewrite or replay
after output belongs in this policy.
