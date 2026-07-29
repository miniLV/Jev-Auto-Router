# ADR 0001: Root Role, Capability Boundary, and Three Routing Levels

- Status: Proposed
- Date: 2026-07-29

## Context

The design previously mixed the user-visible main conversation, Root, model tiers, role names, and a four-level risk taxonomy. That made it unclear who owned orchestration, whether a child shared Root context, whether Luna could always start children, and whether Advisor performed Code Review.

The solution must compose with the orchestration layer rather than replace it. Current capability evidence also differs by Root Model: Terra and Sol can activate the saved multi-agent v2 policy, while Luna uses v1 and does not activate that policy.

## Decision

1. The user-visible Main Task and Root Agent are the same runtime task.
2. Root Model is selected when the task starts and is not switched in place.
3. Terra High is the recommended project default Root, but manual selection is preserved and no global configuration is silently changed.
4. Auto Router is a thin decision layer consumed by Root, not a second scheduler.
5. the orchestration layer remains the role-governance layer.
6. V1 uses exactly LOW, MEDIUM, and HIGH:
   - LOW: Root direct or a bounded Luna child when supported and economical.
   - MEDIUM: Terra High Root or Executor.
   - HIGH: Sol xhigh Planner, independent Terra xhigh Advisor Plan Review, Terra High Executor, then Root final verification.
7. HIGH always requires Plan Review. Advisor is not Code Review.
8. Child contexts are independent. Root is the only message bus; shared files are source evidence, not shared context.
9. Child results return as an in-memory Evidence Packet by default. A file is allowed only for size, reuse, or audit.
10. A Luna Root is advisory-only while the saved v2 policy is unavailable.
11. V1 does not deduplicate Root and Planner merely because both use Sol.

## Consequences

### Positive

- The user can reason about one clear owner: Root.
- The Router remains small and removable.
- Existing Orchestration governance is reused.
- LOW/MEDIUM/HIGH is easier to explain and evaluate than four overlapping levels.
- HIGH review has an exact purpose and release gate.
- Handoffs are explicit and auditable without copying full child transcripts.

### Negative

- A user-selected Luna Root cannot receive the full automatic policy under the current capability boundary.
- A Sol Root may still create a Sol Planner child, adding context overhead.
- V1 does not provide independent final Code Review.
- Runtime identity and App/CLI control paths still require capability tests.

## Alternatives Rejected

- Four routing levels: the COMPLEX/HIGH-RISK boundary was too subtle for users and policy evaluation.
- Router as a separate orchestration service: duplicates Root and Codex scheduling responsibilities.
- Luna as the universal default Root: cheapest, but incompatible with the saved v2 policy needed by the proposed workflow.
- Advisor as Code Reviewer: contradicts the established planning-review contract.
- File-based handoff by default: creates unnecessary artifacts and risks confusing task evidence with telemetry.
