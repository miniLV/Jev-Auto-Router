# Jev Auto Router

**One Codex session. A fresh model choice for each meaningful call.** [TypeSafe's Jev](https://docs.typesafe.ai/introduction) chooses from the available GPT model and reasoning-effort pairs; independent verification checks the finished task. Jev Auto Router (Jev Router) is a prototype of that design.

In the architecture, Jev chooses the model and reasoning effort for each call. A local Responses proxy preserves the Codex session and tool loop. Independent verification checks the finished task. Router Compass connects the route, actual usage, and acceptance result to answer one question: **Did using less frontier capacity still complete the task correctly and reduce the full delivery cost?**

> [!IMPORTANT]
> **Status: architecture approved; runtime is a validation prototype.** This repository has a per-call proxy and tests, but cross-model switching in a real Codex tool loop, the complete verification path, and savings have not been proven end to end. The design below is not a production installation guide.

[简体中文](README.md) · [Architecture](docs/solution.md) · [Decision ADR 0017](docs/adr/0017-per-call-responses-routing.md) · [Chinese article](https://minilv.github.io/2026/09/18/codex-auto-router/) · [License](LICENSE)

## Prerequisites

- **A TypeSafe account and Jev API key.** Get a key through the [TypeSafe Quick Start](https://docs.typesafe.ai/introduction/quickstart). This proxy reads `JEV_API_KEY` when it calls Jev. TypeSafe's own examples use `TYPESAFE_API_KEY`; both variables can hold the same key. Never commit the key.
- **Node.js 22+, a signed-in Codex CLI, and access to the model and reasoning-effort pairs you want to route.** A Jev key alone does not make live per-call routing available.
- **This is still a validation prototype.** Cross-model switching inside a real Codex tool loop must pass the P0 proof below; there is no production-ready install-and-run path yet.

Before running the local proxy, set the key from your TypeSafe dashboard in the current shell:

```sh
export JEV_API_KEY="<your-typesafe-jev-api-key>"
```

## Why route per call?

A coding task mixes hard reasoning about requirements or failures with routine calls to read files, make known edits, and follow up on tool results. Running every call on a frontier model spends scarce capacity on simple steps; running the whole task on a small model risks the difficult ones.

Jev Auto Router makes a choice at **each meaningful model call** inside the same session. It does not start a new worker for each task. For example, Sol could frame the problem, Luna Max handle explicit follow-up work, Terra resolve an ordinary implementation issue, and Sol analyze a failed test. This illustrates the routing granularity; it is not a measured outcome.

## The delivery loop

![Jev Auto Router per-call architecture: a Codex session passes through the local proxy, Jev, execution guard, and native Responses before independent task verification](docs/assets/jev-auto-router-sketchboard-en.png)

```text
Codex Responses call
   |
   v
local proxy -- OFF? -> host model - infrastructure/verification -> fixed tier - privacy fails -> skip Jev
   |
   v
compact routing state + (model, effort) pairs the host can request now
   |
   v
Jev: one Choice (pinned in production) --timeout/low-confidence/bad answer--> Terra/medium baseline (reason recorded)
   |
   v
native Responses forwarding (events unchanged); record actual model + usage
   |
   +-task end-> independent verification PASS / FAIL -- failure facts return to the same session; Root takeover after two cycles
```

### What Jev does

- The proxy builds only `(model, reasoning effort)` pairs that the host can actually request. Jev makes **one Choice** over those pairs, selecting model and effort together. Local code adds no task-kind table or second semantic router.
- Jev receives compact state that passes an explicit send check, such as the current step, a bounded tool-error summary, and the current model. The full session still goes through the native Codex model call; raw prompts and tool output are not stored in route logs by default.
- Production routing pins a validated Jev version; `jev-latest` is evaluated in shadow. Timeout, low confidence, or an invalid answer falls back explicitly to `Terra/medium` by default, with a recorded reason. Turning the router off restores the host's original model.

### Four capability tiers

| Tier | Typical role | Ordinary calls |
| --- | --- | --- |
| **Luna Max** | Explicit, mechanical follow-up steps | Eligible |
| **Terra** | Everyday work and the fallback baseline | Eligible |
| **Sol** | Harder reasoning, implementation, and correction | Eligible |
| **GPT-6** | Scarce escalation supported by evidence | Ineligible by default |

GPT-6 enters the candidate set only with temporary eligibility from a verified reasoning blocker. An explicit user mandate for GPT-6 is enforced as a hard constraint. Luna Max means `gpt-5.6-luna/max` in the current design; tier names must match model and effort pairs that the host actually supports.

## What data goes where

- **Sent to Jev:** only the compact state that passes an explicit send check — step type, current model, tool name, exit codes, fixed-length error digests. The full session never leaves the host for routing.
- **Sent upstream:** the native session content, exactly as it would flow without the proxy; the proxy never rewrites the response event stream.
- **Stored locally:** no raw prompts or tool output in default logs; sensitive content is refused outright rather than truncated, and calls without send eligibility skip Jev for the baseline.

## A good route does not prove completion

At the task boundary, independent verification checks the original request against the diff, tests, run results, and any needed semantic judgment. The executing model's claim of success is not evidence. Specific failures return to the same session for correction; after two cycles by default, Root takes over. Verification uses a fixed tier outside the economic routing loop.

Router Compass records Jev's choice, the actual model and effort, usage, cache behavior, latency, and fallback reason for each call, then links those facts to the task's verification result. Unknown usage stays `UNKNOWN`, never zero. Switching models can lose prompt-cache reuse, so V1 measures the full cost instead of assuming routing saves money.

| Evidence | What it can establish |
| --- | --- |
| Production observation | Actual model mix, usage, and task verification |
| Historical replay | **Estimated** prices under explicit assumptions; a counterfactual, not quality proof |
| Fixed-Terra control | Whether equivalent acceptance and complete Jev/correction accounting show real savings with maintained quality |

## Current status

The repository contains a prototype local proxy, routing decisions, task verification, Compass data structures, and tests. The **P0 gate** is a real Codex CLI A→B→A switch within one tool loop across all four tiers, checking authentication, actual model and effort, tool-call IDs, streaming events, cancellation, continuation, and compaction. Until that proof and a controlled comparison pass, this project makes no general savings claim and offers no promise of automatic routing after installation.

[skills/jev-auto-router/SKILL.md](skills/jev-auto-router/SKILL.md) is the install-and-operate guide; the Skill itself never intercepts model calls — routing happens inside the local proxy.

### Try it (prototype)

Requires Node.js 22+. These commands start the local proxy and validate the current code; they do not connect Codex to a production proxy:

```sh
npm ci
npm run build
JEV_API_KEY="<your-key>" npm start     # http://127.0.0.1:8787
curl -s localhost:8787/health          # router status, baseline, model catalog
npm test                               # builds, then runs the full suite
npm run typecheck
```

Once Codex's Responses traffic points at the local proxy, each call returns its route tag through the `x-jev-route` / `x-jev-route-source` response headers; `GET /decisions` shows call and task records. Control signals (task id, step type, forced model) travel as `x-jev-*` request headers and never enter the forwarded body.

### Configuration

| Environment variable | Effect | Default |
| --- | --- | --- |
| `JEV_API_KEY` | TypeSafe Jev API key | required when routing is enabled |
| `JEV_ROUTER_OFF` | `1` = kill switch: bypass Jev, restore the host model | unset |
| `JEV_MODE` | `active` \| `shadow` (shadow logs would-be routes, executes the baseline) | `active` |
| `JEV_VERSION` | Pinned production Jev version | `jev-1.13.0` |
| `JEV_BASELINE` | Failure fallback pair | `gpt-5.6-terra/medium` |
| `JEV_CONFIDENCE_FLOOR` | Confidence floor below which calls fall back | `0.55` |
| `JEV_DEADLINE_MS` | Hot-path Jev deadline (tuned from shadow latency) | `2000` |
| `JEV_PORT` | Local proxy port | `8787` |
| `JEV_UPSTREAM_BASE_URL` | Upstream Responses base URL | `https://api.openai.com` |
| `JEV_ENDPOINT` | Jev API endpoint | TypeSafe endpoint |

The local proxy entry point is [src/index.ts](src/index.ts).

## License

[Apache License 2.0](LICENSE)
