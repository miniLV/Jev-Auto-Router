# Codex Auto Router — Proposed Solution

Status: Proposed; reviewed for design consistency; no implementation has started

Scope: One opted-in project team using Codex App and Codex CLI

Relationship: A thin decision layer composed with [Codex Orchestration](https://github.com/Cjbuilds/Codex-Orchestration), not a fork or replacement

Independent review package: [`docs/claude-code-review-packet.md`](./claude-code-review-packet.md)

## 1. Background

The project team shares an API budget of approximately USD 500 per month. Engineers often choose Sol for an entire task, including routine reading and mechanical work, so the budget can be exhausted long before month end.

The target is not simply “always use a cheaper model.” A bug fix can contain several different kinds of work:

- Read a ticket or a large log.
- Correlate evidence with code.
- Design a cross-module change.
- Implement and validate the approved change.
- Review a high-risk plan independently.

The team needs a project-scoped way to use the cheapest model that is still appropriate for each bounded phase, without asking every engineer to memorize model policy.

The first release supports Codex only. It is not a company gateway, does not enforce a global budget, does not silently change a model inside an existing task, and does not add Claude Code.

## 2. What We Learned from the Usage Example

One archived Codex task contained these cumulative totals:

| Usage class | Tokens |
| --- | ---: |
| Total input | 361,868 |
| Cached input included in total input | 320,000 |
| Fresh input | 41,868 |
| Output, including reasoning output | 3,330 |

For that task:

```text
input : output = 361,868 : 3,330 ≈ 109 : 1
cached share of input = 320,000 / 361,868 ≈ 88.4%
```

This is the final cumulative value of one task. It is not a daily total, a monthly total, a user baseline, or a team average. Earlier cumulative observations from the same task must not be added again.

The example only proves that a cache-heavy task can occur. It does not prove that model routing is the best optimization for every user. A cache-heavy user may benefit more from reducing repeated context and tool output; an expensive-model-heavy user may benefit more from model routing; a low-spend user may not need the plugin at all.

## 3. Phase 0: Personal Usage Profile First

Phase 0 is initial setup plus manual refresh. It is never executed for every conversation.

It aggregates multiple completed local tasks over a declared observation window and renders a current, content-free local usage view. Stage 0 does not publish or persist a User Usage Profile; a future routing stage would need a separately approved profile contract rather than rescanning old conversations.

| Time | Action | On the task hot path? |
| --- | --- | --- |
| Initial opt-in | Aggregate completed tasks and publish Profile v1 | No |
| Manual refresh | Read a fresh official Credit snapshot and recalculate the local usage attribution | No |
| Each new task or explicit escalation phase | Read the published profile and policy; produce one Route Decision | Yes, but no history rescan |

V1 uses two deliberately separate data classes:

| Data class | Source | What it proves |
| --- | --- | --- |
| Official Credit Snapshot | Codex App Server `account/rateLimits/read` | Current-cycle Credit limit, used Credits, remaining percentage, and reset time. This is the official aggregate total. |
| Official Token Activity | Codex App Server `account/usage/read` | Account-level daily token activity and coverage reference. It does not contain a model or effort breakdown. |
| Local Usage Attribution | `ccusage` offline session-summary parsing | Verified model and numeric token patterns only. Effort and service tier remain unavailable unless a separately verified, field-whitelisted envelope provides them. Per-model Credit values are estimates, not billed amounts. |

The Dashboard uses the locally confirmed monthly reporting boundary for local attribution: the bootstrap period starts on 2026-07-16 and ends on the current UTC date; each subsequent period starts on the first UTC day of the current month and ends on the current UTC date. Since `ccusage --until` is inclusive, those start and end dates are passed directly (for example, `--since 2026-07-16 --until 2026-07-30`). The App Server remains authoritative for aggregate Credit; per-model Credit remains an estimate allocated by local token share. It is local-only and manually refreshed; V1 has no background polling, daemon, or scheduler. A historical daily Credit curve is available only for dates on which a user has manually recorded a snapshot.

The Stage 0 Dashboard presents:

- Official Credit Snapshot metadata: limit, used Credits, remaining percentage, and reset time.
- Estimated Credit Attribution by model, calculated from the official used-Credit total and local model token shares whenever both sources are available. It is always labelled as an estimate, and Attribution Quality explains any coverage or timing difference.
- Attribution Quality: the observation window, source availability, and reconciliation status. The local dashboard uses a native interactive SVG model-share chart and a compact, sketchboard-style web view; it remains observational and cannot enable routing policy.

Fresh input, cached input, output, reasoning-output, and official daily token activity remain internal calculation or diagnostic data. They are not primary Stage 0 Dashboard metrics.

It must not retain or upload prompts, code, logs, paths, tickets, URLs, identifiers, or free text.

Without a representative Profile, the Router remains analysis-only or shadow-only. Dashboard V1 itself never changes or enables routing policy; it only supplies evidence for a later Router decision. It must not auto-enable a policy based on one task.

## 4. Shared Vocabulary

The canonical definitions live in [`CONTEXT.md`](../CONTEXT.md). The most important rules are:

- **Main Task / Conversation** and **Root Agent** are the same user-visible task.
- **Root Model** is the model selected when the task starts. The Router does not replace it in place.
- **Router** is a small decision layer read by Root. It is not a model, a second scheduler, or a message bus.
- **Codex Orchestration** supplies role policy and governance. Root still decides whether a plan or child is useful.
- **Child Agents** have separate conversation contexts. They share workspace access, not chat context.
- **Root** is the only message bus and final verifier.
- **Advisor** performs independent Plan Review and returns `PLAN_APPROVED` or `PLAN_REVISE`. It is not a Code Reviewer.

## 5. Root Model and Capability Boundary

The user's manual model choice pins the Root Model for that task only. It does not pin every child role to the same model.

| Root selected by the user | Current Orchestration capability | Auto Router behavior |
| --- | --- | --- |
| Terra | Multi-agent v2 policy can activate | Full three-level proposal, subject to capability proof |
| Sol | Multi-agent v2 policy can activate | Full three-level proposal; Sol remains Root |
| Luna | Saved multi-agent v2 policy does not activate | Advisory-only; do not claim automatic child routing |

Terra High is the recommended project default Root because it balances coordination, implementation, and verification cost. This is a recommendation, not an implementation change:

- Do not silently modify the user's global Codex configuration.
- Do not override a manual App or CLI model selection.
- A future trusted-repository `.codex/config.toml` may provide an explicit project default after App and CLI behavior is verified.
- An explicit user instruction such as “no subagents” always overrides routing.

If a user starts the Root on Sol and a HIGH task needs planning, Codex Orchestration still creates the configured Sol Planner as an independent child. V1 intentionally does not invent same-model deduplication: Root and Planner have different contexts and responsibilities even when their model names match.

## 6. Composition with Codex Orchestration

The two products solve different layers:

```text
Personal Profile + Project Policy
                ↓
Thin Auto Router
  decides LOW / MEDIUM / HIGH and allowed roles
                ↓
Root Agent in the user's current task
  validates the decision and chooses whether to delegate
                ↓
Codex Orchestration + native multi-agent controls
  enforce Planner / Advisor / Executor role governance
                ↓
Root integrates, verifies, and answers the user
```

Codex Orchestration is not a dynamic cost classifier. Auto Router is not another orchestration engine. Root remains the single orchestrator.

### 6.1 Why not use Codex Orchestration alone?

Codex Orchestration already provides the difficult, reusable role-governance layer:

- Configured Planner, Advisor, and Executor routes.
- Planner/Advisor isolation.
- Plan revision and approval protocol.
- Executor release only after an approved non-trivial plan.
- Root-owned integration and final verification.

It does not provide:

- A personal usage profile.
- A project-specific cost/quality decision.
- LOW/MEDIUM/HIGH classification.
- A decision about whether delegation overhead is worthwhile.
- Cost, misrouting, escalation, rework, and quality telemetry.

Therefore the proposal adds only the missing thin layer.

### 6.2 Why not fork it?

A fork would mix project-specific experimentation with provider-safe role governance, increase upstream maintenance cost, and make failures harder to attribute. Composition keeps both responsibilities independently replaceable and allows generally useful improvements to be contributed upstream.

## 7. Three Routing Levels

V1 has exactly three levels:

| Level | Default path | Intended use |
| --- | --- | --- |
| LOW | Root direct, or Luna child when delegation is supported and worthwhile | Bounded extraction, summarization, inventory, and mechanical work |
| MEDIUM | Terra High Root or Executor | Normal diagnosis, implementation, integration, testing, and ambiguous work |
| HIGH | Sol xhigh Planner → Terra xhigh Advisor Plan Review → Terra High Executor → Root final verification | Architecture, difficult root cause, cross-module or high-risk/hard-to-reverse work |

HIGH must receive independent Plan Review before Executor work. LOW and MEDIUM do not automatically receive the Planner/Advisor workflow.

The level selects a workflow, not a permanent model for the whole conversation. Root may complete a small phase itself or create a child with the selected role when the runtime supports it.

### 7.1 LOW eligibility

A Luna child is allowed only when all of the following are true:

- The active Root supports the required multi-agent route.
- The source is substantial and has not already been materially ingested by Root.
- The objective and scope are bounded.
- The work is semantically simple, not causal or architectural reasoning.
- The task category passed shadow-quality evaluation.
- A validation method is defined.
- Expected savings exceed child boot, handoff, integration, verification, and expected rework.

Tiny work stays in Root. Already-ingested content stays in Root. Ambiguous work is MEDIUM.

“Read logs and extract a timestamped timeline” may be LOW. “Read logs and determine the crash root cause” is not automatically LOW.

### 7.2 MEDIUM

MEDIUM is the safe default for:

- Normal bug diagnosis.
- Implementation from an already approved plan.
- Integration across ordinary boundaries.
- Targeted tests and validation.
- Any incomplete, uncertain, or unproven classification.

MEDIUM uses Terra High as Root or a bounded Executor child. It does not add a review seat merely because work contains code.

### 7.3 HIGH

HIGH includes:

- Architecture or technical design.
- Difficult root-cause analysis.
- Cross-module, cross-platform, security, protocol, persistence, compatibility, or hard-to-reverse change.
- Any task for which independent plan challenge materially reduces risk.

The workflow is:

1. Root sends a self-contained planning packet to Sol xhigh Planner.
2. Planner returns a versioned `PLAN_DRAFT`.
3. Root sends the current plan to an independent Terra xhigh Advisor.
4. Advisor returns `PLAN_APPROVED` or `PLAN_REVISE`.
5. On revision, Root returns the current plan and findings ledger to Planner, then requests Advisor review again.
6. Root releases Terra High Executor only after approval.
7. Executor returns implementation and verification evidence to Root.
8. Root inspects, integrates, runs final checks, and answers the user.

Advisor reviews the plan, not the final code diff. V1 has no separate Code Reviewer role. If final code review is later required, it must be designed as a distinct optional role rather than relabeling Advisor.

## 8. Decision Process

Root already has to understand the request. It produces a small structured classification; V1 does not make a separate paid classifier-model call for every prompt.

Example Route Decision:

```yaml
decision_id: opaque-id
level: MEDIUM
phase: implementation
allowed_roles:
  - executor
reason_codes:
  - ROUTINE_IMPLEMENTATION
profile_version: 3
policy_version: 1
capability_mode: v2
material_already_in_root: false
economics_status: beneficial
explicit_override: false
```

Precedence:

1. Honor explicit user model, effort, and no-subagent instructions.
2. If routing is disabled, unavailable, invalid, incomplete, or uncertain, Root continues.
3. If Root is Luna and v2 policy is unavailable, return advisory guidance only.
4. Classify architecture, difficult root cause, and high-risk/hard-to-reverse work as HIGH.
5. Keep ambiguous and unproven work in MEDIUM.
6. Use LOW only when every LOW quality and economic condition passes.
7. After a child failure, Root resumes responsibility; do not retry blindly.
8. Stop automatic escalation after repeated implementation or validation failure and request diagnosis or user direction.

The deterministic Router receives structured fields. It does not read prompts, source code, tickets, or logs.

## 9. Context and Handoff Contract

Root and children do not share conversation context. Root passes a self-contained task packet to each child; the child returns a structured result to Root.

There is no direct Luna-to-Terra channel:

```text
Root → Luna task packet
Luna → Root Evidence Packet
Root validates and explicitly decides whether Terra is needed
Root → Terra task packet containing the validated Evidence Packet + source pointers
Terra → Root result + verification evidence
Root → User final answer
```

All agents may read authorized workspace files. Shared files are source evidence, not shared memory.

### 9.1 Evidence Packet

Default in-memory fields:

```yaml
objective: bounded statement
source_pointers:
  - path-or-opaque-id
scope: exact ranges or query bounds
verified_facts:
  - fact with source location
timeline:
  - timestamped event
open_questions:
  - unresolved issue
recommended_next_step: bounded action
```

The packet must not contain an entire log, complete child transcript, hidden reasoning, or an unverified root-cause claim.

V1 does not write an intermediate file by default. A task-scoped packet file is allowed only when the packet is too large for a safe handoff, must be reused by multiple downstream roles, or is required for audit. It must not duplicate raw source material and must never be ingested as Phase 0 telemetry.

Terra and Root may re-read the original source using packet pointers. The packet accelerates navigation; it never replaces verification.

## 10. Routing Economics

Delegation is worthwhile only when:

```text
expected benefit
  = avoided future Root-context cost
  + model-price difference for delegated work

expected overhead
  = child boot/context cost
  + handoff cost
  + child re-reading cost
  + Root integration and verification cost
  + expected rework cost
```

No universal token threshold is asserted. The pilot must calibrate break-even points separately for Codex App and CLI, the billing source, model rates, task length, and expected remaining Root turns.

If billing cannot be identified, report token classes and ratios without inventing a currency value.

True success is lower rework-adjusted cost or time at comparable first-pass validation quality. Fewer tokens alone is not sufficient.

## 11. Failure and Safety Behavior

- Missing or invalid profile → advisory/shadow only.
- Unsupported Root capability → advisory only.
- Invalid or unavailable optional route → Root continues.
- Child launch failure → Root resumes the phase.
- Runtime model or effort cannot be verified → disable that automatic child route.
- Repeated implementation or validation failure → stop escalating and request direction.
- Telemetry write failure → work continues without telemetry.
- Required HIGH Planner or Advisor failure → stop before Executor unless the user explicitly requests best effort.
- User manually selects a Root model → preserve it.
- User says no subagents → do not delegate.

Auto Router must not overwrite Codex Orchestration's single-value policy fields independently. If clean coexistence cannot be proven, the release remains analysis/advisory.

## 12. Privacy and Telemetry

Telemetry is opt-in, local, append-only, and ignored by Git.

Allowed:

- Timestamp and observation window.
- Opaque decision/task IDs.
- Route level, phase, role, runtime model, and effort.
- Profile and policy versions.
- Structured reason and risk enums.
- Override, escalation, fallback, validation, and review status.
- Fresh input, cached input, output, and reasoning-output counts.
- Child count, handoff size, duration, bounded failure count, and rework count.
- Billing source and rate-card version when known.

Forbidden:

- Prompts or summaries.
- Code, patches, filenames, paths, branches, or commits.
- Tickets, logs, free-form errors, or URLs.
- User/customer/meeting identifiers.
- Secrets, credentials, tokens, or environment values.
- Free-form reason text.

The threat model assumes a trusted local user and workspace. The plugin does not claim protection from a malicious local filesystem or compromised account.

## 13. Generic Plugin vs Project Policy

The generic plugin owns:

- Usage Profile schema and advisory output.
- LOW/MEDIUM/HIGH decision schema.
- Decision precedence and failure semantics.
- Handoff and telemetry schemas.
- Capability and validation requirements.

The opted-in project owns:

- Project-specific HIGH signals.
- Module and platform boundaries.
- Required validation commands.
- Whether routing is enabled.
- Capability-tested model identifiers.
- Telemetry opt-in and budget limits.

Private repository names, Jira keys, code paths, and business rules must not enter the generic plugin.

## 14. Validation Gates

Before any automatic route is enabled, App and CLI must be verified separately:

1. Terra/Sol Root activates the expected multi-agent policy.
2. Luna Root remains advisory when the saved v2 policy is unavailable.
3. Explicit child model and reasoning effort are accepted.
4. Runtime evidence identifies the actual child model, effort, and session.
5. A structured decision can deterministically reach the intended child call.
6. A distinct Terra xhigh Advisor reviews the current Sol plan.
7. Root resumes safely after optional child failure.
8. Auto Router and Codex Orchestration coexist without policy overwrite.
9. Content-free telemetry is sufficient to measure economics and quality.

Requested arguments, aliases, output style, or model self-identification are not proof.

The required evidence chain is:

```text
Route Decision
  → requested role/model/effort
  → observed child launch
  → actual runtime identity
  → structured result returned to Root
  → Root verification
```

If any link cannot be proven, that route remains advisory/shadow.

## 15. Rollout

### Stage 0 — Profile and low-cost controls

- Build a representative local multi-task profile.
- Identify whether the main opportunity is context reduction, effort reduction, model routing, or no intervention.
- Keep routing disabled.

### Stage 1 — Shadow routing

- Produce and record Route Decisions.
- Root performs all work.
- Compare recommended versus human-assigned levels.
- Measure projected delegation overhead and quality risk.

### Stage 2 — Bounded LOW

- Enable only capability-proven, shadow-validated Luna categories.
- Require source pointers and a validation method.
- Return to Root after any child failure.

### Stage 3 — MEDIUM and HIGH workflows

- Enable Terra Executor routing after control-path proof.
- Enable Sol Planner only after budget and runtime-identity proof.
- Enable HIGH Advisor review only after independence and plan-version proof.
- Keep final integration and verification in Root.

Every paid validation or rollout stage requires a separately approved budget ceiling and kill switch.

## 16. Success Measures

- Completed-task count and observation window.
- Fresh input, cached input, output, and reasoning-output mix.
- Model and reasoning-effort share.
- Median and high-percentile tokens or known cost per completed task.
- Recommended versus executed levels.
- Incorrect LOW promotions and missed HIGH classifications.
- Capability and runtime-identity failures.
- Child failure and Root fallback count.
- First-pass validation, review disagreement, and rework.
- Root-context growth, child boot cost, handoff size, and integration cost.
- Rework-adjusted cost per accepted result.
- Manual overrides and privacy violations.

The pilot expands only if a representative baseline shows lower rework-adjusted cost or time without a material reduction in first-pass validation quality.

## 17. Alternatives

### Codex Orchestration only

Retains fixed, safe role routing but leaves the usage profile and dynamic cost decision unsolved.

### Repository instructions only

Cheap to start but weak in observability, evaluation, portability, and removal. Suitable for opt-in policy, not the reusable core.

### Project API gateway

Could enforce spend before execution, but adds credentials, deployment, and operational risk beyond a single-team pilot.

### Separate LLM classifier

Could judge prompt complexity but adds latency and cost to every task. Rejected for V1; Root already interprets the request.

### Claude reviewer

Could add provider diversity, but adds authentication and transfer complexity. Rejected for V1.

## 18. Confirmed Decisions

- Separate `codex-auto-router` plugin; Codex App and CLI only in V1.
- Thin decision layer on Codex Orchestration; no fork and no second scheduler.
- Personal multi-task usage observation before routing, rendered only as the current local view in Stage 0.
- Phase 0 is initial plus periodic/manual refresh, never per conversation.
- Main Task and Root Agent are the same task.
- Root Model is user-selected and is not switched in place.
- Recommend Terra High as project default Root; do not silently change configuration.
- Terra/Sol Root may use the v2 policy; Luna Root is advisory-only under the current capability boundary.
- Exactly three levels: LOW, MEDIUM, HIGH.
- HIGH always uses Sol xhigh Planner and independent Terra xhigh Advisor Plan Review before Terra High Executor.
- Advisor is not Code Review; Root owns final verification.
- No same-model dedup in V1.
- Root is the only message bus; children have separate contexts.
- Default in-memory Evidence Packet; file only for size, reuse, or audit.
- Local content-free telemetry, fail-safe behavior, and no paid validation without an approved cap.

## 19. Open Decisions Before Implementation

- Whether the proposal attacks the primary cost driver if users continue starting Root on Sol.
- Whether “Terra High project default + Usage Profile” captures most of the value without automatic routing.
- Whether Root-produced semantic fields are consistent enough to justify the word “automatic.”
- Exact project opt-in and future `.codex/config.toml` shape.
- App/CLI runtime evidence for child model and effort.
- Deterministic decision-to-child control surface and failure recovery.
- Coexistence with Codex Orchestration without configuration ownership conflict.
- Representative observation window and minimum completed-task count.
- Empirical LOW delegation thresholds.
- Rework-adjusted break-even point after child boot, handoff, integration, and verification.
- Whether HIGH Advisor Plan Review prevents enough rework to justify its cost.
- Whether V1 needs a separate final Code Reviewer or should explicitly leave that gap.
- Per-task and pilot-window budget ceilings.
- License and packaging for a future public release.

## 20. Requested Feasibility Review

The reviewer should return `SOLUTION_APPROVED` or `SOLUTION_REVISE` and test:

1. Is the Root/capability boundary accurate for current Codex App and CLI?
2. Can the thin Router produce a decision that Root can consume without becoming a second scheduler?
3. Can each automatic child model and effort be proven at runtime?
4. Does the HIGH workflow preserve plan version, Advisor independence, and Root ownership?
5. Are Evidence Packet and workspace boundaries sufficient without shared conversation context?
6. Can Auto Router coexist with Codex Orchestration without overwriting policy?
7. Are privacy, fallback, budget, and stop conditions realistic?
8. Which routes must remain advisory because platform evidence is missing?
