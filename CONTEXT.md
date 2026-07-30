# Shared Context

This file defines the vocabulary used by the solution, diagrams, reviews, and future implementation. New terms should be added only when they prevent a real ambiguity.

| Term | Definition |
| --- | --- |
| Main Task / Conversation | The user-visible Codex App or CLI task. It is the same runtime entity as the Root Agent. |
| Root Agent | The coordinating role inside the Main Task. Root owns user intent, applies the Codex multi-agent policy, makes the actual `spawn_agent` calls when Codex decides delegation is useful, integrates results, performs final verification, and answers the user. |
| Root Model | The model currently selected by the user for Root. The Root Agent persists when the user changes models between turns; a Root Model choice does not pin child roles. |
| Router | A thin, deterministic decision layer consumed by Root. It produces LOW/MEDIUM/HIGH and allowed roles. It is not a model, scheduler, agent, or message bus. |
| the orchestration layer | The single runtime delegation policy layered onto Codex's native multi-agent flow. It supplies Planner, Advisor, and Executor routes and governance; Codex/Root still decides whether delegation is useful and performs any child creation. It is not a separate scheduler. |
| Auto Router | A thin profiling and classification layer. It produces usage insights and a LOW/MEDIUM/HIGH routing hint for the orchestration layer; it never creates a child Agent and never implements a second delegation decision tree. |
| Route Level | One of exactly LOW, MEDIUM, or HIGH. It selects a workflow for a task or bounded phase, not a permanent model for the conversation. |
| Planner | A planning-only child. For HIGH, Sol xhigh returns a versioned plan to Root. |
| Advisor Plan Review | An independent planning-only child. Terra xhigh returns `PLAN_APPROVED` or `PLAN_REVISE`. It is not Code Review. |
| Executor | A bounded implementation child released by Root. For the target policy, Terra High implements and validates an approved plan. |
| Evidence Packet | A structured child result returned to Root: objective, source pointers, verified facts, timeline, open questions, and next step. It is in memory by default. |
| Shared Workspace | Files all authorized agents may read or edit within scope. It provides common source evidence, not shared conversation context. |
| Phase 0 | Initial local aggregation plus manual refresh for the Personal Usage Dashboard. It never runs for every conversation; V1 renders only the current in-memory view and does not publish or persist a profile. |
| Usage Profile | A content-free aggregation over multiple completed tasks. In V1 it exists only as the current Dashboard view, not as a single-task, daily, team-wide, or persisted total. |
| Route Decision | A small, auditable routing hint containing level, phase, reason codes, profile/policy versions, capability mode, and overrides. It is input to the the orchestration layer policy, not an instruction that independently creates a child Agent. |
| Credit Budget | The project team's monthly allocation of Codex credits, purchased for approximately USD 500. Credits are the optimization target; local token counters are diagnostic signals and must not be presented as the billed amount. |
| Shadow Routing | A non-executing Auto Router evaluation mode. It records the route that Auto Router would recommend while the orchestration layer continues its normal delegation behavior. It measures classification quality and projected economics without adding another runtime scheduler. |
| Controlled Automation | Opt-in automatic delegation limited to task categories whose route, runtime identity, quality, and credit benefit have passed the pilot gates. It is not universal or budget enforcement. |
| Personal Usage Dashboard | A loopback-only, manually refreshed web interface centered on Official Credit usage, Estimated Credit Attribution by model, and Attribution Quality for the current official Credit cycle. It renders the current in-memory snapshot only; it does not persist snapshots or upload prompts, code, logs, paths, or task text. |
| Official Credit Snapshot | A point-in-time aggregate of the current Credit-cycle limit, credits used, remaining percentage, and reset time returned by Codex App Server. It is the billing source of truth for the Dashboard, but it has no per-model or per-effort split. |
| App Server Adapter | The versioned, read-only local integration that starts Codex App Server over stdio for one Dashboard refresh and maps its response into an Official Credit Snapshot and Official Token Activity. It exits after the read and reports unavailable data when the experimental protocol is unsupported or invalid. |
| Usage Attribution Estimate | A model- or effort-level allocation derived by applying the local model token share to Official Credits used. It is shown whenever both sources are available, alongside Attribution Quality that explains any coverage or timing difference; it is never an official billed amount. |
| Reconciliation Status | The explanation of whether local token attribution can be compared with Official Token Activity for the same observation window. A mismatch is reported as coverage or timing information; it never compares token units with Official Credits, changes an official value, or fabricates a billed split. |
| Manual Refresh | A user-initiated Dashboard action that reads a fresh Official Credit Snapshot and recomputes local usage attribution. V1 has no background polling or scheduler. |
| Profile Export | A schema-versioned, content-free summary a user deliberately exports from the Personal Usage Dashboard for project-team analysis. Export is never automatic. |
| Team Strategy Dashboard | A separate aggregate view built from voluntarily collected Profile Exports. It compares usage patterns and informs project policy without ingesting local conversations. |
| Usage Signal | A locally measurable indicator such as token class, cache share, session size, model, effort, or child activity. It helps explain habits but is not an actual Codex credit charge. |

## Non-negotiable relationships

```text
Main Task = Root Agent
Root Model = user's model selection for that task
Router → decision consumed by Root
Root → child task packet
Child → structured result returned to Root
Child ↛ child direct communication
Shared Workspace ≠ shared conversation context
Advisor = Plan Review, not Code Review
```
