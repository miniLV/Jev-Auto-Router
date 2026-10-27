# Shared Context

Codex-only, turn-pinned model routing. The runtime entry is `jev-codex`.
The design rationale, usage and configuration live in
[docs/codex-turn-router.md](docs/codex-turn-router.md).

## Glossary

| Term | Definition |
| --- | --- |
| Session | The whole Codex conversation or thread. It can contain many turns and may be resumed later. |
| Turn | One user message and all work until the assistant gives its final answer. A session contains many turns. |
| Model Call | One request to a model. A tool result followed by another model request is a new Model Call. |
| Tool Loop | The repeated model → tool → model cycle inside one turn. It never changes the model by itself. |
| Fresh Turn | A request that contains a current user message and no tool result or assistant continuation after it. |
| Pinned Model | The concrete model chosen for a turn and reused by every Model Call in its tool loop. |
| Tier | A policy label for a capability level: `fast`, `balanced`, `strong` or `long`. A tier maps to a concrete model. |
| Candidate Model | A model offered to Jev for the current turn. The list comes from the native Codex catalog plus configured fallbacks. |
| Policy Gate | The deterministic layer that turns a Jev answer into the final tier: user override, confidence, availability and the cache downgrade gate. |
| Cache Rebuild | The work a newly selected model must do to process a prompt prefix it has not cached. Every model switch pays it. |
| Downgrade Gate | The rule that refuses a cheaper-tier switch when the estimated conversation context is above the configured threshold. |
| Session Lock | The rule that stops automatic switching after a configured number of fresh turns. |
| Switch Budget | The maximum number of model changes allowed in one session. |
| Switch Cooldown | The minimum number of full turns a newly switched model stays pinned before another switch. |
| Cache TTL | The idle interval after which the session stability guards reset because the old prefix cache would be cold anyway. |
| Cache Warmth | Evidence from the last response usage that the current model's prefix was cached. A cold cache lowers the cost of switching. |
| Price Break-even | The estimated number of turns needed for a downgrade's per-turn saving to repay the target model's cache rebuild. |
| Upgrade Trigger | The condition that permits moving to a stronger tier: explicit user request, a recent failure, or a high complexity signal. |
| Session Store | The redacted persisted routing state keyed by conversation hash, with a TTL and no prompt text. |
| Task Horizon | The caller's declared total turn budget. It can lock the model earlier than the session cap. |
| Decision Record | A redacted record of one turn decision. It contains a prompt hash and length, never prompt text. |
| Commentary | The optional one-line Codex event that reports the route. It can be disabled with `JEV_CODEX_COMMENTARY=0`. |

## Invariants

- At most one Jev decision per fresh turn; session guards may skip it.
- No model change inside a tool loop.
- A concrete model selected by the user bypasses automatic routing.
- Jev receives only the current prompt, current model, context size and candidates.
- A failed or low-confidence decision keeps the current model.
- The long tier is opt-in.
