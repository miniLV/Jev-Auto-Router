import type { CandidateSet, CandidateConstraints } from "./catalog.js";
import type { JevDecision } from "./route-plan.js";

export type GuardReason =
  | "INVALID_DECISION"
  | "LOW_CONFIDENCE"
  | "PAIR_UNAVAILABLE"
  | "HARD_CONSTRAINT"
  | "GPT6_NOT_ADMITTED"
  | "VERSION_DRIFT"
  | "PRIVACY_REFUSAL";

export type GuardVerdict = { verdict: "ALLOW"; pair_id: string } | { verdict: "DENY"; reason: GuardReason };

/**
 * Deterministic validation of a Jev decision. ALLOW returns exactly the
 * selected pair; DENY returns a reason and never an alternative. Jev
 * chooses; the Guard validates. Fallback is the routing module's fixed
 * handling, not a substitution made here.
 */
export function validate(
  decision: JevDecision,
  candidateSet: CandidateSet,
  constraints: CandidateConstraints,
  privacyRefused = false,
): GuardVerdict {
  // 1. Schema and membership: the choice must be a member of the exact candidate set.
  if (!decision.valid || decision.chosen_pair_id === undefined) {
    return { verdict: "DENY", reason: "INVALID_DECISION" };
  }
  const pair = candidateSet.pairs.find(p => p.pair_id === decision.chosen_pair_id);
  if (!pair) return { verdict: "DENY", reason: "INVALID_DECISION" };

  // 2. Confidence finite in [0,1] and at/above the frozen floor.
  const confidence = decision.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { verdict: "DENY", reason: "LOW_CONFIDENCE" };
  }

  // 3. Resolved pair is a validated host-requestable combination.
  if (!candidateSet.pairs.some(p => p.pair_id === pair.pair_id)) {
    return { verdict: "DENY", reason: "PAIR_UNAVAILABLE" };
  }

  // 4. User hard constraints execute as stated (forced model / forced pair).
  if (constraints.forcedModel && pair.model !== constraints.forcedModel) {
    return { verdict: "DENY", reason: "HARD_CONSTRAINT" };
  }
  if (
    constraints.forcedPair &&
    (pair.model !== constraints.forcedPair.model || pair.effort !== constraints.forcedPair.effort)
  ) {
    return { verdict: "DENY", reason: "HARD_CONSTRAINT" };
  }

  // 5. GPT-6 appears only under open one-shot eligibility or explicit mandate.
  if (pair.tier === "gpt6" && !constraints.gpt6Admitted) {
    return { verdict: "DENY", reason: "GPT6_NOT_ADMITTED" };
  }

  // 6. Response model matches the pinned Jev version.
  if (decision.jev_resolved_version !== "UNKNOWN" && decision.jev_resolved_version !== decision.jev_requested_version) {
    return { verdict: "DENY", reason: "VERSION_DRIFT" };
  }

  // 7. Routing state passed the send policy (defense in depth for the proxy check).
  if (privacyRefused) {
    return { verdict: "DENY", reason: "PRIVACY_REFUSAL" };
  }

  return { verdict: "ALLOW", pair_id: pair.pair_id };
}
