---
name: codex-auto-router
description: Use only when the user message literally includes $codex-auto-router. It routes one substantial, bounded work unit to a Terra child while Root retains intent, integration, verification, and final delivery; never activate it from task characteristics alone.
---

# Codex Auto Router

Use this Skill only when the user explicitly invokes `$codex-auto-router`.
Do not infer invocation from task characteristics, model cost, or another Skill.

Read [references/routing-policy.md](references/routing-policy.md) completely
before making a Route Decision. It is the only routing authority. Do not read
any other reference to decide `ROOT_DIRECT`.

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

No other documentation, usage source, or Skill config participates in a Route
Decision. Do not invoke another routing or orchestration Skill for the same
task. Do not create an App Background Thread as a substitute for the native
child.
