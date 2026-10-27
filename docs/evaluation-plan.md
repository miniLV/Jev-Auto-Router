# Evaluation plan: turn-pinned model + effort routing

This document defines how to measure whether the router actually saves cost
without losing quality. It is a plan, not a claim of measured savings.

## 1. What to prove

| Hypothesis | Question | Primary metric |
| --- | --- | --- |
| H1 | Does per-turn effort routing reduce cost on routine work without lowering acceptance? | Full cost, acceptance rate |
| H2 | Does the cache/economics gate avoid downgrades that would cost more than they save? | Net cost vs fixed baseline |
| H3 | Does turn-pinning beat per-call model switching on long sessions? | Cache rebuild tokens, total cost |
| H4 | Do upgrade triggers recover hard tasks without turning every turn into an upgrade? | Quality on hard strata, upgrade rate |
| H5 | Does persisted session state survive `codex resume` and compaction correctly? | Correct pinned model, stale-state failures |
| H6 | Does the guard layer fail safe when prices, usage or Jev are missing? | Fallback behavior, UNKNOWN handling |

Quality is evaluated before cost. A cheaper run that fails acceptance is not a
saving.

## 2. Arms

| Arm | Model | Effort | Purpose |
| --- | --- | --- | --- |
| A. Fixed baseline | strong model | high | Current realistic baseline |
| B. Effort-only | strong model | routed per turn | Isolate the cache-safe lever |
| C. Model + effort | turn-pinned, routed | routed per turn | Full router |
| D. Naive per-call model | routed every call | high | Demonstrate cache rebuild cost |
| E. Fixed cheap | cheap model | high | Lower-bound quality control |

D is a diagnostic arm, not a recommended product mode. Run it only on a small
subset because it can be expensive and noisy.

## 3. Sample tasks

Use paired tasks: the same repository snapshot, prompt, tool environment and
acceptance tests for every arm. Keep the task small enough to run repeatedly,
but varied enough to cover both simple and hard work.

| ID | Task | Difficulty | Acceptance |
| --- | --- | --- | --- |
| T01 | Rename one symbol across two files | trivial | build + targeted tests |
| T02 | Add a docstring to one exported function | trivial | lint + typecheck |
| T03 | Fix a typo in a config value | trivial | config test |
| T04 | Fix one failing unit test with a clear stack | easy | failing test turns green |
| T05 | Add a missing unit test for an existing function | easy | new test passes |
| T06 | Add a small CLI flag and its test | medium | hidden test + existing suite |
| T07 | Extract a helper into a new module | medium | build + all tests |
| T08 | Debug an unknown-cause failure with a misleading stack | hard | hidden regression test |
| T09 | Fix a concurrency race | hard | stress test + review |
| T10 | Tighten an auth/permission check | hard | security test + review |
| T11 | Add a backward-compatible migration | hard | migration + rollback test |
| T12 | Update an API across many files | long | repo-wide test + review |

Add 20–30 real tasks from a public benchmark such as SWE-bench Verified, split
into easy/medium/hard and filtered to tasks that fit the local tool environment.
Do not mix benchmark tasks and synthetic tasks in one aggregate without showing
them separately.

## 4. Session shapes

The routing unit is a turn, so the same task can behave differently depending
on session shape.

| Shape | Description | What it tests |
| --- | --- | --- |
| S1 One-shot simple | one user turn, 2–5 tool calls | cheap work should route down |
| S2 One-shot hard | one turn, 20–50 tool calls | per-turn effort cannot adapt inside the loop |
| S3 Ten-turn mixed | easy and hard turns alternate | model pin, effort changes, cache reuse |
| S4 Long context | 100k+ input, many turns | downgrade gate and cache rebuild |
| S5 Resume | exit and resume after 5 minutes | persisted pin is reused |
| S6 Long idle | resume after 30+ minutes | cache TTL resets guards |
| S7 Compaction | force context compaction | cache and effort provenance reset |
| S8 Failure/retry | upstream failure then retry | dedupe and upgrade trigger |
| S9 Unsupported effort | model without effort updates | request-level fallback |
| S10 Manual override | user says `use ...` | override bypasses gates |

Run S1–S3 for every task where practical. Run S4–S10 as focused scenarios on a
smaller task subset.

## 5. Metrics

Quality:

- acceptance test pass/fail;
- hidden tests pass/fail;
- independent review pass/fail;
- retries, rework, and root takeover count.

Cost, per task and per accepted task:

```text
full_cost =
  sum(input_uncached × input_price)
  + sum(cached_input × cached_price)
  + sum(cache_write_input × cache_write_price)
  + sum(output × output_price)
  + Jev calls
  + caller-edge charge
  + retries and verification calls
```

Cache:

- cached token share = `cached_input / input`;
- cache-write tokens per switch;
- number of model switches per session;
- number of effort updates per session;
- prefix rebuilds avoided by the gate.

Latency:

- time to first output;
- end-to-end latency;
- Jev latency (p50/p95).

Routing behavior:

- model and effort distribution;
- route reasons: `jev`, `cache-break-even`, `upgrade-not-triggered`,
  `session-lock`, `switch-budget`, `switch-cooldown`, `cache-cold`;
- fallback and UNKNOWN counts.

Never convert missing usage to zero. A missing bucket makes the task's full
cost `UNKNOWN`.

## 6. Procedure

1. Freeze the repository revision, task prompt, acceptance checks, model
   catalog, price table, tool versions, policy version and Jev version.
2. Create one cache condition per task: cold or warm. Record it before the run.
3. Randomize arm order per task; do not always run the baseline first.
4. For each arm, start from the same snapshot and clean process state.
5. Capture every physical model call, including Jev, retries and verification.
6. Record cache read/write tokens from provider usage, not estimates.
7. Run acceptance independently; the model's self-report is not evidence.
8. Repeat each task 3–5 times. Report per-task results and aggregate paired
   differences.
9. Use a paired bootstrap confidence interval for cost and acceptance deltas.
   Predefine a quality non-inferiority margin; a default starting point is
   −5 percentage points absolute, adjusted after pilot data.
10. Report all losing strata and `UNKNOWN` costs; do not hide them in an
    average.

## 7. Smallest useful sequence

Phase 0 — offline, no live model:

- request-shape tests: turn detection, tool continuation, retry dedupe;
- effort anchor tests: insert, reinsert, invalid anchor, compaction reset;
- gate tests: price break-even, cold cache, upgrade trigger, lock/cooldown;
- session store tests: load, save, TTL, no prompt text.

Phase 1 — pilot:

- 6 synthetic tasks (T01, T04, T06, T08, T11, T12);
- arms A, B, C;
- 3 repetitions;
- cold and warm cache.

Phase 2 — real workload:

- 20 real tasks, arms A/B/C;
- 3 repetitions;
- per-difficulty report.

Phase 3 — session shapes:

- S4–S10 on 3–5 tasks;
- measure cache rebuild, resume correctness and compaction behavior.

## 8. Pass criteria

A release candidate should meet all of these before claiming savings:

- acceptance non-inferiority: lower CI bound above the frozen margin;
- full cost reduction: lower CI bound above zero, after Jev, cache writes,
  retries and verification;
- no regression in critical failure or security tasks;
- no stale effort update after compaction;
- no model change inside a tool loop;
- no model switch on an identical retry;
- missing prices/usage produce a documented fallback, not a silent guess.

If quality fails, report cost without claiming savings. If cost is `UNKNOWN`,
do not claim savings.

## 9. Biggest benefit

The short answer: **yes, overpaying a frontier model for simple work is the
obvious waste, but the larger cache-safe lever is usually effort, not model
tier.**

Why:

- Model downgrade changes the rate on every token, but it forces the new model
  to rebuild the prompt prefix. On a long context, that rebuild can eat several
  turns of savings.
- Effort downgrade keeps the same model and the same prefix cache. It reduces
  reasoning and output tokens, which are not cached. It is usually the cleaner
  win for routine turns.
- Per-call model switching is the worst case: it rebuilds the prefix repeatedly
  inside one tool loop.
- A simple task still produces output and tool-call tokens. The saving depends
  on how much of the bill is output/reasoning versus cached input.
- Our current implementation is per-turn effort. A long single turn with many
  tool calls cannot lower effort mid-loop; per-step effort is the next lever,
  but it needs full history/provenance support.

A useful rule of thumb:

```text
save by effort first
then switch model only when price break-even clears
never switch model inside a tool loop
```

Test both, because the answer is workload-dependent.
