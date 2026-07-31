# Router Policy

Policy version: `1.0.0`

This file is the sole runtime authority for route eligibility, Worker model,
reasoning effort, and fallback behavior. If any other file conflicts with it,
this file wins.

## Invocation

V1 runs only when the user explicitly invokes `$codex-auto-router`.

Auto Router preserves the Route Request and any upstream Skill. It does not
judge whether a ticket is complete, redesign the upstream workflow, or change
the Root Model.

## Route decisions

Return exactly one decision:

- `ROOT_DIRECT`
- `TERRA_HIGH_BACKGROUND`

Choose `TERRA_HIGH_BACKGROUND` only when every condition is true:

1. One substantial work unit can be separated without changing the user's
   objective or the upstream workflow.
2. The work unit can be expressed in a self-contained Task Packet without
   copying most of the Main Task history.
3. Scope, ownership, acceptance criteria, and verification are concrete.
4. Expected execution work materially exceeds child startup, handoff, and Root
   verification overhead.
5. Root can independently verify the result before adopting it.
6. The current native child tool accepts the exact model, effort, and fresh
   context required below.

Otherwise choose `ROOT_DIRECT`. In particular, keep tiny changes, strongly
sequential work, context-heavy judgment, external or destructive actions, and
work without a reliable verification method with Root.

Do not use task labels, file count, Jira issue type, personal model history, or
Dashboard Credit values as automatic proxies for this decision.

## Terra Background route

Use exactly:

```yaml
model: gpt-5.6-terra
reasoning_effort: high
fork_turns: none
maximum_workers: 1
maximum_followups: 1
```

The Worker must not create descendants. Root owns planning, external actions,
integration, final verification, and user delivery.

V1 has no alternate model, App Thread surface, replacement Worker, or automatic
model escalation.

## Failure behavior

- Unsupported or rejected route tuple: use `ROOT_DIRECT`.
- Child creation result is missing or uncertain: use `ROOT_DIRECT`; do not
  retry creation.
- Child output lacks information: follow up with the same child once.
- Child remains incomplete, incorrect, or unverifiable: Root takes over.
- User requests no delegation or a conflicting execution constraint: use
  `ROOT_DIRECT`.

Never silently change the model, effort, execution surface, or number of
Workers during fallback.
