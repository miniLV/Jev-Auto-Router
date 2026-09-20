import type { JevPolicy } from "./jev-adapter.js";

export interface ShadowOutcome {
  mode: "shadow";
  /** The pair the actual request uses: the configured baseline. */
  executes: { model: string; effort: string };
  /** The pair Jev would have selected. Logged, never executed. */
  would_be: { model: string; effort: string } | undefined;
}

/**
 * Shadow mode: Jev decides, the would-be route is logged, the actual request
 * uses the configured baseline. Never changes execution.
 */
export function shadowOutcome(
  decisionPair: { model: string; effort: string } | undefined,
  baseline: { model: string; effort: string },
): ShadowOutcome {
  return { mode: "shadow", executes: baseline, would_be: decisionPair };
}

/**
 * Version discipline for an active `jev-latest` alias: a detected change in
 * the resolved version must demote routing to shadow/baseline until the new
 * version is validated.
 */
export function resolvedVersionChanged(
  requested: string,
  resolved: string | "UNKNOWN",
  lastResolved: string | "UNKNOWN",
): boolean {
  if (resolved === "UNKNOWN") return false;
  return lastResolved !== "UNKNOWN" && resolved !== lastResolved && requested === "jev-latest";
}

export interface VersionDisciplineState {
  lastResolved: string | "UNKNOWN";
  demoted: boolean;
}

export function trackResolvedVersion(
  state: VersionDisciplineState,
  policy: JevPolicy,
  resolved: string | "UNKNOWN",
): VersionDisciplineState {
  if (resolved === "UNKNOWN") return state;
  if (resolvedVersionChanged(policy.jevVersion, resolved, state.lastResolved)) {
    return { lastResolved: resolved, demoted: true };
  }
  return { lastResolved: resolved, demoted: state.demoted };
}
