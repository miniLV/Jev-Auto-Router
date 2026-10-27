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
| Decision Record | A redacted record of one turn decision. It contains a prompt hash and length, never prompt text. |
| Commentary | The optional one-line Codex event that reports the route. It can be disabled with `JEV_CODEX_COMMENTARY=0`. |

## Invariants

- One Jev decision per fresh turn.
- No model change inside a tool loop.
- A concrete model selected by the user bypasses automatic routing.
- Jev receives only the current prompt, current model, context size and candidates.
- A failed or low-confidence decision keeps the current model.
- The long tier is opt-in.
