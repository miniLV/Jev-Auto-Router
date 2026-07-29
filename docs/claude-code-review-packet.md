# Codex Auto Router — Claude Code Feasibility Review Packet

Status: Design review only; no implementation is authorized

Review target: Codex App and Codex CLI, one opted-in project team, V1 supports Codex only

## 0. Reviewer Instructions

Act as an independent architecture and feasibility reviewer. Do not implement, edit configuration, or treat desired behavior as current platform capability.

Read these source files before reviewing:

1. `docs/solution.md` — canonical proposed solution.
2. `CONTEXT.md` — canonical vocabulary.
3. `docs/adr/0001-root-role-capability-and-routing-levels.md` — proposed design decision.
4. The current installed Codex Orchestration skill and its provider/model references.
5. Current official Codex documentation for App/CLI configuration, subagents, model selection, hooks, plugins, and usage records.

For every platform claim, distinguish:

- Confirmed by current code/documentation.
- Plausible but not proven.
- Requires an experiment.
- Incorrect or overstated.

Return `SOLUTION_APPROVED` only when the proposed scope is feasible without relying on hidden assumptions. Otherwise return `SOLUTION_REVISE` with stable finding IDs.

## 1. Background and Real Problem

The project team shares an API budget of approximately USD 500 per month. Some engineers select Sol for an entire task even when most work is routine reading, extraction, implementation, or validation. The budget can therefore be exhausted early in the month.

The original product idea was:

> Automatically choose a cheaper or stronger model according to task complexity so the team can preserve limited monthly capacity without manually selecting a model for every phase.

One archived task showed:

| Usage class | Tokens |
| --- | ---: |
| Total input | 361,868 |
| Cached input | 320,000 |
| Fresh input | 41,868 |
| Output, including reasoning | 3,330 |

For that task, input/output was approximately 109:1 and cached input was approximately 88.4% of input.

This is one task's final cumulative total. It is not a daily, monthly, user, or team aggregate. It cannot prove that model routing is the best optimization for the team.

The solution therefore starts by measuring each user's actual cost shape before enabling routing.

## 2. Proposed Solution in One Sentence

Build a separate, removable `codex-auto-router` plugin that adds a personal usage profile and a thin LOW/MEDIUM/HIGH decision layer on top of Codex Orchestration, while keeping the user's current Codex task as the only Root orchestrator.

It is not:

- A company API gateway.
- A budget enforcement service.
- A replacement or fork of Codex Orchestration.
- A second scheduler.
- A mechanism that changes the model of an already-running Root task.
- A separate paid LLM classifier on every prompt.
- A Claude Code integration in V1.

## 3. System Responsibilities

```text
Completed local Codex tasks
        ↓
Phase 0: Personal Usage Profile
        ↓
Published Profile + Project Policy
        ↓
Thin Auto Router
  produces LOW / MEDIUM / HIGH + allowed roles
        ↓
Root Agent in the user's current Codex task
  validates the decision and decides whether to delegate
        ↓
Codex Orchestration + native multi-agent controls
  apply Planner / Advisor / Executor role governance
        ↓
Root integrates, verifies, and answers the user
```

| Component | Owns | Does not own |
| --- | --- | --- |
| Phase 0 | Local multi-task usage aggregation | Per-conversation classification |
| Project Policy | Risk signals, validation rules, budgets, capability gates | Execution |
| Auto Router | Structured route decision | User context, child scheduling, implementation |
| Root | Intent, semantic interpretation, delegation, integration, final verification | In-place model switching |
| Codex Orchestration | Planner/Advisor/Executor model and governance policy | Personal usage analysis or cost-tier classification |
| Child Agent | One bounded task in an independent context | Direct communication with another child |

## 4. Root Model Boundary

The user-visible Main Task and Root Agent are the same runtime task.

The Root Model is selected when that task starts. Auto Router does not replace it in place.

Current target behavior:

| Root selected by user | Proposed behavior |
| --- | --- |
| Terra | Full three-level policy may run after capability proof |
| Sol | Sol remains Root; independent configured children may still run |
| Luna | Advisory-only while Luna Root does not activate the saved multi-agent v2 policy |

Terra High is the recommended project default Root. The proposal does not silently change global configuration or override a manual model choice.

### Critical limitation to review

If an engineer starts the task on Sol, the Root remains Sol for the whole task. Auto Router can isolate bounded work in cheaper children, but it cannot remove the Sol Root's own context, reasoning, integration, and verification cost.

Therefore the proposal may not solve the original budget problem unless at least one of the following is true:

- Most users accept Terra High as the project default Root.
- The expensive part is fresh bulk context that can remain outside Root.
- Child routing prevents enough future Sol context growth to exceed delegation overhead.
- Usage profiling changes manual model-selection behavior.

Claude Code must assess whether the design optimizes the main cost driver or only a secondary one.

## 5. Exactly Three Routing Levels

| Level | Target workflow | Intended use |
| --- | --- | --- |
| LOW | Root direct, or Luna child when supported and economical | Bounded extraction, summarization, inventory, mechanical work |
| MEDIUM | Terra High Root or Executor | Normal diagnosis, implementation, integration, testing, ambiguous work |
| HIGH | Sol xhigh Planner → Terra xhigh Advisor Plan Review → Terra High Executor → Root final verification | Architecture, difficult root cause, cross-module or high-risk/hard-to-reverse work |

Rules:

- LOW is opt-in by proven task category, not a synonym for “read.”
- Tiny work stays in Root because child boot and handoff can cost more.
- Work already materially ingested by Root normally stays in Root.
- Ambiguous or unproven work is MEDIUM.
- HIGH always receives independent Plan Review before Executor release.
- Advisor is planning-only. It is not final Code Review.
- Root owns final verification for every level.

## 6. How Complexity Is Decided

V1 deliberately avoids a separate classifier-model call for every prompt.

Root already has to interpret the user request. Root produces structured fields such as:

```yaml
phase: implementation
bounded: true
semantic_complexity: medium
high_risk_signals: []
material_already_in_root: false
economics_status: beneficial
explicit_override: false
```

The thin deterministic Router validates these fields and applies precedence rules.

### Important truth

The deterministic Router does not understand task semantics by itself. The current Root model makes the semantic judgment. The rules only constrain and audit that judgment.

This avoids a new paid classifier call, but it introduces several questions:

- How consistent is classification across Terra, Sol, and Luna Roots?
- Can a user-selected Luna Root classify reliably if it cannot activate the v2 execution policy?
- Does Root classification create a circular dependency where the model being optimized is also the judge?
- Can structured reason codes be produced reliably without storing content?
- Is “automatic routing” accurate, or is this instruction-driven Root behavior?

## 7. Context and Handoff

Agents have separate conversation contexts. Shared workspace access is not shared memory.

```text
Root → Luna task packet
Luna → Root Evidence Packet
Root validates the packet
Root → Terra task packet + validated Evidence Packet + source pointers
Terra → Root result + verification evidence
Root → User final answer
```

There is no direct Luna-to-Terra channel.

The default Evidence Packet is returned in memory:

```yaml
objective: bounded statement
source_pointers:
  - original-source-pointer
scope: exact range
verified_facts:
  - fact with location
timeline:
  - timestamped event
open_questions:
  - unresolved issue
recommended_next_step: bounded action
```

It must not contain a complete log, entire child transcript, hidden reasoning, or an unverified root cause.

A task-scoped file is allowed only when the packet is too large, must be reused by multiple downstream roles, or is required for audit.

## 8. HIGH Governance Workflow

1. Root sends a self-contained planning packet to Sol xhigh Planner.
2. Planner returns a versioned `PLAN_DRAFT`.
3. Root sends the current plan and version to an independent Terra xhigh Advisor.
4. Advisor returns `PLAN_APPROVED` or `PLAN_REVISE`.
5. On revision, Root returns the current plan, new findings, and cumulative ledger to Planner.
6. Root requests another Advisor review of the revised plan.
7. Root releases Terra High Executor only after approval.
8. Executor returns implementation and verification evidence.
9. Root inspects, integrates, runs final checks, and answers the user.

If Root and Planner both use Sol, they remain separate agents with separate contexts. V1 does not deduplicate them.

There is no independent final Code Reviewer in V1.

## 9. Phase 0: Personal Usage Profile

Phase 0 runs:

- At initial opt-in.
- Weekly, after a configured number of completed tasks, or manually.

It does not run for every conversation.

Runtime reads a published, versioned Profile. The profile may report:

- Completed-task count and observation window.
- Fresh input, cached input, output, and reasoning-output totals.
- Median and high-percentile usage per task.
- Model and reasoning-effort share.
- Child count, handoff size, validation result, and rework where observable.
- Billing source and rate-card version when known.

It must not retain or upload prompts, code, logs, paths, tickets, URLs, identifiers, or free text.

Without a representative Profile, routing remains analysis-only or shadow-only.

## 10. Expected Benefits

These are hypotheses to validate, not promised savings.

### 10.1 User understands the real cost driver

The plugin can distinguish:

- Cached-input-heavy usage.
- Fresh-input-heavy usage.
- Output/reasoning-heavy usage.
- Expensive-model-heavy usage.
- Short-task, low-spend usage.

This may show that the right answer is context reduction, lower reasoning effort, model routing, or no intervention.

### 10.2 Fewer unnecessary Sol phases

When Terra High is the project Root, routine diagnosis, implementation, and validation can remain on Terra. Sol is reserved for HIGH planning and difficult reasoning.

### 10.3 Large bounded material can stay out of Root

Luna may extract verifiable facts from a large fresh log before Root or Terra consumes it. If the Evidence Packet is much smaller than the source and rework remains low, this can reduce repeated expensive context.

### 10.4 High-risk plans receive independent challenge

HIGH uses separate Planner and Advisor contexts before implementation. This may catch missing constraints before expensive code is written.

### 10.5 Project-scoped and removable

One repository can trial the policy without a company gateway or a global user configuration change. If the experiment fails, the plugin can return to advisory-only or be removed.

### 10.6 Upstream governance is reused

The project does not reimplement provider/model isolation, Planner/Advisor protocol, or Executor release rules.

### 10.7 Savings and quality become measurable

Shadow decisions, model identity, handoff size, first-pass validation, fallback, and rework can be compared instead of relying on intuition.

## 11. Known Problems and Costs

### P1. The Router cannot downgrade an existing Sol Root

This is the largest product limitation. If users keep choosing Sol manually, the plugin cannot fully redirect the task to Terra or Luna.

### P2. Luna is not currently a universal cheap Root

Under the current capability boundary, Luna Root does not activate the saved multi-agent v2 policy, so it cannot be the recommended default for the full workflow.

### P3. Semantic classification is still model judgment

The deterministic rules validate fields, but Root decides whether work is simple, ambiguous, difficult, or high risk. Misclassification remains possible.

### P4. Delegation can cost more than direct work

Every child adds:

- Boot and instruction context.
- Source re-reading.
- Root-to-child handoff.
- Child-to-Root result.
- Root integration and verification.
- Possible retry and rework.

### P5. Same-model role duplication is intentional but expensive

A Sol Root can still create a Sol Planner. Isolation improves governance but duplicates some context and cost.

### P6. HIGH may be too expensive if over-classified

Planner, Advisor, Executor, and Root all consume budget. HIGH must be rare and risk-driven.

### P7. No independent final Code Review

Advisor reviews the plan only. Root verifies the final result. Teams expecting a separate code-review model will not receive it in V1.

### P8. App and CLI can differ

Configuration loading, model picker behavior, child model arguments, hooks, runtime metadata, and session records may not behave identically.

### P9. Enforcement may be instruction-driven

If the integration relies on skills or Root compliance rather than a deterministic control surface, “automatic” may be overstated.

### P10. Upstream policy coexistence may fail

Auto Router and Codex Orchestration cannot safely overwrite the same single-value policy fields independently.

### P11. Usage and cost data may be incomplete

Tokens may be available without price, credits, cache-write cost, compaction cost, service tier, or exact billing rate.

### P12. Privacy constraints reduce explainability

Content-free telemetry can show that a LOW route failed but cannot preserve free-form task context explaining why.

### P13. The team budget is not enforceable

This local plugin can recommend and measure. It cannot stop manual Sol usage or enforce a shared USD 500 cap.

### P14. The initial evidence is too small

One cache-heavy task cannot estimate team savings, false LOW promotions, or the correct break-even threshold.

## 12. Uncertainties to Resolve

### P0 — Blocks any claim of automatic routing

| ID | Uncertainty | Evidence required | If unresolved |
| --- | --- | --- | --- |
| U-001 | Can a project-local Route Decision deterministically cause the exact child role/model/effort? | App and CLI trace from decision ID to observed child | Analysis/shadow only |
| U-002 | Can actual runtime model and effort be verified rather than merely requested? | Runtime/session metadata tied to the child ID | Disable automatic child route |
| U-003 | Is the Terra/Sol v2 and Luna v1 capability boundary current and stable? | Current official docs plus real App/CLI test | Capability-specific advisory mode |
| U-004 | Can Auto Router coexist with Codex Orchestration without overwriting policy? | Configuration diff and runtime test | Do not enable automatic routing |
| U-005 | Can a project recommend/default Terra without silently overriding manual selection? | Trusted-repo config precedence test in App and CLI | Keep recommendation manual |
| U-006 | Are required Planner/Advisor isolation and plan-version guarantees observable? | HIGH trace across distinct child/session IDs | Do not release Executor automatically |

### P1 — Determines whether the product creates value

| ID | Uncertainty | Evidence required | If unresolved |
| --- | --- | --- | --- |
| U-007 | Is Sol Root usage actually the main cost driver? | Representative multi-user, multi-task Profile | Do not build routing based on assumption |
| U-008 | Does delegation reduce rework-adjusted cost? | Root-only versus routed task-category comparison | Disable that route |
| U-009 | What source size and remaining-turn count justify a Luna child? | Measured child boot, packet, integration, and rework | Keep LOW in Root |
| U-010 | Can Terra Root classify LOW/MEDIUM/HIGH consistently? | Human-labeled shadow set and disagreement analysis | Advisory only or tighten categories |
| U-011 | How often is HIGH truly needed? | Risk-labeled tasks and findings caught by Advisor | Reduce or redesign HIGH |
| U-012 | Does Advisor Plan Review improve outcomes enough to pay for itself? | Accepted findings, prevented rework, total cost | Make review rarer or remove |
| U-013 | What is a safe Evidence Packet size and schema? | Handoff quality and source re-read measurements | Keep one agent or use audited file |

### P2 — Product and operational decisions

| ID | Uncertainty |
| --- | --- |
| U-014 | Minimum completed-task count and observation window for a useful Profile |
| U-015 | Rate-card source and behavior when cost cannot be known |
| U-016 | Project opt-in mechanism and local telemetry retention |
| U-017 | Per-task and pilot-window budget ceilings |
| U-018 | Packaging, license, versioning, and future public release |

## 13. Stop Conditions

The pilot must stop or remain advisory when:

- The decision-to-child chain cannot be proven.
- Runtime model or effort cannot be verified.
- Auto Router conflicts with Codex Orchestration policy.
- LOW reduces first-pass quality or increases rework beyond its savings.
- Routed work costs more than Root-only work after handoff and verification.
- Content-free telemetry cannot support safe evaluation.
- Any forbidden content enters telemetry.
- HIGH review cost is not justified by findings or prevented rework.
- Users continue selecting Sol Root and measured savings remain immaterial.

## 14. Safest Rollout

### Stage 0 — Usage Profile only

Measure the actual cost shape. Recommend context, effort, model, or no change. Do not route.

### Stage 1 — Shadow routing

Produce LOW/MEDIUM/HIGH decisions while Root performs all work. Compare decisions with human labels and estimate economics.

### Stage 2 — Narrow LOW allowlist

Enable only bounded, capability-proven, shadow-validated categories with an explicit validation method.

### Stage 3 — MEDIUM/HIGH workflows

Enable only after App/CLI control-path proof, runtime identity proof, budget ceilings, and failure recovery.

The design should be considered successful even if Stage 0 proves that routing is not the best optimization. Avoiding an unnecessary router is itself useful.

## 15. Questions Claude Code Must Answer

1. Does this solution attack the team's main cost driver, or does the inability to downgrade an existing Sol Root make it optimize the wrong axis?
2. Would “Terra High project default + usage dashboard” capture most value without automatic routing?
3. Is a separate plugin justified, or would project instructions plus Codex Orchestration be enough for V1?
4. Is the current Terra/Sol/Luna Root capability table accurate?
5. Can a plugin reliably consume a Route Decision and trigger the exact child model/effort in both App and CLI?
6. Is runtime identity observable strongly enough to claim a route occurred?
7. Is the Router truly deterministic if Root supplies semantic fields?
8. Is “automatic” valid terminology, or should the product be called an advisor/shadow router until stronger controls exist?
9. Can the personal Profile be computed correctly from cumulative session counters without reading content?
10. Are the privacy claims mechanically enforceable?
11. Does the Evidence Packet save context, or does downstream source re-reading erase the benefit?
12. Are LOW/MEDIUM/HIGH sufficiently distinct for reliable classification?
13. Is always reviewing HIGH with Terra xhigh economically defensible?
14. Does plan-only Advisor leave an unacceptable final-code quality gap?
15. Can Auto Router coexist with Codex Orchestration without configuration ownership conflict?
16. Which confirmed decisions should be changed before implementation?
17. Which features should be removed from V1 to maximize learning per dollar?
18. What is the smallest experiment that could falsify the business hypothesis?

## 16. Required Review Output

Use this exact structure:

```text
SOLUTION_APPROVED
or
SOLUTION_REVISE

Executive verdict
- Does it solve the real budget problem?
- Is the proposed V1 feasible?
- What is the smallest recommended V1?

Findings
- F-001 [P0/P1/P2] Title
  - Claim being challenged
  - Why it matters
  - Evidence from current Codex / Orchestration behavior
  - Required change

Claim ledger
| Claim | CONFIRMED / UNVERIFIED / INCORRECT | Evidence |

Benefit assessment
| Expected benefit | Likely / uncertain / unlikely | Reason |

Scope cuts
- What should be removed or deferred from V1?

Experiment plan
- Cheapest experiment
- Success metric
- Failure / stop threshold

Residual uncertainties
- Items that remain unknown after review
```

Do not approve merely because the document is internally consistent. Approval requires a credible path from the team's actual usage problem to measurable savings, plus current platform support for every behavior described as automatic.
