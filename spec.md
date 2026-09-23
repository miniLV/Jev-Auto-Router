# Jev Auto Router — Specification

This is the normative product specification for Jev Auto Router. The
[Runtime Routing Policy](skills/jev-auto-router/references/routing-policy.md)
is the sole runtime authority; [ADR 0017](docs/adr/0017-per-call-responses-routing.md)
records the architecture decision and [docs/solution.md](docs/solution.md)
explains it. Supporting documents and the current prototype may not override
this contract. A conflict closes Active routing.

## 1. Objective and scope

Jev Auto Router lets one live Codex session route each Responses **Model
Call** to a verified `(model, reasoning_effort)` **Candidate Pair**. Codex
continues to own the tool loop. Jev neither creates a task or worker nor
executes tools.

V1 is limited to the authenticated GPT-family pairs that the configured
caller edge has actually proved it can request. It preserves native Responses
SSE and JSON behavior, user control, authentication boundaries and task-level
quality checks.

## 2. Entry contract

- `jev/auto` is the only virtual model that enters Jev automatic routing.
- A request naming a real model is manual selection. Codex Router forwards it
  through its normal path without asking Jev or changing the requested model
  or reasoning effort.
- Each forwarded automatic request names a real model, never `jev/auto`. The
  authenticated caller edge must not route that request back to Jev Auto
  Router.
- The caller edge owns upstream authentication. Jev credentials and upstream
  credentials remain separate; neither Routing State nor telemetry may contain
  the latter.

## 3. Modes and fixed Fallback Baseline

The router has three modes:

- **OFF:** do not ask Jev; execute `jev/auto` with the Fallback Baseline.
- **SHADOW:** ask and validate one Jev Choice, record the proposal, but execute
  the Fallback Baseline.
- **ACTIVE:** execute a valid, accepted Jev Choice; otherwise execute the
  Fallback Baseline.

The **Fallback Baseline** is one configured `(model, reasoning_effort)` pair
proved requestable through the current caller edge. Its identity is versioned
with the caller-edge configuration. V1 has no universal `Terra/medium` default,
and OFF never restores the virtual `jev/auto` request or an inferred host
model. If the configured pair is no longer requestable, fail explicitly before
output starts.

The same Fallback Baseline covers OFF, infrastructure calls, a competing
routing authority, privacy refusal, insufficient Routing State, Jev timeout or
failure, malformed or version-mismatched answers, low confidence and Guard
rejection. Each condition retains a distinct recorded reason.

## 4. Routing State and privacy

Only allowlisted, structured facts may be sent to Jev:

- step type and mode;
- current real model when known;
- context-size bucket when observable;
- tool name, exit status, error class or code, and a fixed-length digest for a
  tool follow-up;
- bounded verification failure facts explicitly approved for routing; and
- Candidate Pair IDs plus approved capability and relative-cost metadata.

Raw user instructions, file contents, tool output, full conversation text,
secrets, authentication material and unapproved identifiers are forbidden.
Text truncation is not authorization. If the remaining facts are insufficient
to make the defined Choice, do not call Jev; use the Fallback Baseline with
`insufficient_routing_facts`.

## 5. Candidate Pairs and one Jev Choice

A Candidate Pair is an exact `(model, reasoning_effort)` combination that the
current authenticated caller edge has proved requestable. A model catalog or
UI listing alone is not evidence. Candidate construction only admits or
excludes pairs according to requestability, capability requirements and hard
user constraints; it does not rank candidates or act as a second selector.

Every eligible Model Call makes at most one Choice request to one pinned,
validated Jev version using a versioned question schema. The answer is one
Candidate Pair ID plus its confidence. The adapter performs exact lookup and
may not repair a model/effort mismatch or substitute another pair. Requested
and resolved Jev versions are recorded; an unvalidated version can run only in
Shadow Mode.

## 6. Guard and Apply

The Guard deterministically checks:

- answer schema and pinned version;
- exact membership in the current Candidate Pair set;
- current requestability and capability requirements;
- user hard constraints; and
- the confidence floor calibrated for the Jev and question versions.

A rejection uses the Fallback Baseline and its precise reason. Local code must
not make a second semantic model choice.

Apply may change exactly two semantic request fields: `model` and
`reasoning.effort`. It preserves input, instructions, tools, tool-call and
tool-result IDs, stream mode, metadata, service tier and all other request
semantics. The original request is retained only as the source to copy; it is
not a failure route for `jev/auto`.

## 7. Native execution behavior

- The authenticated caller edge receives one request for the applied real
  Candidate Pair.
- SSE status, headers, event order and event content are relayed as they
  arrive; the router must not wait for completion or observation before
  returning the first event. Non-streaming JSON preserves upstream status,
  relevant headers and body.
- Codex receives native Responses output and continues the same conversation
  and tool loop. The next Model Call is routed independently.
- Cancellation or client disconnect aborts whichever Jev wait or upstream
  generation is active and does not start a fallback request.
- Once upstream output has started, failure is reported for that call. The
  router must not switch models, replay the call or risk duplicate tools or
  billing.

## 8. Observation contract

Every automatic call records separately:

1. **Proposed Pair:** what Jev returned, if any;
2. **Applied Pair:** what Guard and mode caused the router to request; and
3. **Observed Pair:** what the upstream response authoritatively reports.

These values must never be copied into one another. Missing model, effort,
usage, cache or version data is `UNKNOWN`, never zero and never inferred from
the proposal. Records also include mode, reason, Candidate Pair set, Jev and
policy versions, latency, usage, cache facts and terminal status without raw
prompt, tool output or credentials. Observation cannot delay or modify the
native response stream.

## 9. Release evidence

Shadow Mode precedes Active for every Jev version, question schema,
Candidate Pair set, Fallback Baseline or caller-edge version. Shadow evidence
must establish routing-fact sufficiency, Choice validity, failure rate and
hot-path latency before activation.

A separate local controlled Active evaluation entry may execute real Codex
Model Calls to collect repeatable transport and paired-task evidence while the
formal production gate is still closed. It binds a frozen plan, exact
Candidate Pairs and Fallback Baseline, current caller-edge proof, catalog and
runtime versions; it listens on loopback only and writes artifacts marked
`EVALUATION_ONLY`. Those artifacts are evidence inputs for Issues 06/07, never
a production Active release report. The formal `main()` entry continues to
require the validated paired-evaluation report and cannot be switched into
evaluation mode by an environment variable or request header.

The transport gate is a repeatable real Codex A→B→A tool loop covering:
authentication, requested and observed model/effort when observable,
tool-result ID continuation, first SSE output before completion, cancellation
without replay and continuation after compaction. Missing evidence remains an
explicit gap; terminal character-by-character rendering is not a proxy release
gate.

## 10. Task outcome and value

Routing a call is not proof that the Main Task succeeded. Task quality is
assessed from the original acceptance conditions and independent evidence from
the delivered diff, tests and artifacts. Model self-report and Jev confidence
are not completion evidence.

Active routing and the fixed Fallback Baseline are compared on equivalent
tasks, repository state and acceptance criteria. Cost accounting includes all
model calls, Jev, cache behavior, allowed retries, failure and verification
overhead. Unknown usage cannot support a savings claim. Production observation
may report what occurred; causal savings require the controlled comparison.

## 11. Out of scope

- routing tools, turns, workers, Skills, MCPs or external providers;
- a local semantic classifier, task-to-model table, tier ladder or second
  Choice;
- automatic replay after output, quota bypass or silent provider switching;
- online learning, dynamic price optimization or unverified candidate growth;
- declaring quality or savings from model mix, historical repricing, Jev
  confidence or model self-report alone.

## 12. Validation

Documentation migration is checked with `git diff --check` and a repository
search for the retired `Terra/medium` default and OFF-to-original-request rule.
Runtime slices add full HTTP-chain behavior tests and run `npm test` plus
`npm run typecheck` before Active promotion.
