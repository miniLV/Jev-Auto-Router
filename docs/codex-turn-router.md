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
4. The policy applies explicit override, confidence, availability and the cache
   downgrade gate.
5. The proxy writes the real model into the request and forwards the CLI's
   authorization headers unchanged.
6. Tool-loop continuations keep the same model.
7. A new user turn may choose a different model.

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

An explicit `use <tier>` / `use <model>` always bypasses these guards. The
guards are stability heuristics, not a price model.

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
| `JEV_CODEX_JEV_TIMEOUT_MS` | `1500` | Per-attempt timeout |
| `JEV_CODEX_JEV_DEADLINE_MS` | `3000` | Total deadline |
| `JEV_CODEX_COMMENTARY` | `1` | Show a routing line in Codex |
| `JEV_CODEX_LOG_FILE` | `~/.codex-router/decisions.jsonl` | Redacted decisions |
| `JEV_CODEX_DEBUG` | off | Debug routing to stderr |

The decision log stores the prompt hash and character count, never the prompt
text. It also stores the chosen tier and model, confidence, reason, context
size and Jev scores.

## Design notes

- The virtual model is injected into the catalog returned by `GET /models`;
  the native model picker still contains every account model.
- A concrete model selected in the picker bypasses automatic routing.
- The proxy never stores or rewrites the CLI's authorization headers.
- Per-call proof catalogs, the external Codex Router and the install brief are
  not required by this path.
- The implementation is Codex only. Claude Code support is a later adapter.

## Known gaps

- The context size is estimated from the serialized input, not tokenized.
- The cache gate is a threshold, not a price-aware break-even calculation.
- Process restarts lose the in-memory pin; `codex resume` may re-decide.
- Encrypted reasoning items and compaction need explicit tests.
- The optional commentary modifies the Codex event stream; disable it if a
  byte-identical stream matters.
