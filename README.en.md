# Jev Auto Router

[中文](README.md) | **English**

**One model decision per Codex user turn.** `jev-codex` launches the real Codex CLI, adds a virtual `jev-router` model to the picker, asks [TypeSafe Jev](https://docs.typesafe.ai/introduction) once per fresh user turn, and keeps the selected model pinned through the entire tool loop.

This is the first **turn-pinned Codex router**. It prioritizes a working loop, fewer switches, and cache-friendly behavior. The old per-call path is gone from the main entrypoint.

![Codex Turn Router main flow](docs/assets/codex-turn-router-flow-en.png)

![Codex Turn Router control loop](docs/assets/codex-turn-router-control-plane-en.png)

The control loop: pick → gate → run → learn.

- Usage, configuration and design trade-offs: [docs/codex-turn-router.md](docs/codex-turn-router.md)
- Test samples and methods: [docs/evaluation-plan.md](docs/evaluation-plan.md)

## Install

After the npm package is published:

```sh
npm install -g jev-auto-router
jev-codex
```

Or run it without a global install:

```sh
npx -y jev-auto-router
```

From source:

```sh
git clone https://github.com/miniLV/Jev-Auto-Router.git
cd Jev-Auto-Router
npm ci
npm run build
npm link
jev-codex
```

## Why turn-pinned, not every model call

```text
Session
└─ Turn: you send a message -> final answer
   ├─ Model Call 1
   ├─ Tool Call / Tool Result
   ├─ Model Call 2
   └─ ...
```

- **Model Call**: one request to a model. A request after a tool result is a new Model Call.
- **Tool Loop**: the model → tool → model cycle.
- **Turn**: from your message to the final answer.

Every model switch forces the new model to rebuild the prompt prefix. Deciding at the start of a turn and keeping the model fixed inside the tool loop limits rebuilds to at most one per user turn and avoids model oscillation mid-task.

Once the model is fixed, effort can move independently: use `configuration_update` to change the reasoning level, keep the request-level effort at its baseline, and replay earlier updates in place. The current implementation is **per-turn effort**, not per-step. That avoids an extra per-call classifier and never switches models just to change effort.

> [!WARNING]
> Alpha: effort routing is off by default, and `configuration_update` has not been validated against a live Codex + GPT cache yet. Set `JEV_CODEX_EFFORT_ROUTING=turn` for a small smoke test before enabling it long-term.

## Quickstart

Requires Node.js 22+, a signed-in Codex CLI, and a TypeSafe Jev key.

```sh
npm ci
npm run build
export JEV_API_KEY="<your-typesafe-jev-key>"
node bin/jev-codex.mjs
```

Or:

```sh
npm run codex      # build and launch the wrapper
npm link && jev-codex
```

All arguments are forwarded to Codex:

```sh
jev-codex resume --last
jev-codex exec "fix the failing test"
```

Without `JEV_API_KEY`, `jev-codex` still launches Codex; routing is simply disabled.

## What happens in a turn

```text
You send a message
  -> jev-codex launches real Codex with a temporary provider
  -> the proxy detects a fresh user turn
  -> ask Jev once: prompt + current model + context size + candidates
  -> policy gates: user override / low confidence / availability / price break-even / guards
  -> pin this turn's model + choose effort
  -> effort uses configuration_update; the model does not change
  -> the whole tool loop reuses the model; Jev is not asked again
  -> the next user turn may decide again
```

Selecting a concrete model in the picker bypasses automatic routing and passes the request through unchanged. Select `jev-router` to resume routing.

## Policy

- User says `use <tier>` / `use <model>`: user wins.
- Jev failure, timeout, invalid answer, or low confidence: keep the current model.
- Low confidence never downgrades; upgrades cap at balanced.
- Large context blocks downgrades; upgrades are still possible. The threshold is a heuristic; both directions rebuild the cache.
- Session guard: stop auto-switching after 12 fresh turns; stay stable for at least one turn after a switch; optional switch cap.
- After 30 minutes idle, the guard resets. The model is retained, but the next turn may re-evaluate.
- With a price table, downgrades use break-even; without one, fall back to the fixed context threshold.
- Cache warmth comes from response usage; a cold cache lets a downgrade bypass the rebuild gate.
- Upgrades need a trigger: recent failure, high Jev complexity, or an explicit user request.
- If the target tier is unavailable, move up to the nearest available tier.
- Long tier is off by default; enable with `JEV_CODEX_ALLOW_LONG=1`.
- Explicit `use ...` always bypasses session guards.

## Configuration

Full configuration: [docs/codex-turn-router.md](docs/codex-turn-router.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | required for routing | Jev key |
| `JEV_MODEL` | `jev-1.13.0` | Jev model |
| `JEV_CODEX_FAST_MODEL` | `gpt-6-luna` | fast tier |
| `JEV_CODEX_BALANCED_MODEL` | `gpt-6-sol` | balanced tier |
| `JEV_CODEX_STRONG_MODEL` | `gpt-6.1-sol` | strong tier |
| `JEV_CODEX_LONG_MODEL` | `gpt-6-astra` | long tier (off by default) |
| `JEV_CODEX_DOWNGRADE_MAX_CONTEXT_TOKENS` | `20000` | large-context downgrade gate |
| `JEV_CODEX_LOCK_AFTER_TURNS` | `12` | stop auto-switching after N turns (0 = off) |
| `JEV_CODEX_MAX_SWITCHES` | `0` | max switches per session (0 = unlimited) |
| `JEV_CODEX_SWITCH_COOLDOWN_TURNS` | `1` | stable turns after a switch |
| `JEV_CODEX_CACHE_TTL_MS` | `1800000` | idle time before guards reset |
| `JEV_CODEX_EFFORT_ROUTING` | `off` | set to `turn` to enable per-turn effort |
| `JEV_CODEX_EFFORT_CAP` | `high` | maximum effort |
| `JEV_CODEX_EFFORT_FALLBACK` | `high` | effort when scores are missing |
| `JEV_CODEX_PRICES` | unset | per-model price JSON for break-even |
| `JEV_CODEX_TASK_TURN_BUDGET` | `0` | expected task turns (0 = off) |
| `JEV_CODEX_UPGRADE_MODE` | `triggered` | upgrade trigger mode |
| `JEV_CODEX_SESSION_FILE` | `~/.codex-router/sessions.json` | persisted session pin |
| `JEV_CODEX_STRIP_ENCRYPTED_REASONING` | off | strip encrypted reasoning across models |
| `JEV_CODEX_COMMENTARY` | `1` | show routing result in Codex |
| `JEV_CODEX_LOG_FILE` | `~/.codex-router/decisions.jsonl` | redacted decision log |

The decision log stores prompt hash, length, model, tier, confidence, reason, context size and Jev scores. It never stores prompt text.

## Development

```sh
npm run typecheck
npm test
npm start          # proxy only, for debugging
```

Code layout:

```text
src/codex-router/
├─ cli.ts       launch real Codex with a temporary provider
├─ proxy.ts     /models injection, turn detection, model pin, streaming proxy
├─ policy.ts    overrides, confidence, availability, cache downgrade gates
├─ turn.ts      fresh user turn detection and conversation key
├─ jev.ts       Jev request construction, timeout, retry, response parsing
├─ config.ts    tiers, env config, candidate models
├─ cache.ts     price break-even and dynamic locks
├─ effort.ts    effort mapping and configuration_update replay
├─ usage.ts     response usage / cache warmth scanner
├─ session-store.ts  persisted session pin
├─ log.ts       redacted JSONL decision log
└─ types.ts     shared types
```

## Known boundaries

- Context size is estimated from serialized input length, excluding tools; the threshold is heuristic, not an exact token count.
- Price break-even requires a price table; without one it falls back to the fixed context threshold.
- Session pin is persisted locally per user; another machine will re-evaluate.
- Break-even uses estimated output and remaining-turn values, not a provider invoice.
- Encrypted reasoning cleanup is opt-in; compaction still needs live-session tests.
- Commentary modifies the Codex event stream; set `JEV_CODEX_COMMENTARY=0` for byte-identical forwarding.

## License

[Apache License 2.0](LICENSE)
