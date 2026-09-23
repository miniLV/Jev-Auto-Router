# Policy Guard

> Legacy prototype design; superseded by [Scheme A](../solution.md). Ticket 03
> will replace it. It is not a runtime contract.

Pure deterministic interface:
`validate(JevDecision, CandidateSet, Constraints) -> ALLOW(pair) |
DENY(reason)`. The returned pair is exactly the selected candidate. **Jev
chooses; the Guard validates.** Lifecycle implements the fixed fallback;
the Guard never selects an alternative.

## Checks

| # | Check | Failure |
| --- | --- | --- |
| 1 | Decision schema valid; decision ID unused; choice is a member of the exact candidate set | INVALID_DECISION |
| 2 | Confidence finite in [0,1] and at/above the frozen floor for the pinned version/schema | LOW_CONFIDENCE |
| 3 | Resolved pair is a validated host-requestable `(model, effort)` combination | PAIR_UNAVAILABLE |
| 4 | No user hard constraint violated (an explicit "must use Astra" or forced-model request executes as stated) | HARD_CONSTRAINT |
| 5 | Astra appears only under open one-shot eligibility or explicit mandate | ASTRA_NOT_ADMITTED |
| 6 | Response model matches the pinned Jev version | VERSION_DRIFT |
| 7 | Routing state passed the send policy (defense in depth for the proxy's check) | PRIVACY_REFUSAL |

Check 4 enforces user mandates over their stated scope — the Guard denies a
Sol selection for a call the user required Astra on, sending it to
fallback handling and ultimately Root intervention, never to a silent
substitution. Check 5 enforces scarcity: an eligibility that was consumed
or expired cannot admit Astra again.

## DENY semantics

DENY returns a reason, never another pair. The routing module falls back to
the configured baseline and records the reason; nothing re-asks Jev for the
same call. DENY is per-call: the next model call starts a fresh decision
with fresh candidates. Thresholds are frozen configuration bound to the
pinned Jev version and question schema; they are never tuned per task, and
the Guard never reads quota, usage, credit, model-mix or latency data.
