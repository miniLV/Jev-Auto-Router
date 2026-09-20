# System design documents (SDD)

Durable subsystem designs for the per-call V1 architecture of **Jev Auto
Router**. [spec.md](../../spec.md) is the normative specification;
[docs/solution.md](../solution.md) is the full final solution; the
[routing policy](../../skills/jev-auto-router/references/routing-policy.md)
is the canonical runtime contract. These documents expand interfaces without
redefining any of them.

| Document | Scope |
| --- | --- |
| [architecture.md](architecture.md) | Five runtime modules, proxy flow, task boundary, Compass |
| [route-plan.md](route-plan.md) | Routing state, candidate pairs, decision and outcome schemas |
| [capability-catalog.md](capability-catalog.md) | Model/effort availability and valid pairs |
| [jev-adapter.md](jev-adapter.md) | The single seam to the Jev API: one Choice, version pinning, hot path |
| [policy-guard.md](policy-guard.md) | Deterministic validation of candidates, hard constraints, responses |
| [delivery-lifecycle.md](delivery-lifecycle.md) | Task state, correction cycles, Root takeover, verification contract |
| [decision-receipt.md](decision-receipt.md) | Per-call and per-task records (Compass input) |
| [benchmark.md](benchmark.md) | Fixed-Terra control, replay, savings evidence levels |
| [acceptance-cases.md](acceptance-cases.md) | Behavioral acceptance cases for the V1 implementation |

## Status conventions

- Normative language: MUST/SHOULD/MAY as in RFC 2119, scoped by `spec.md`.
- Anything marked `UNVERIFIED` is design intent pending runtime evidence.
  The P0 per-call switching proof (spec §3) precedes all other runtime
  claims.
