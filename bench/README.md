# Offline evaluation (bench)

Offline research scripts only — never a runtime dependency and never a
launch proof.

- `config.ts` — frozen release config and price weights. Prices live only
  here; the runtime never sees them.
- `fixtures.ts` — sanitized session traces and the offline replay policy.
- `harness.ts` — historical replay and the fixed-Terra controlled
  comparison.

## Historical replay

Re-prices real token traces under hypothetical routes. Every output is
labeled `ESTIMATED/COUNTERFACTUAL`: it cannot claim that cheaper models
produce the same tokens, tool paths, cache hits or quality. It is the
fastest price-potential screen, nothing more.

## Controlled comparison

Fixed `Terra/medium` baseline vs the full routing policy on a defined task
group: paired snapshots, equivalent acceptance, declared cache conditions,
randomized order. Quality is checked **before** cost — a cheaper arm with
worse completion is a loss, not a saving. Both arms count every model call,
Jev overhead, verification, corrections and Root takeover.

## UNKNOWN discipline

Unobserved usage is never coerced to zero. Any UNKNOWN entering an
aggregate makes the aggregate UNKNOWN and the run is reported with
`unobserved_calls`; it cannot support savings attribution. (The retired
harness converted UNKNOWN Jev usage to zero — a defect, not a precedent.)
