# ADR 0017: Route `jev/auto` per Model Call through an authenticated caller edge

Date: 2026-09-20
Status: Accepted (revised 2026-09-23)
Supersedes: the worker-era routing design and the earlier revision of ADR 0017

## Context

The product needs to choose a model and reasoning effort for successive Model
Calls inside one Codex conversation without replacing Codex's tool loop. A real
Codex A→B→A report established enough transport feasibility to adopt the
request-path architecture, while leaving effort fidelity, cancellation,
compaction and repeatability as explicit release evidence still to collect.

The first revision of this ADR assumed every meaningful Responses call entered
one proxy, used `Terra/medium` as the default fallback, and restored the host's
original model when routing was OFF. That contract cannot distinguish manual
real-model control from the virtual automatic entry and is incompatible with
the authenticated caller edge used by the proven path.

## Decision

1. **Entry and unit.** Codex selects the virtual model `jev/auto` to opt into
   automatic routing. Only that model enters the Jev Router. A real model ID is
   manual selection and follows the normal Codex Router path unchanged. The
   routing unit remains one Responses Model Call in the same Codex conversation;
   Codex continues to execute tools.
2. **Authenticated execution.** The Jev Router sends a real model ID through a
   caller edge whose authentication and requestability have been verified. The
   caller edge cannot recurse to `jev/auto`. Upstream credentials and Jev
   credentials are separate.
3. **Choice contract.** The router sends only allowlisted Routing State and
   caller-edge-proved Candidate Pairs to one pinned Jev version for one Choice.
   Guard validates the answer. Apply changes only `model` and
   `reasoning.effort`; native request and response semantics otherwise remain
   intact.
4. **Fallback contract.** One configured, caller-edge-proved Fallback Baseline
   handles OFF, infrastructure or competing authority, privacy refusal,
   insufficient facts, Jev failure, invalid or low-confidence answers and
   Guard rejection. Reasons remain distinct. The old universal
   `Terra/medium` default and OFF-to-original-request rules are retired. An
   unavailable baseline fails explicitly before output.
5. **Streaming and cancellation.** Native SSE or JSON is relayed without
   waiting for complete observation. Cancellation aborts the active Jev or
   upstream work. Once output starts, a failure is reported without changing
   models or replaying the request.
6. **Observation.** Jev's Proposed Pair, the Applied Pair and the upstream
   Observed Pair are independent facts. Missing model, effort or usage stays
   `UNKNOWN`; no field is backfilled from another.
7. **Promotion and value.** Shadow Mode precedes Active for each exact versioned
   configuration. Active promotion requires repeatable transport evidence,
   including continuation, early streaming, cancellation and compaction.
   Main Task quality is independently evaluated; savings require a complete
   paired comparison against the fixed baseline.
8. **Controlled evidence collection.** A separate `bench/` entry may run
   real local Codex calls in Active for a frozen plan so maintainers can
   collect the transport and paired-task evidence needed by Issues 06/07. It
   binds the exact proved Candidate Pairs, baseline, catalog, caller edge and
   runtime versions, listens only on loopback, and marks its sanitized run
   artifacts `EVALUATION_ONLY`. It is not called by `main()` and cannot satisfy
   the production Active report gate.

## Consequences

- The router is a small request adapter, not a worker/orchestration runtime or
  second Codex loop.
- Candidate availability is evidence from the current authenticated edge, not
  a catalog claim.
- Failure behavior stays deterministic without adding a local semantic
  selector.
- The existing prototype intentionally lags this decision until tickets 02–05
  migrate forwarding, streaming, mode and cancellation behavior.
- Changing the caller edge, Fallback Baseline, Candidate Pairs, Jev version,
  question schema or policy version requires new Shadow and transport evidence
  before Active use.
- The local evaluation process is evidence collection only. Production Active
  remains closed until the independent paired report passes the formal gate.
