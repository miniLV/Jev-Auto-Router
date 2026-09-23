# Jev adapter

> Legacy prototype design; superseded by [Scheme A](../solution.md). Ticket 03
> will replace it. It is not a runtime contract.

The single seam where the Jev API appears. Interface:
`choose(RoutingState, CandidateSet, PolicyRef) -> JevDecision`. It does not
discover models, forward requests, grant permissions or invent routes.

## Request

- Send only the allowlisted `RoutingState` and the validated candidate
  pairs. One request carries exactly **one Choice** whose options are the
  `pair_id`s; Jev decides model and effort together. There is no second
  question and no local patching of an unsupported combination — the
  adapter resolves the returned ID by exact lookup and cannot fill or
  substitute.
- Payload stays far below Jev input limits by construction: a fixed field
  whitelist with a small cap. Sizing uses a fixed conservative bound; no
  per-call tokenizer work on the hot path.
- A call with no send eligibility never reaches this seam (the proxy
  bypasses to baseline first).

## Version discipline

- Production requests the **pinned, validated Jev version** and validates
  every response's model ID. `jev-latest` is a shadow-evaluation alias
  only; if used actively despite this rule, a detected change in the
  resolved version must demote routing to shadow/baseline until the new
  version is validated.
- Every decision records `jev_requested_version`,
  `jev_resolved_version` (UNKNOWN when the provider does not expose it),
  `question_schema_version` and `policy_version`.
- Credentials stay in transport; never in state, logs or records. Approved
  HTTPS origin only; no cross-origin redirects.

## Hot path and failure mapping

The deadline is **short and derived from shadow latency data** — a generic
long timeout multiplied by hundreds of follow-up calls stalls tasks. At
most one fast retry inside the deadline for transport-level failures;
malformed, drift and non-retryable 4xx are terminal immediately.

| Event | Result |
| --- | --- |
| Valid answer at/above the frozen floor | `JevDecision.valid = true` with pair + confidence |
| Valid answer below the floor | failure `floor`; fallback baseline (`low_confidence`) |
| Deadline exceeded | failure `timeout`; fallback baseline |
| Network/transport failure (retry exhausted) | failure `transport`; fallback baseline **and Jev skipped for the remainder of the task** |
| Schema-invalid body, unknown pair ID, model drift | failure `malformed`; fallback baseline |
| Missing authentication/configuration | failure `transport` subreason `auth`; fallback baseline |

The floor is configuration bound to the pinned version and question
schema — supplied by policy, never invented here. The adapter emits typed
results; provider bodies never escape through thrown errors. It never
emits a fallback route itself: fallback is the routing module's fixed
handling, recorded with `route_source = fallback`.
