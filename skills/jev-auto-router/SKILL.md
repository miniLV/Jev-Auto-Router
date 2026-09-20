---
name: jev-auto-router
description: Install and operate the Jev Auto Router — the local Responses proxy that routes each Codex model call to a Jev-selected (model, reasoning_effort) pair, verifies tasks independently at completion, and records everything in Router Compass.
---

# Jev Auto Router

Operational guide for the Jev Auto Router product. The routing contract
itself lives in the [Runtime Router Policy](references/routing-policy.md);
this Skill cannot intercept model calls and adds no routing logic. Routing
happens in the local Responses proxy that Codex is configured to send its
Responses API traffic through.

## What gets installed

1. The local Responses proxy (forwarding, routing, fallback, telemetry).
2. The Router Compass local log (per-call and per-task records; no raw
   prompt or tool-output text by default).
3. Offline evaluation scripts (historical replay, fixed-Terra controlled
   comparison).

See the repository README for build and install commands.

## Operating controls

| Control | Effect |
| --- | --- |
| `JEV_ROUTER_OFF=1` (kill switch) | Bypass Jev entirely; the host's originally specified model is restored |
| `JEV_MODE=active\|shadow` | Active routes every eligible call; shadow logs would-be routes and executes the configured baseline |
| `JEV_VERSION` | The pinned, validated Jev version for active routing; `jev-latest` is for shadow evaluation |
| `JEV_BASELINE` | The fallback pair (default `Terra/medium`) |
| Health / decision-log surfaces | Local, read-only; not a control plane |

## Operating rules

- The kill switch never downgrades a user-chosen Sol or GPT-6 request to
  Terra; it restores the host's original model.
- An explicit user "must use GPT-6" instruction is enforced over its stated
  scope by the router itself; nothing needs to be configured per call.
- After a Jev transport failure, Jev is skipped for the remainder of the
  task and the baseline is used; check health before investigating the
  task.
- Verification results (PASS/FAIL, evidence refs, correction cycles,
  takeovers) come from the task-boundary verification step, not from any
  model's self-report.
- If routing looks wrong, turn it off first (`JEV_ROUTER_OFF=1`), then read
  the decision log. Do not hot-edit policy values while a task is running.
