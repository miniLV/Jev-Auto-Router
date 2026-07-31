# Runtime Router Policy

Policy version: `1.0.0`

This file is the sole runtime authority for route eligibility, Worker model,
reasoning effort, and fallback behavior. If any other file conflicts with it,
this file wins.

## Invocation

V1 runs only when the user explicitly invokes `$codex-auto-router`. It must not
activate from task characteristics alone.

Auto Router preserves the Route Request and any upstream Skill. It does not
judge whether a ticket is complete, redesign the upstream workflow, or change
the Root Model.

Do not use this Policy for a task while another active policy selects routes or
models for that same task. Merely having another package installed is not a
conflict. If the platform or a mandatory runtime constraint rejects this
Policy's delegation, choose `ROOT_DIRECT`.

## Route decisions

Return exactly one decision:

- `ROOT_DIRECT`
- `TERRA_HIGH_BACKGROUND`

Choose `TERRA_HIGH_BACKGROUND` only when every condition is true:

1. One substantial work unit can be separated without changing the user's
   objective or the upstream workflow.
2. The work unit has exact, exclusive Worker-owned paths and can be retried,
   safely discarded, or restored to its captured preflight state.
3. The work unit can be expressed in a self-contained Task Packet without
   copying most of the Main Task history.
4. Root can verify the result with a deterministic command, test, or output
   comparison without rederiving the Worker’s answer.
5. Expected execution work materially exceeds child startup, handoff, and Root
   verification overhead.
6. The current native child tool accepts the native parameters below with fresh
   context.

Otherwise choose `ROOT_DIRECT`. In particular, keep tiny changes, strongly
sequential work, context-heavy judgment, external or destructive actions, and
work without a mechanical verification method with Root.

Do not use task labels, file count, Jira issue type, personal model history, or
Dashboard Credit values as automatic proxies for this decision.

## Route receipt

For every Route Decision, Root emits a compact receipt in Main Task commentary:

```text
Auto Router: <decision>; reason: <short reason>
```

For `TERRA_HIGH_BACKGROUND`, append the bounded responsibility and mechanical
verification target. A receipt is transparency for the current task only. This
Policy never writes it to a file, sends it to the Dashboard, or reads it as
input to a later Route Decision.

## Native child parameters

Use exactly these native child-tool parameters:

```yaml
model: gpt-5.6-terra
reasoning_effort: high
fork_turns: none
```

`reasoning_effort: high` is a V1 quality-first default: avoiding Worker rework
is more important than tuning effort before evidence exists. Reconsider it
only after a human has reviewed at least five available route receipts and
outcomes. This Policy does not collect receipts automatically or adapt routes.

## Root policy limits

- Maximum active children: `1`.
- Maximum follow-ups to that child: `1`.
- The Worker must not create descendants.

Root owns planning, external actions, integration, final verification, and user
delivery.

V1 has no alternate model, App Thread surface, replacement Worker, or automatic
model escalation.

## Failure behavior

- Unsupported or rejected route tuple: use `ROOT_DIRECT`.
- Child creation result is missing or uncertain: use `ROOT_DIRECT`; do not
  retry creation.
- Child output lacks information: follow up with the same child once while it
  retains exclusive ownership.
- Child remains incomplete, incorrect, or unverifiable: resolve its owned-file
  state before Root takes over, as defined by the Native Subagent Lifecycle.
- User requests no delegation or a conflicting execution constraint: use
  `ROOT_DIRECT`.

Never silently change the model, effort, execution surface, or number of
Workers during fallback.
