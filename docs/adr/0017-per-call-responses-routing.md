# ADR 0017: Per-call Responses routing

Date: 2026-09-20
Status: Accepted
Supersedes: the superseded worker-era decisions (capsules, per-unit
    delegation, worker budgets, publication transactions) are retired;
    their machinery is not carried into V1

## Context

The final technical review of the proposed V1 solution returned "approve
with changes" on routing **per model call inside one Codex session**, with
four contract tightenings: prove Codex per-call switching feasibility
first; move completion verification outside the dynamic routing loop;
select a valid `(model, reasoning_effort)` pair in a single Jev Choice;
and separate GPT-6 "allowed to consider" from "must use".

A prior TaskUnit/worker design existed: capsules, capability
catalogs of agents/Skills/MCPs, sixteen-check Policy Guard, isolated
baselines, publication transactions, observation windows and evidence
transitions. The review's per-call verdict retired that runtime: the unit
of routing becomes the model call after a tool result, executed by the
same session through a local Responses proxy — no workers, no capsules, no
per-call isolation state machine. The granularity is implementable on the
Responses request path, but task quality and real savings remain unproven
in this product.

## Decision

1. **Routing unit:** the model call. A local Responses proxy gates each
   call (router OFF, infrastructure bypass, privacy refusal), builds
   compact allowlisted routing state and validated candidate pairs, asks
   Jev **one Choice over `(model, effort)` pairs**, forwards natively with
   unchanged streaming events, and records actual pair and usage.
2. **Fallback:** low confidence, timeout, malformed or transport failure
   falls back to the configured baseline (default Terra/medium) with a
   recorded reason — fixed reliability handling, never a semantic second
   selector. A transport failure skips Jev for the remainder of the task.
   The kill switch restores the host's originally specified model and
   never downgrades user-chosen Sol/GPT-6.
3. **Jev version:** production pins a validated version; `jev-latest` runs
   in shadow only; requested/resolved versions are always recorded.
4. **GPT-6:** absent by default. One-shot eligibility from verified
   reasoning-blocker evidence; explicit user mandate is a separate hard
   constraint. Root takes over if Jev persistently avoids an
   evidenced-necessary GPT-6 call; Jev's answer is never rewritten.
5. **Verification:** independent, at the task boundary, outside the
   economic routing loop; acceptance read from the original request;
   fixed verification tier for semantic judgment; self-report is never
   evidence. Two correction cycles maximum, then Root takeover.
6. **Observation:** Router Compass records per-call facts and one task
   conclusion; UNKNOWN is never zero; savings claims follow the
   observed / replay / controlled-benchmark evidence ladder; replay is an
   offline script only.
7. **P0 gate:** before any routing logic is trusted, a real Codex
   A→B→A tool-loop proof must pass (auth, model/effort fidelity,
   tool-call IDs, SSE, cancellation, continuation/compaction). A critical
   failure stops per-call promotion and reopens the host interface
   question.

## Consequences

- Five runtime modules (proxy, routing, verification, telemetry, entry)
  plus offline bench replace the worker-era modules; the SDD set is
  rewritten and `task-capsule.md` deleted.
- The old benchmark harness's UNKNOWN→zero conversion is a defect; its
  passing tests are not economic evidence.
- Cache economics are measured, not optimized; a switch threshold, if
  ever justified, arrives as a new policy version validated by the same
  ladder.
- Route-selection intelligence remains in exactly one place — Jev, through
  one adapter seam — with no heuristic classifier, task-kind table, tier
  ladder or second selector anywhere in the repository.
