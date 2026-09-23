---
name: jev-auto-router
description: Install and operate Jev Auto Router — the local Responses adapter entered by the virtual model jev/auto, which applies one guarded Jev choice through an authenticated caller edge.
---

# Jev Auto Router

Operational guide for the Jev Auto Router product. The routing contract
itself lives in the [Runtime Router Policy](references/routing-policy.md);
this Skill cannot intercept model calls and adds no routing logic. Routing
happens when Codex Router sends a `jev/auto` Responses request to the local
Jev Router. Real-model requests remain on Codex Router's normal path.

## What gets installed

1. The local Jev Router (admission, one Choice, Guard, two-field Apply,
   authenticated forwarding and fallback).
2. The local decision log (Proposed, Applied and Observed pairs; no raw
   prompt or tool-output text by default).
3. Offline evaluation scripts (historical replay, fixed-baseline controlled
   comparison).

See the repository README for build and install commands.

## Operating controls

| Control | Effect |
| --- | --- |
| `JEV_ROUTER_OFF=1` (OFF mode) | Do not call Jev; execute `jev/auto` with the configured Fallback Baseline |
| `JEV_MODE=active\|shadow` | Active routes every eligible call; shadow logs would-be routes and executes the configured baseline |
| `JEV_VERSION` | The pinned, validated Jev version for active routing; `jev-latest` is for shadow evaluation |
| `JEV_BASELINE` | Required fixed pair proved requestable through the configured caller edge; no product-wide default |
| `JEV_PAIR_PROOFS_FILE` | Reviewed, redacted manifest proving exact model/effort requests through that caller edge; startup never probes models |
| Health / decision-log surfaces | Local, read-only; not a control plane |

## Operating rules

- A user-selected real model bypasses the Jev Router in every mode. OFF affects
  only `jev/auto` requests.
- Candidate Pairs and the Fallback Baseline require requestability evidence
  from the exact authenticated caller edge; a catalog listing is insufficient.
- Without a current proof for the fixed baseline, `jev/auto` fails before the
  upstream request. Active refuses any configured candidate whose exact pair
  lacks proof; an unobserved effort remains `UNKNOWN`.
- A route record keeps Proposed, Applied and Observed pairs separate.
  Unobserved model, effort or usage remains `UNKNOWN`.
- Shadow Mode must pass before Active for the exact Jev, question, policy,
  caller-edge, candidate and baseline versions.
- If routing looks wrong, turn it off first (`JEV_ROUTER_OFF=1`), then read
  the decision log. Do not hot-edit policy values while a task is running.

The repository runtime is being migrated to this contract in ordered local
tickets. Until those tickets pass, this Skill describes the target operation,
not a production-ready installation.
