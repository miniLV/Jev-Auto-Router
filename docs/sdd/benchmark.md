# Benchmark and savings evidence

The benchmark qualifies the whole routing policy against a fixed-Terra
baseline. Model-share observations and re-pricings do not establish
savings.

## Evidence levels

| Level | Basis | May claim |
| --- | --- | --- |
| Production observed | Compass records from active/shadow runs | Actual model shares, usage, cache behavior, Jev overhead, verification pass rate, observed task cost. **Not** "routing saved X%" — no same-task counterfactual exists |
| Historical replay | Offline script re-pricing real session token traces under hypothetical routes | Estimates labeled `ESTIMATED/COUNTERFACTUAL`, under a stated price table. Not that cheaper models produce the same tokens, tool paths, cache hits or quality |
| Controlled benchmark | Fixed-Terra comparison on a defined task group | Quality-neutral cost differences with intervals and failure stratification, within the tested population only |

Historical replay is a small offline research script — the fastest
price-potential screen. It is never a runtime dependency and never a launch
proof: its estimates assume identical token traces and cache behavior under
the hypothetical route, which is exactly why they cannot support product
claims.

## Controlled comparison design

- **Arms:** fixed `Terra/medium` baseline vs the full routing policy. Pair
  repository snapshots, user intents and acceptance standards; randomize
  execution order; declare cold/warm cache conditions per run.
- **Complete cost accounting in both arms:** every model call (input,
  cached, cache-write, output, reasoning tokens), Jev calls, verification,
  failures, correction cycles, Root takeover and rework. Switch counts and
  cache-hit rates recorded per task.
- **Quality first:** completion and independent verification PASS under
  equivalent acceptance; only then compare weighted cost and frontier
  tokens. A cheaper arm with worse completion is a loss, not a saving.
- **UNKNOWN discipline:** unobserved usage is never coerced to zero
  (the retired harness's UNKNOWN→zero conversion was a defect, and its
  passing tests are not economic evidence). Missing usage is conservatively
  bounded or disqualifies the run from savings attribution.
- Report uncertainty, losing strata and failure stratification; no
  extrapolation to untested workloads or to subscription-credit savings.

## What the benchmark may change

If the controlled comparison shows switching worsens total cost or
completion (e.g. long contexts alternating Terra↔Luna where cache writes
exceed output savings), the response is a **new policy version** trialing a
minimal switch threshold — validated by the same ladder — never a silent
runtime patch.
