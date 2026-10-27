# ADR 0018: Route Codex at turn boundaries with a CLI wrapper

Date: 2026-10-27
Status: Accepted
Supersedes: ADR 0017 for the primary runtime path

## Context

ADR 0017 routed every Responses Model Call. That unit is too fine for a live
coding session. A model switch makes the next model rebuild the prompt prefix:
the old model's cache is not reusable. A tool loop can contain dozens of model
calls, so per-call routing can rebuild that prefix repeatedly and can also
change the model mid-task.

The repository already contains a working turn-boundary pattern in its own
experiments: a local wrapper launches the real Codex CLI with a temporary
provider, injects a virtual model into the model catalog, asks Jev once at the
start of a user turn, and pins the chosen model for the rest of that turn. The
same pattern removes the external Codex Router, the caller-edge proof manifest
and the header-based control plane from the critical path.

The product target is Codex only. The first version should be usable before it
is maximally evidence-rich.

## Decision

1. **Entry.** `jev-codex` launches the real Codex CLI. It adds a temporary
   `jev` provider whose base URL is a loopback proxy, selects the virtual model
   `jev-router`, and injects that model into the catalog returned by
   `GET /models`. A concrete model selected by the user passes through
   unchanged and pauses automatic routing for that request.
2. **Routing unit.** One Jev decision per fresh user turn. A fresh turn is a
   request that contains a current user message and no tool result after it.
   Tool calls, tool results and other continuations reuse the model pinned at
   the start of the turn. The router must not change model inside a tool loop.
3. **Cache boundary.** A downgrade is refused when the estimated context is
   above a configurable threshold. Upgrades are not blocked by that threshold,
   because their benefit is quality and avoided failure rather than token
   savings. The threshold is a heuristic, not a cost model; both directions
   still pay a cache rebuild.
4. **Policy.** The decision layer is deterministic: explicit user override
   wins; a failed, malformed or low-confidence Jev answer keeps the current
   model; low confidence never downgrades and caps upgrades at the balanced
   tier; an unavailable tier steps up to the nearest available tier; the long
   tier is opt-in.
5. **Transport.** The proxy forwards the CLI's existing authorization headers
   without reading, storing or modifying them. It forwards the upstream stream
   unchanged except for an optional routing commentary event. It never
   replays a request after output starts.
6. **Data boundary.** Jev receives only the current user prompt, the current
   model, an approximate context size, and the available models. History,
   tool output, files, images and credentials are not sent. Decision logs store
   a prompt hash and length, never prompt text.
7. **Retirement.** The per-call proof catalog, Guard, fixed-baseline evidence
   gate, paired evaluation and caller-edge install brief are not on the new
   main path. Existing modules remain in the repository as legacy reference
   until a follow-up cleanup removes them.
8. **Improvements over the reference behaviour.** This version adds redacted
   decision logs, configurable tiers and cache threshold, a tested
   tool-continuation invariant, and a clean seam for later effort routing with
   `configuration_update`. It deliberately does not add cross-model cache
   sharing, exact price optimization, or online learning.

## Consequences

- The router is a small turn adapter, not a per-call scheduler.
- The first version can run with an existing Codex login and a TypeSafe key;
  no separate Codex Router or proof manifest is required.
- Model switching is less frequent and is bounded to turn boundaries, but it is
  not free. Long sessions may still switch on upgrade, and resumed sessions may
  find a cold cache.
- Compaction, encrypted reasoning items and process-restart session pinning are
  explicit follow-ups, not solved by this ADR.
- The legacy evidence path remains available for inspection but is no longer
  the primary entry point.

## Follow-ups

1. Effort routing inside a pinned model with `configuration_update`, gated by
   compaction compatibility.
2. Price-aware break-even for both downgrade and upgrade, replacing the single
   context threshold.
3. Persist the pinned model per conversation with a TTL, so `codex resume`
   does not silently reset.
4. Cross-model encrypted-reasoning handling and compaction tests.
5. A redacted `jev-codex status` / explain surface for the last decision.
