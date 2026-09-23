# Decision records (Router Compass input)

> Legacy prototype schema; superseded by the Proposed/Applied/Observed
> observation contract in [Scheme A](../solution.md). Tickets 03–07 will
> replace it.

Per-call facts and one task conclusion. Records are evidence, never routing
authority: nothing reads a record to decide a future route, and Compass
aggregates records without feeding back into online routing.

## Call record

~~~text
CallRecord {
  task_id, call_index, step_type,
  mode: active | shadow | bypass,
  policy_version, question_schema_version,
  jev_requested_version, jev_resolved_version,   // resolved UNKNOWN when unexposed
  eligible_pairs[], jev_choice?, confidence?,
  actual_model, actual_effort,                   // UNKNOWN when unobserved
  route_source: jev | fallback | bypass,
  fallback_reason?,
  astra_eligibility_reason?,                      // only while open
  jev_input_tokens, jev_output_tokens, jev_latency_ms,
  model_input_tokens, model_cached_tokens, model_cache_write_tokens,
  model_output_tokens, model_reasoning_tokens,   // subsets: cached ⊆ input, reasoning ⊆ output
  model_latency_ms, call_status
}
~~~

## Task record

~~~text
TaskRecord {
  task_id,
  verification: PASS | FAIL,
  evidence_refs[],                               // diff, tests, artifacts, run results
  first_pass: boolean,
  correction_cycles, root_takeover: boolean, critical_failure: boolean
}
~~~

## Discipline

- **UNKNOWN is never converted to zero** and never counted as verified
  routing attribution, anywhere in the accounting path.
- Switch counts, tier shares, weighted costs and token totals are computed
  from records; they are not re-persisted.
- Raw prompts and tool-output text never enter default logs; the routing
  state's bounded digests are the only content-adjacent fields.
- `route_source` separates Jev selections from fixed fallback and bypass so
  no failure route is attributed to Jev, and no bypass is counted as a
  routing win.
- Top-level Compass metrics are capped at eight (final completion rate,
  first-pass rate, critical failure rate, Root takeover rate, actual
  weighted cost per task, frontier tokens per task, Jev cost share, actual
  model switches per task). Correction cycles, latency, tier shares, cache
  hits and Astra usage are diagnostic views.
- Savings claims follow the evidence ladder in
  [benchmark.md](benchmark.md); records alone support "observed" claims
  only.
