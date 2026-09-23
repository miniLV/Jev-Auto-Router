# Routing state, candidates and route schemas

> Legacy prototype schema; superseded by [Scheme A](../solution.md). Ticket 03
> will replace it. It is not a runtime contract.

Repository-owned schemas for one routed model call. Jev wire fields are
private to the adapter seam. See [capability-catalog.md](capability-catalog.md)
for pair validation and [decision-receipt.md](decision-receipt.md) for the
recorded outcomes.

## Compact routing state

~~~text
RoutingState {
  task_id, call_index,
  step_type: user_turn | tool_step | correction | verification | other | infrastructure,
  current_model?,                // so Jev can judge whether switching pays
  context_size_bucket?,          // when observable
  tool_facts?: {                 // tool_step only, allowlisted
    tool_name, exit_status,
    error_codes[], error_digest? // fixed-length digest, never raw text
  },
  user_turn_facts?,              // bounded allowlisted facts
  correction_facts?              // bounded failure facts from verification
}
~~~

`RoutingState` is the entire payload Jev receives. It is constructed under
the privacy send policy: text fields are untrusted data, sensitive content
is refused rather than truncated, and a call with no send eligibility never
reaches Jev. The session itself never leaves the host.

## Candidate pairs

~~~text
CandidatePair {
  pair_id,                       // stable hash of (model, effort)
  tier: luna_max | sol | astra,
  model, reasoning_effort,       // validated host-requestable combination
  exclusion_reason?              // only on excluded records
}
CandidateSet { pairs[], excluded[], digest, policy_version }
~~~

Pairs are validated `(model, reasoning_effort)` combinations — never
independent model and effort answers. Construction admits or excludes
deterministically (unsupported pair, disabled tier, user hard constraint,
Astra gate) and never ranks, never shapes a shortlist, never applies a
task-type table. `luna_max` binds to `gpt-6-luna` + `max`; if `max` is not
requestable, the catalog must expose the supported pairs and the tier naming
must be corrected. The set digest binds the decision for reproducible
records.

## Decision and outcome

~~~text
JevDecision {
  decision_id, candidate_set_digest,
  jev_requested_version, jev_resolved_version,   // resolved may be UNKNOWN
  question_schema_version,
  chosen_pair_id?, confidence?,
  valid: boolean, failure_reason?  // timeout | malformed | transport | floor
}
RouteDecision {
  decision_id, task_id, call_index, step_type,
  mode: active | shadow | bypass,
  route_source: jev | fallback | bypass,
  selected_pair,                  // executed or would-be (shadow)
  fallback_reason?,               // when route_source != jev
  astra_eligibility_reason?        // only while eligibility is open
}
~~~

One decision = one Jev request = **one Choice** over `pairs`. The adapter
resolves `chosen_pair_id` by exact lookup; it cannot fill, substitute or
repair. `route_source` distinguishes Jev selections from fixed fallback and
bypass so no fallback is ever attributed to Jev. A `shadow` decision never
changes execution. Fallback semantics and the bypass conditions are owned by
the [routing policy](../../skills/jev-auto-router/references/routing-policy.md)
and are not redefined here.
