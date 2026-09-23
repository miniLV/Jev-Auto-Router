# Solution — Jev-driven per-call routing for Codex

Status: **Approved Scheme A**, 2026-09-23.

This document explains the architecture selected by
[ADR 0017](adr/0017-per-call-responses-routing.md). The
[product specification](../spec.md) and sole
[Runtime Routing Policy](../skills/jev-auto-router/references/routing-policy.md)
are normative.

## Problem

A Codex task alternates between straightforward tool follow-ups and difficult
reasoning. The user wants Jev to choose an eligible model and reasoning effort
for each Model Call while Codex keeps one conversation, one tool loop, native
streaming, manual model control and its existing upstream authentication.

The old proxy prototype intercepted a broader request set, assumed a
`Terra/medium` default and treated OFF as restoration of a host model. Those
rules do not fit the proven caller-edge topology and would make `jev/auto`
ambiguous. Scheme A replaces them rather than combining both designs.

## Architecture

```text
Codex (one conversation)
  |
  | Responses(model = jev/auto)
  v
Codex Router
  |
  v
local Jev Router
  |  admission -> one Jev Choice -> Guard -> Apply
  |
  | Responses(model = real ID, reasoning.effort = chosen effort)
  v
authenticated, non-recursive caller edge
  |
  v
real GPT model
  |
  +---------------- native SSE or JSON ----------------> Codex
```

A request naming a real model does not enter this path. It remains a manual
Codex Router request. The automatic path never sends `jev/auto` upstream, so
the caller edge cannot recursively invoke the local router.

## Responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Codex Router | Distinguishing `jev/auto` from real model IDs | Semantic model selection |
| Admission | Privacy checks, fact sufficiency and caller-edge-proved Candidate Pairs | Ranking candidates |
| Jev | One Choice among the admitted pairs | Authentication, permissions or fallback |
| Guard | Deterministic version, membership, constraint and confidence checks | A replacement semantic choice |
| Apply | Replacing `model` and `reasoning.effort` | Any other request mutation |
| Caller edge | Upstream authentication and one real-model request | Routing back to `jev/auto` |
| Observation | Proposed, Applied and Observed facts | Blocking or changing the response |
| Task evaluation | Delivery quality and complete cost | Online route selection |

## Request lifecycle

1. **Enter.** A real model ID takes the normal direct route. Only `jev/auto`
   enters the local Jev Router.
2. **Resolve mode.** OFF immediately chooses the fixed Fallback Baseline.
   Shadow and Active continue through admission when eligible.
3. **Admit facts.** Build the allowlisted Routing State. Privacy refusal or
   insufficient facts chooses the baseline with its own reason.
4. **Build candidates.** Include only exact model/effort pairs proved
   requestable through this caller edge and compatible with hard constraints.
5. **Ask Jev once.** A pinned version answers one Choice over pair IDs before a
   short deadline.
6. **Guard.** Validate version, schema, membership, current requestability,
   hard constraints and the calibrated confidence floor.
7. **Choose execution pair.** Shadow uses the baseline; Active uses an accepted
   proposal. Every other outcome uses the same baseline with a distinct reason.
8. **Apply.** Change only `model` and `reasoning.effort`.
9. **Execute and relay.** The caller edge authenticates one upstream request.
   Stream or return the native response immediately while observation records
   facts independently.
10. **Continue.** Codex executes any tool and the next Model Call repeats the
    lifecycle inside the same conversation.

## Fixed baseline and failure boundaries

The Fallback Baseline is not a product-wide model name. It is one configured
pair with live requestability evidence for the current caller edge. OFF,
infrastructure or competing routing authority, privacy refusal, insufficient
facts, Jev timeout/failure, answer/version errors, low confidence and Guard
rejection all choose this pair while preserving distinct reasons.

If the baseline is unavailable, the request fails before output. The router
does not restore the virtual request, infer a host model, switch providers or
make another semantic selection.

Cancellation aborts the work currently in flight. It does not become a
fallback request. If upstream output has begun, any later failure is reported
for that Model Call; changing models and replaying could duplicate tools or
cost, so it is forbidden.

## Privacy and authentication

Jev receives only approved structured routing facts and Candidate Pair
descriptions. It does not receive the native input, raw user instructions,
files, tool output, conversation text or credentials. A bounded string is not
automatically safe; the send policy must allow the field.

The caller edge alone holds upstream authentication. The local router can apply
a real model pair but cannot copy, log or expose the caller's credentials.
Jev's own credential is a separate secret.

## Native protocol behavior

Apply preserves tools, tool IDs, input, stream mode, metadata, service tier and
all fields except model and effort. For SSE, upstream status, relevant headers,
event order and content reach the client without waiting for completion or
telemetry. For JSON, status, relevant headers and the complete body are
preserved.

This makes the router a request adapter in Codex's existing loop. It is not a
new task, worker, agent protocol or tool executor.

## Observation

Each call stores separate columns for:

- the pair Jev proposed;
- the pair actually applied to the upstream request; and
- the pair upstream metadata authoritatively observed.

It also stores eligible pairs, versions, mode, reason, latency, usage, cache
facts and terminal status. Missing facts are `UNKNOWN`; proposal and applied
values cannot fill gaps in observed execution. Logs omit raw request and tool
text and all credentials.

## Release sequence

1. Adopt this contract and retire conflicting rules.
2. Prove the fixed Fallback Baseline through the authenticated edge with direct
   real-model bypass, immediate SSE/JSON relay and cancellation.
3. Run Jev in Shadow Mode; measure fact sufficiency, proposal validity, failure
   rate and latency while executing only the baseline.
4. Enable Active Apply for the exact validated versions and Candidate Pairs.
5. Exercise every pre-output fallback plus post-output failure and cancellation
   boundary.
6. Capture repeatable real A→B→A evidence, including effort when observable,
   tool-result continuity, early streaming, cancellation and compaction.
7. Compare Active with the fixed baseline on equivalent Main Tasks, quality
   gates and complete cost before making an enablement or savings claim.

## Evidence interpretation

The existing A→B→A summary supports cross-model continuation, authentication,
tool-result continuity and HTTP streaming before completion. It does not by
itself prove effort fidelity, cancellation, compaction, exact component
versions or reproducibility. Those gaps stay visible until the live-evidence
slice closes them. Terminal character-by-character display is not a proxy
release requirement.

Task success is judged from the original acceptance conditions and independent
delivery evidence. Jev confidence and model self-report are not quality
evidence. Cost comparisons count Jev, every upstream call, cache behavior,
allowed retries, failures and verification; unknown usage is never zero.

## Deliberately absent

There is no task-type classifier, tier ladder, second selector, worker
orchestration, response rewrite, automatic replay, external-provider fallback,
online learning or runtime price/cache optimizer. Candidate expansion and
version changes return through Shadow and transport validation.
