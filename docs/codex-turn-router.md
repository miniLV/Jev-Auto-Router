# Codex turn router

The primary runtime is a small Codex wrapper. It starts the real Codex CLI with
a temporary provider, adds a virtual `jev-router` model to the picker, and asks
Jev once at the start of each user turn. The chosen model is pinned for the
whole tool loop.

The old per-call evidence path has been removed. Its history remains in git.

## Why a turn, not every model call

```text
Session
└─ Turn: one user message -> final answer
   ├─ Model Call 1
   ├─ Tool Call / Tool Result
   ├─ Model Call 2
   └─ ...
```

- **Model Call**: one request to a model. A tool result followed by another
  model request is a new Model Call.
- **Tool Loop**: the repeated model → tool → model cycle inside one turn.
- **Turn**: one user message and all work until the assistant finishes.

Switching the model inside a tool loop forces the next model to rebuild the
prompt prefix. A turn-level decision bounds that cost to at most one switch per
user message and keeps the tool loop on one model.

## Quick start

```sh
npm ci
npm run build
export JEV_API_KEY="<typesafe key>"
node bin/jev-codex.mjs
```

Or install the package link and use the command:

```sh
npm link
jev-codex
```

`jev-codex` forwards every argument to Codex. If no API key is present, it
starts Codex without routing.

## What happens on a request

1. Codex sends `POST /responses` with `model = jev-router`.
2. The wrapper reads the current user prompt. A tool result after the last user
   message is a continuation, so it reuses the pinned model.
3. On a fresh turn, it sends Jev the prompt, current model, approximate context
   size and available models.
4. The policy applies explicit override, confidence, availability, the cache
   downgrade gate, session guards and upgrade triggers.
5. The proxy writes the real model, selects effort from Jev's scores, and
   inserts/replays `configuration_update` items while keeping the top-level
   effort unchanged.
6. The proxy forwards the CLI's authorization headers unchanged.
7. Tool-loop continuations keep the same model and replay the existing effort
   updates.
8. A new user turn may choose a different model and effort.

The proxy adds one commentary line by default so the user can see the choice.
Set `JEV_CODEX_COMMENTARY=0` to disable it.

## Policy

- Explicit `use <tier>` / `use <model>` wins.
- Jev failure, timeout, malformed answer or low confidence keeps the current
  model.
- Low confidence never downgrades and caps upgrades at the balanced tier.
- A downgrade is refused when the estimated context is above
  `JEV_CODEX_DOWNGRADE_MAX_CONTEXT_TOKENS` (default 20,000). This is a
  heuristic: both upgrades and downgrades still rebuild the cache. The gate
  only blocks the case whose measurable saving is most likely to lose.
- An unavailable tier steps up to the nearest available tier.
- The long tier is disabled unless `JEV_CODEX_ALLOW_LONG=1`.

## Session stability

A long session can lose more to repeated cache rebuilds than it gains from a
late model change. Three optional guards protect the pinned model:

- `JEV_CODEX_LOCK_AFTER_TURNS` (default `12`): after this many fresh turns,
  automatic switching stops. `0` disables the lock.
- `JEV_CODEX_MAX_SWITCHES` (default `0`, unlimited): stop automatic switching
  after this many model changes in one session.
- `JEV_CODEX_SWITCH_COOLDOWN_TURNS` (default `1`): after a switch, keep the new
  model for at least one full turn before switching again.

`JEV_CODEX_CACHE_TTL_MS` (default 30 minutes) resets the lock, switch budget and
cooldown after the session has been idle past the cache lifetime. The model
stays pinned, but the next turn may re-evaluate because the old cache would be
cold anyway.

An explicit `use <tier>` / `use <model>` always bypasses these guards.

## Cache economics

When a price table is configured, the downgrade gate uses a break-even estimate
instead of the fixed context threshold:

```sh
export JEV_CODEX_PRICES='{
  "gpt-6-sol":   {"input": 1.0, "cached_input": 0.1, "cache_write_input": 1.25, "output": 4.0},
  "gpt-6.1-sol": {"input": 1.0, "cached_input": 0.1, "cache_write_input": 1.25, "output": 4.0},
  "gpt-6-luna":  {"input": 0.2, "cached_input": 0.02, "cache_write_input": 0.25, "output": 1.0}
}'
export JEV_CODEX_ASSUMED_REMAINING_TURNS=3
```

Include both the current and target model in the table. A missing price falls
back to the context threshold.

The estimate compares the target model's cache rebuild cost with the per-turn
saving over the remaining turns. Missing prices fall back to the fixed
`JEV_CODEX_DOWNGRADE_MAX_CONTEXT_TOKENS` gate. `JEV_CODEX_TASK_TURN_BUDGET`
declares an expected turn horizon; the router locks at
`budget - JEV_CODEX_LOCK_BEFORE_END_TURNS` and uses the remaining turns in the
break-even. `JEV_CODEX_OUTPUT_TOKENS_PER_TURN` estimates output cost.

## Effort routing

The model stays pinned while effort can change at a turn boundary. The router:

- keeps the request-level `reasoning.effort` as the baseline;
- maps Jev's `task_complexity` and `reasoning_required` scores to an effort;
- caps the result with `JEV_CODEX_EFFORT_CAP`;
- uses `configuration_update` items, never top-level effort changes;
- reinserts earlier updates at their original history anchors so the prefix
  stays cacheable;
- resets the baseline on compaction or a model change.

Effort routing only runs when the selected model advertises
`supports_reasoning_effort_updates` and supported efforts. It is per-turn, not
per-step. A model that does not support updates keeps the request-level path.

## Cache warmth

The proxy scans the response's terminal usage event for `cached_tokens` and
`cache_write_input_tokens`. It never rewrites the stream. A response with zero
cached tokens marks the current model cold; the next downgrade can skip the
rebuild gate. Observations older than `JEV_CODEX_CACHE_TTL_MS` are ignored.

## Upgrade trigger

With `JEV_CODEX_UPGRADE_MODE=triggered` (the default), a higher tier is only
accepted when at least one trigger holds:

- a recent upstream failure (`JEV_CODEX_UPGRADE_FAILURE_TTL_MS`);
- Jev's complexity signal at or above `JEV_CODEX_UPGRADE_COMPLEXITY_THRESHOLD`;
- an explicit user override.

Set `JEV_CODEX_UPGRADE_MODE=always` to restore the old behavior.

## Session persistence

Session routing state is stored in `~/.codex-router/sessions.json` (0600),
keyed by the conversation hash. It contains the model, tier, counters and cache
observation, never prompt text. Entries older than `JEV_CODEX_SESSION_TTL_MS`
are dropped. Set `JEV_CODEX_SESSION_FILE` to change the path.

## Compaction and encrypted reasoning

A compaction item resets cache warmth and the switch cooldown: the old prefix
is no longer the same cache. With
`JEV_CODEX_STRIP_ENCRYPTED_REASONING=1`, a cross-model continuation removes
provider-bound encrypted reasoning items and keeps any readable summary. This
is opt-in because it trades context fidelity for switchability.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | required for routing | Jev credential |
| `JEV_MODEL` | `jev-1.13.0` | Jev model |
| `JEV_ENDPOINT` | TypeSafe endpoint | Jev API |
| `JEV_CODEX_FAST_MODEL` | `gpt-6-luna` | Fast tier |
| `JEV_CODEX_BALANCED_MODEL` | `gpt-6-sol` | Balanced tier |
| `JEV_CODEX_STRONG_MODEL` | `gpt-6.1-sol` | Strong tier |
| `JEV_CODEX_LONG_MODEL` | `gpt-6-astra` | Long tier |
| `JEV_CODEX_ALLOW_LONG` | off | Enable the long tier |
| `JEV_CODEX_DEFAULT_MODEL` | strong tier | Model used before the first decision |
| `JEV_CODEX_MIN_CONFIDENCE` | `0.3` | Minimum confidence |
| `JEV_CODEX_DOWNGRADE_MAX_CONTEXT_TOKENS` | `20000` | Cache downgrade gate |
| `JEV_CODEX_LOCK_AFTER_TURNS` | `12` | Stop automatic switching after N fresh turns (`0` = off) |
| `JEV_CODEX_MAX_SWITCHES` | `0` | Max model changes per session (`0` = unlimited) |
| `JEV_CODEX_SWITCH_COOLDOWN_TURNS` | `1` | Full turns to keep a newly switched model |
| `JEV_CODEX_CACHE_TTL_MS` | `1800000` | Idle time before guards reset |
| `JEV_CODEX_EFFORT_ROUTING` | `turn` | `off` or per-turn effort |
| `JEV_CODEX_EFFORT_CAP` | `high` | Maximum effort |
| `JEV_CODEX_EFFORT_FALLBACK` | `high` | Effort when scores are missing |
| `JEV_CODEX_PRICES` | unset | Per-model JSON price table for break-even |
| `JEV_CODEX_ASSUMED_REMAINING_TURNS` | `3` | Remaining turns for break-even when no task budget |
| `JEV_CODEX_TASK_TURN_BUDGET` | `0` | Declared task horizon (`0` = off) |
| `JEV_CODEX_LOCK_BEFORE_END_TURNS` | `2` | Lock this many turns before the task horizon |
| `JEV_CODEX_OUTPUT_TOKENS_PER_TURN` | `1000` | Output estimate for break-even |
| `JEV_CODEX_UPGRADE_MODE` | `triggered` | `always` or `triggered` |
| `JEV_CODEX_UPGRADE_COMPLEXITY_THRESHOLD` | `0.8` | Jev score that counts as an upgrade trigger |
| `JEV_CODEX_UPGRADE_FAILURE_TTL_MS` | `600000` | How long a failure remains an upgrade trigger |
| `JEV_CODEX_SESSION_FILE` | `~/.codex-router/sessions.json` | Persisted session state |
| `JEV_CODEX_SESSION_TTL_MS` | `86400000` | Drop persisted sessions after this idle time |
| `JEV_CODEX_STRIP_ENCRYPTED_REASONING` | off | Remove encrypted reasoning on a model switch |
| `JEV_CODEX_JEV_TIMEOUT_MS` | `1500` | Per-attempt timeout |
| `JEV_CODEX_JEV_DEADLINE_MS` | `3000` | Total deadline |
| `JEV_CODEX_COMMENTARY` | `1` | Show a routing line in Codex |
| `JEV_CODEX_LOG_FILE` | `~/.codex-router/decisions.jsonl` | Redacted decisions |
| `JEV_CODEX_DEBUG` | off | Debug routing to stderr |

The decision log stores the prompt hash and character count, never the prompt
text. It also stores the chosen tier and model, confidence, reason, context
size, cache warmth, break-even evidence and Jev scores.

## Design notes

- The virtual model is injected into the catalog returned by `GET /models`;
  the native model picker still contains every account model.
- A concrete model selected in the picker bypasses automatic routing.
- The proxy never stores or rewrites the CLI's authorization headers.
- Per-call proof catalogs, the external Codex Router and the install brief are
  not required by this path.
- The implementation is Codex only. Claude Code support is a later adapter.

## Known gaps

- The context size is estimated from the serialized input, not tokenized; it
  excludes tool definitions.
- The price table is caller supplied. Missing prices fall back to the context
  threshold.
- Break-even uses an assumed output size and remaining-turn estimate; it is not
  a vendor bill.
- Persisted session state is local to this machine and user. Another machine
  starts from the default model.
- Compaction resets cache warmth, but real compaction and encrypted-reasoning
  stripping still need live-session tests.
- Cache warmth is observed from SSE `response.completed` usage only; a
  non-streaming JSON response leaves it unknown.
- The upgrade trigger sees upstream failures and Jev complexity, not tool-output
  errors.
- Encrypted-reasoning stripping is all-or-nothing when enabled; it may remove
  readable reasoning from the same model.
- The task horizon is caller declared, not inferred from task progress.
- The break-even uses input-only prefix size and an output estimate; it is not
  exact accounting.
- The optional commentary modifies the Codex event stream; disable it if a
  byte-identical stream matters.
