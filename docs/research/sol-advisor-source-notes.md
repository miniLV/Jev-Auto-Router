# Sol Advisor source notes

Reviewed upstream `DannyMac180/sol-advisor` at commit [`37b75cad535abdd46531f0227483a8842d045ab8`](https://github.com/DannyMac180/sol-advisor/tree/37b75cad535abdd46531f0227483a8842d045ab8) on 2026-09-23. The findings below come from the repository's README, plugin manifest, skill, role contracts, role TOMLs, and installer/runtime scripts. Links are pinned to that commit.

## Architecture and main flow

- This is a Codex-only plugin/skill. The manifest exposes `./skills/` and describes a primary GPT-5.6 Sol / High session that owns architecture, solo or audit implementation, verification, and acceptance; its default prompt asks the task to invoke the orchestration skill before task tools. [manifest](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/.codex-plugin/plugin.json#L10-L19)
- The user installs the marketplace plugin, installs the companion role files, then starts a fresh task. The README requires a current Codex CLI or ChatGPT desktop app with plugins, native custom-agent support, and `jq`; Luna/Terra access is needed only for delegated routes. [README](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/README.md#L14-L35)
- The primary session must be Sol / High. Before the first task tool call it emits a machine-auditable `SELECTIVE ROUTE` containing one of four modes and a task-specific risk rationale. The skill explicitly says it cannot change the primary model itself. [skill](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/SKILL.md#L18-L39)
- Delivery is selective: `solo` keeps planning, implementation, tests, and self-review in the root; `delegate` gives the complete specification to one implementer and leaves verification to the root; `audit` has the root implement and verify, then a fresh Sol reviewer inspect the diff; `full` combines one implementer and one fresh reviewer for an explicit broad/high-risk exception. [skill](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/SKILL.md#L41-L66) [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L159-L178)

## Routing granularity

Routing is task-level and mode-level. One declaration governs the delivery path before work starts; the default is solo and the default auxiliary limit is one. A later declaration may only escalate after newly observed risk. In delegate/full, the selected worker executes the complete supplied specification, so the source does not describe per-file, per-call, token-level, or continuous model routing. [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L68-L110) [role contracts](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L41-L81)

The worker packet is deliberately bounded: objective, exact file ownership, interfaces, constraints, verification, and a structured return. The root retains architecture, diff inspection, verification reruns, escalation, and acceptance; auxiliary work is intended to substitute for root work rather than duplicate it. [role contracts](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L41-L81)

## How the model switch actually happens

There is no in-task primary-session switch. The user/host must already run the primary task on GPT-5.6 Sol / High; otherwise the skill tells Sol to stop. [skill](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/SKILL.md#L18-L24)

Delegated model selection happens through native custom-agent profiles installed into the host's agents directory:

| Native role | Pinned model/effort | Route use |
|---|---|---|
| `sol_advisor_luna_implementer` | `gpt-5.6-luna` / `max` | bounded routine implementation |
| `sol_advisor_terra_implementer` | `gpt-5.6-terra` / `high` | judgment-heavy/high-risk implementation |
| `sol_advisor_sol_reviewer` | `gpt-5.6-sol` / `high` | fresh audit/full review; requests read-only sandbox |

These pins are in the TOMLs and the operations reference. Spawning names the exact role with `fork_turns: none`; per-spawn model/effort overrides are forbidden, so the host performs the actual model choice from the installed profile. [role pins and spawn contract](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L7-L39) [TOMLs](https://github.com/DannyMac180/sol-advisor/tree/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/agents)

The installer defaults to `$CODEX_HOME/agents` or `$HOME/.codex/agents`, refuses modified/nonregular/symlinked destinations, and explicitly does not change Codex configuration. It performs exactness checks and post-install validation. [installer](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/scripts/install-agents.sh#L1-L23) [installer paths and checks](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/scripts/install-agents.sh#L144-L152) [post-install checks](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/scripts/install-agents.sh#L264-L309)

If public spawn metadata omits model or effort, the local inspector reads exactly one rollout file for the native thread, returns an allowlisted metadata object, and fails on missing/conflicting values. It is an evidence/fail-closed helper, not a model-selection fallback. [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L115-L142) [inspector](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/scripts/inspect-agent-runtime.sh#L81-L155)

## Host integration and isolation

The integration point is the Codex plugin/skill system plus user-owned native agent TOMLs, not an external router service, API proxy, or nested Codex CLI. The role contract explicitly says the profiles do not launch a nested CLI or change global default-agent routing. [role contracts](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L1-L8)

The reviewer profile requests `sandbox_mode = "read-only"`, but the workflow requires observing the host's actual sandbox and permission metadata. If the host broadens isolation, the parent may continue only when hard isolation is unnecessary, prompts forbid edits, and exact before/after state is captured; unobservable isolation or any mutation stops the review. [role contracts](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L156-L168) [isolation interpretation](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L201-L210)

## Cost and quality evidence

The repository contains no workload benchmark, token/price accounting, latency study, pass-rate report, or comparative quality evaluation at this commit. The tracked tree is the plugin manifest, README, three role profiles, skill/reference Markdown, and shell helpers; the maintainer verifier covers structural and safety fixtures, JSON/TOML/shell validity, installer behavior, and synthetic runtime metadata. [commit tree](https://github.com/DannyMac180/sol-advisor/tree/37b75cad535abdd46531f0227483a8842d045ab8) [verification scope](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L180-L193)

The cost story is therefore a design implication, not a measured result: solo uses no auxiliary; delegate uses one implementer; audit uses one reviewer; full uses one implementer plus one reviewer. The source gives no prices or usage counts from which to claim savings. The quality story is procedural: parent verification and, where selected, a fresh reviewer returning `ship`, `fix-first`, or `rethink`; any correction invalidates the prior verdict and requires a new review. [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L156-L178)

I ran the upstream `plugins/sol-advisor/scripts/verify.sh` from this commit; it completed with `VERIFY PASSED`, including installer refusal fixtures, runtime-inspector safety, route-contract checks, README checks, and shell syntax. That validates repository mechanics, not end-to-end delivery quality or cost.

## Relevance to Codex

### Strengths

- Native role pins make the intended Luna/Terra/Sol selection explicit and inspectable, with fresh contexts and no per-spawn override ambiguity. [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L7-L39)
- The route declaration, exact ownership packet, parent acceptance, and fail-closed evidence rules create a clear audit trail for a Codex task. [skill](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/SKILL.md#L26-L39) [role contracts](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L24-L39)
- Keeping the root responsible for architecture and verification limits delegation fan-out and makes the review surface understandable. [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L169-L178)

### Limits

- It is an instruction-and-profile workflow, not a measured routing engine: risk classification, route choice, and escalation are performed by the primary model under the skill contract.
- It cannot change the current primary model, relies on host support for native custom agents and exact GPT-5.6 model IDs, and stops when required routing evidence is missing or inconsistent. [skill](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/SKILL.md#L18-L24) [operations](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/operations.md#L38-L39)
- Routing is coarse relative to a per-call router: one whole-task worker or reviewer lane is selected, with no source evidence for subtask-level adaptation or quality/cost optimization.
- The review is context-clean but still Sol reviewing Sol; the source explicitly says this is not cross-model-family independence. [role contracts](https://github.com/DannyMac180/sol-advisor/blob/37b75cad535abdd46531f0227483a8842d045ab8/plugins/sol-advisor/skills/orchestration/references/role-contracts.md#L201-L202)

