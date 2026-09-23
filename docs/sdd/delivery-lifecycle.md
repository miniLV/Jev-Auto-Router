# Task lifecycle and verification

> Legacy prototype design; superseded by [Scheme A](../solution.md). Its
> correction-cycle, takeover and Astra rules are not part of the current
> runtime contract.

This module owns task-boundary state, the independent verification
contract, correction-cycle counting and Root takeover. It never chooses a
model and it owns no worker, capsule, baseline or publication machinery:
the same Codex session executes every call under native permissions.

## Task state

~~~text
TaskState {
  task_id,                        // one Main Task
  status: running | verifying | completed | unverified | taken_over,
  correction_cycles,              // monotonic; default max 2
  astra_eligibility?: { reason_code, evidence_ref, expires_after_use: true },
  pre_task_diff_ref,              // user's pre-existing changes are never overwritten
  failure_facts?                  // bounded facts from the last FAIL
}
~~~

Counters are monotonic within one task. Labels, retries and transport
events never reset them. The next call after a verification FAIL is marked
`correction` and receives the bounded failure facts.

## Independent verification (task boundary)

Verification runs **outside the economic routing loop** at the end of a
Main Task. The verification step:

1. reads acceptance conditions from the **original user request** — never
   from a model's summary of it;
2. checks the complete diff, file scope, required artifacts and sensitive
   constraints;
3. runs relevant tests and verification commands itself;
4. uses the **fixed verification tier** for necessary semantic judgment;
   its cost counts in the task. Sensitive changes may trigger one
   independent recheck.

**PASS** requires every acceptance condition independently evidenced.
**FAIL** records the specific failing items, test results and diff
positions. Model self-report is never evidence; missing evidence is never
PASS. A task that cannot complete verification stays `unverified` — never
counted as PASS.

## Correction cycles and takeover

One **correction cycle** spans from an independent FAIL at a task boundary
to the end of the next task-boundary verification. All model and tool
calls in between — however many — count as one cycle. Per-call routing
decisions are never counted individually; the old "three worker
executions" accounting is deleted.

- Default maximum **2 correction cycles**; the next FAIL after that
  triggers **Root takeover**: economic routing stops and Root completes
  the task itself.
- **Immediate takeover**, regardless of cycle count: the same defect
  recurring after a correction; scope runaway; permission problems;
  unclear context or execution identity; Jev persistently avoiding a
  Astra call that evidence shows necessary.
- Jev's answer is never silently rewritten. Takeover is an explicit,
  recorded change of execution authority.

## Astra eligibility lifecycle

One verified reasoning-blocker evidence grants one eligibility for the
next call targeting that blocker. The eligibility is consumed by use or
cleared by resolution; it never persists across routine calls. An explicit
user mandate is a separate hard constraint enforced over its stated scope
— it is not an eligibility and does not expire mid-scope. See the
[routing policy](../../skills/jev-auto-router/references/routing-policy.md).

## Boundaries

Ordinary in-scope correction needs no new user authorization; materially
new scope does. Native permissions apply throughout. A pre/post-task diff
is recorded and the user's pre-existing changes are never overwritten.
Cancellation stops active work and disarms pending decisions; it never
triggers a takeover.
