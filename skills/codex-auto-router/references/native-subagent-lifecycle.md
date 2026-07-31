# Native Subagent Lifecycle

This reference executes a Route Decision. It never chooses a route or model.

## Preflight

- Confirm the current native child tool exposes `model`, `reasoning_effort`, and
  fresh-context controls.
- Confirm it accepts the native parameters from the Router Policy.
- Prepare one complete Task Packet with exact, mutually exclusive Worker-owned
  paths and a captured preflight baseline for each writable path.
- If any fact is uncertain, return to Root Direct.

Do not use an App Thread, inherited full-history context, or a different model
as an implicit fallback.

## Create and collect

1. Create exactly one child with the Task Packet and the Router Policy native
   parameters.
2. Record the returned child identifier. A successful creation response is not
   proof that the result is correct.
3. Wait only when Root needs the result.
4. Inspect the child's final response and any declared workspace output.
5. Run proportionate verification from Root.

Root must not edit a Worker-owned path while that Worker is active.

## Follow-up and fallback

If the response is promising but lacks specific information, send one focused
follow-up to the same child. Do not resend the full Task Packet. The Worker
retains exclusive ownership until Root accepts or rejects its result.

After that follow-up, or after any definite failure:

- do not create a replacement child;
- do not switch model, effort, or execution surface;
- enumerate the Worker-declared changes and compare them with the exact owned
  paths in the Task Packet;
- for every owned changed path, explicitly adopt it and transfer ownership to
  Root, or restore it to the captured preflight baseline;
- continue with Root only after every owned changed path has that explicit
  state.

If the child identity or state cannot be established, treat it as uncertain and
return to Root. Do not claim that delegated work completed or continue atop
ambiguous partial writes.

## Adoption

Root adopts only verified output. Root resolves conflicts, integrates changes,
runs final checks, and produces the user-facing answer.
