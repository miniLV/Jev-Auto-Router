import { rankOf } from "./config.js";
import type { RouterConfig, Tier } from "./types.js";
import { TIERS } from "./types.js";

export interface PolicyJev {
  choice: Tier;
  confidence: number;
}

export interface PolicyInput {
  prompt: string;
  jev: PolicyJev | null;
  current: Tier;
  available: Tier[];
  contextTokens: number;
  config: Pick<RouterConfig, "tiers" | "minConfidence" | "uncertainCeiling" | "downgradeMaxContextTokens" | "allowLong">;
}

export interface PolicyDecision {
  tier: Tier;
  reason: string;
  changed: boolean;
}

const TIER_ALIASES: Record<Tier, string[]> = {
  fast: ["fast", "luna", "haiku"],
  balanced: ["balanced", "terra"],
  strong: ["strong", "sol", "opus"],
  long: ["long", "astra", "fable"],
};

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Explicit user control wins over Jev. Only imperative forms count, so prose
 * such as "the sol of this problem" cannot silently pin a tier.
 */
export function detectOverride(prompt: string, tiers: RouterConfig["tiers"]): Tier | null {
  const exact = TIERS.find((tier) => tiers[tier] && new RegExp(`\\b${escape(tiers[tier])}\\b`, "i").test(prompt));
  for (const tier of TIERS) {
    const aliases = TIER_ALIASES[tier].join("|");
    if (new RegExp(`\\b(?:use|switch to|with|on)\\s+(?:${aliases})\\b`, "i").test(prompt)) {
      return tier;
    }
  }
  if (exact && /\b(?:use|switch to|with|on)\b/i.test(prompt)) return exact;
  return null;
}

/** Nearest tier the account can actually run. Prefer stepping up over down. */
export function clampToAvailable(tier: Tier, available: Tier[], allowLong: boolean): Tier | undefined {
  const usable = available.filter((candidate) => candidate !== "long" || allowLong);
  if (usable.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIERS.filter(
    (candidate) =>
      rankOf(candidate) > rank &&
      usable.includes(candidate) &&
      (candidate !== "long" || tier === "long" || allowLong),
  );
  if (up.length > 0) return up[0];
  const down = TIERS.filter((candidate) => rankOf(candidate) < rank && usable.includes(candidate));
  return down.length > 0 ? down[down.length - 1] : undefined;
}

/**
 * Turn a Jev answer into the tier we will actually run. Pure and total: any
 * missing, malformed or unavailable input keeps the current model.
 *
 * The cache gate is intentionally asymmetric. A downgrade has a measurable
 * token saving and a measurable rebuild cost; above the threshold it is
 * refused. An upgrade is a quality decision, so the gate does not block it.
 * Both directions still pay for a cache rebuild.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const { current, available, contextTokens, config } = input;
  const settle = (tier: Tier, reason: string): PolicyDecision => {
    const final = clampToAvailable(tier, available, config.allowLong) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return {
      tier: final,
      reason: final === current ? `${why}/no-change` : why,
      changed: final !== current,
    };
  };

  const override = detectOverride(input.prompt, config.tiers);
  if (override) return settle(override, "override");

  const jev = input.jev;
  if (!jev || !TIERS.includes(jev.choice) || !Number.isFinite(jev.confidence)) {
    return settle(current, "jev-unavailable");
  }

  let target = jev.choice;
  let reason = "jev";

  if (jev.confidence < config.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceilingRank = Math.max(rankOf(current), rankOf(config.uncertainCeiling));
    if (rankOf(target) > ceilingRank) {
      target = TIERS[ceilingRank];
      reason = "low-confidence-capped";
    }
  }

  if (rankOf(target) < rankOf(current) && contextTokens > config.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, reason);
}

/** True when the policy accepted Jev's exact model rather than only its tier. */
export function shouldUseExactModel(reason: string, chosenTier: Tier, finalTier: Tier): boolean {
  return (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}
