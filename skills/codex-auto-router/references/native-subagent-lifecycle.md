# Native Subagent Lifecycle

This reference executes a Route Decision. It never chooses a route or model.

## Preflight

- Confirm the current native child tool exposes model, reasoning-effort, and
  fresh-context controls.
- Confirm it accepts the exact tuple from the Router Policy.
- Prepare one complete Task Packet with mutually exclusive ownership.
- If any fact is uncertain, return to Root Direct.

Do not use an App Thread, inherited full-history context, or a different model
as an implicit fallback.

## Create and collect

1. Create exactly one child with the Task Packet and the Router Policy tuple.
2. Record the returned child identifier. A successful creation response is not
   proof that the result is correct.
3. Wait only when Root needs the result.
4. Inspect the child's final response and any declared workspace output.
5. Run proportionate verification from Root.

## Follow-up and fallback

If the response is promising but lacks specific information, send one focused
follow-up to the same child. Do not resend the full Task Packet.

After that follow-up, or after any definite failure:

- do not create a replacement child;
- do not switch model, effort, or execution surface;
- continue the remaining work with Root.

If the child identity or state cannot be established, treat it as uncertain and
return to Root. Do not claim that delegated work completed.

## Adoption

Root adopts only verified output. Root resolves conflicts, integrates changes,
runs final checks, and produces the user-facing answer.
