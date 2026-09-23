# System design documents (legacy prototype)

> **Superseded on 2026-09-23 by Scheme A.** These files describe the prototype
> that tickets 02–07 will replace. They are retained only as implementation
> inventory and define no runtime behavior. Do not combine their fallback,
> OFF, tier, lifecycle or record rules with the current
> [specification](../../spec.md) or
> [Runtime Routing Policy](../../skills/jev-auto-router/references/routing-policy.md).

Durable subsystem designs for the per-call V1 architecture of **Jev Auto
Router**. [spec.md](../../spec.md) is the normative specification;
[docs/solution.md](../solution.md) is the full final solution; the
[routing policy](../../skills/jev-auto-router/references/routing-policy.md)
is the canonical runtime contract.

| Document | Scope |
| --- | --- |
| [architecture.md](architecture.md) | Five runtime modules, proxy flow, task boundary, Compass |
| [route-plan.md](route-plan.md) | Routing state, candidate pairs, decision and outcome schemas |
| [capability-catalog.md](capability-catalog.md) | Model/effort availability and valid pairs |
| [jev-adapter.md](jev-adapter.md) | The single seam to the Jev API: one Choice, version pinning, hot path |
| [policy-guard.md](policy-guard.md) | Deterministic validation of candidates, hard constraints, responses |
| [delivery-lifecycle.md](delivery-lifecycle.md) | Task state, correction cycles, Root takeover, verification contract |
| [decision-receipt.md](decision-receipt.md) | Per-call and per-task records (Compass input) |
| [benchmark.md](benchmark.md) | Frozen paired evaluation, full cost accounting, replay evidence levels |
| [acceptance-cases.md](acceptance-cases.md) | Behavioral acceptance cases for the V1 implementation |

## Migration status

The local implementation tickets replace these designs in dependency order.
Until a file is rewritten against Scheme A, any MUST/SHOULD/MAY in it is
historical, not normative.
