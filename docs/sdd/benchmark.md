# Paired benchmark and savings evidence

The authoritative comparison is a preregistered, paired Main Task evaluation
of the configured Fallback Baseline and Active routing. Model shares and
historical repricing are not savings evidence.

## Evidence levels

| Level | Basis | May claim |
| --- | --- | --- |
| Production observed | Runtime call/task records | Actual route, usage, cache, latency and observed task outcomes; not causal savings |
| Historical replay | Existing token traces repriced under a hypothetical route | `ESTIMATED/COUNTERFACTUAL` price potential only |
| Controlled paired evaluation | Same frozen task, repository snapshot, input and acceptance in both arms | Quality and complete-cost results for the tested workload; no extrapolation beyond it |

## Preregistered comparison

Before either arm runs, commit a bundle that freezes the repository revision,
per-task snapshot/input/acceptance digests, independent review protocol, quality
floor and non-inferiority limits, rework/takeover limits, cost target, cache
conditions, randomized arm order, currency and price source. Bind it to the
exact Fallback Baseline, Candidate Pairs, caller-edge/catalog IDs, Jev version,
question schema and policy version. Each run records its start time and opaque
`kind:sha256:<hex>` references to independent evidence from its diff, tests and artifacts. The
evaluator rejects runs started before freeze, incorrect arm order, duplicate or
unpaired tasks, altered acceptance conditions, changed snapshots and
unconfigured pairs.

Each physical Model Call is recorded separately. This includes every upstream
call, Jev Choice, retry, correction and verification call. The report includes
completion and acceptance rates, independent quality, rework, Root takeover,
end-to-end latency and full cost. Cost adds the measured caller-edge charge
and prices input, cached input, cache-write input and output tokens separately;
reasoning tokens are reported as a subset of output and are not double charged.
An unknown bucket, rate or edge charge makes full cost `UNKNOWN`, never zero.

Each exact Candidate Pair receives its own pair-locked comparison and a decision
bound to the same edge, catalog, Jev version, question schema, policy and price
release. Active eligibility requires transport, cancellation, Shadow, quality
and cost gates all to pass. Missing or mismatched evidence stays `UNKNOWN` and
blocks the pair. The report provides separate baseline, Shadow and Active
completion, acceptance, quality, rework, takeover, latency and full-cost metrics
for each pair. Transport, cancellation and Shadow PASS gates must reference
sanitized review artifacts by content digest; an unreferenced PASS stays
`UNKNOWN`. The aggregate Active result cannot promote a candidate whose
individual decision is blocked.

## Interpreting results

Quality is evaluated before savings: lower completion, acceptance or quality,
excess rework or takeovers fail the frozen quality gate even if cost is lower.
The report still shows measured costs for a losing policy, but it will not mark
a savings claim eligible. Report sample size and losing strata with the
evidence; do not convert model mix or unknown usage into a quality or cost
claim.

For an eligible release, set `JEV_MODE=active`, point
`JEV_ACTIVE_EVIDENCE_FILE` at the saved report, set
`JEV_RELEASE_ID` to its release binding, and configure only candidate pairs
listed as Active-eligible. Startup verifies the report's candidate decisions,
baseline, caller-edge/catalog, Jev, policy and question-schema bindings.
Set `JEV_MODE=shadow` and restart to observe choices while executing the fixed baseline. Set
`JEV_ROUTER_OFF=1` and restart to use only the fixed baseline. These existing
configuration changes are the complete enable and rollback path; no deployment
control system is added.
