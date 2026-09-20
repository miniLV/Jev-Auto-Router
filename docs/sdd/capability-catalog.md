# Capability catalog: model/effort availability

This module reports which `(model, reasoning_effort)` pairs the host can
actually request now. It enumerates valid pairs; it never ranks them,
assigns them task types or infers fitness.

## Discovery

~~~text
ModelCatalog {
  discovered_via,                  // trusted host model/list surface
  models[]: {
    model,                         // concrete identifier
    tier?: luna_max | terra | sol | gpt6,
    supported_efforts[],
    requestable: boolean           // trusted surface accepts it now
  },
  session_binding_digest,          // tier→identifier bindings, per session
  observed_at
}
~~~

- Discovery reads a trusted host surface (e.g. the Codex App Server model
  list with supported effort information). A model name seen in a file,
  config or listing without a requestable surface is **DISCOVERED only**
  and produces no pairs.
- Tier-to-model bindings are resolved once per session and recorded;
  `luna_max` binds to `gpt-5.6-luna` + `max`. If `max` is not a distinct
  requestable effort, the catalog must expose the actually supported pairs
  and the product naming must be corrected — a tier name never implies an
  unrequestable effort.
- UNKNOWN availability means absent: the pair is excluded with reason.
- No quota, account, usage, credit, model-mix or latency data enters this
  catalog; those are never routing inputs.

## Valid pairs

A pair enters the candidate set iff the model is requestable **and** the
effort is in its supported list, and no hard constraint excludes it (tier
disabled, user-forced model, GPT-6 gate). Exclusions are recorded with a
stable reason. Deduplicate equivalent pairs and hash the set for the
decision record.

The catalog contains only models and efforts. Skills, MCPs, agents and
tools are not candidates and are never enumerated here; candidates are
`(model, effort)` pairs only.
