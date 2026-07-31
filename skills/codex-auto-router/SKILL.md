---
name: codex-auto-router
description: Explicitly route one substantial, bounded work unit from the current Root Agent to a lower-cost Terra child while Root retains intent, integration, verification, and final delivery. Use only when the user invokes $codex-auto-router; preserve any upstream Skill workflow and keep tiny, strongly coupled, destructive, or unverifiable work with Root.
---

# Codex Auto Router

Read [references/routing-policy.md](references/routing-policy.md) completely
before making a Route Decision. It is the only routing authority.

## Execute

1. Preserve the user's request, authorization, constraints, and every active
   upstream Skill. Auto Router changes only where one bounded work unit runs.
2. Apply the Router Policy once.
3. For Root Direct, continue the requested work in the Main Task.
4. For Terra Background:
   - read [references/task-packet.md](references/task-packet.md);
   - read
     [references/native-subagent-lifecycle.md](references/native-subagent-lifecycle.md);
   - state the bounded responsibility being delegated;
   - create exactly one native child using the exact route tuple in the Router
     Policy and a fresh context;
   - verify the returned work before adopting it.
5. Return one self-contained final answer from Root.

Do not read the Dashboard, local usage history, research notes, Wiki, or ADRs
to make a Route Decision. Do not invoke another routing or orchestration Skill.
Do not create an App Background Thread as a substitute for the native child.
