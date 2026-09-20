import { digest } from "./canonical.js";
import type { Tier } from "./types.js";

/**
 * Luna Max binds to gpt-5.6-luna at max effort. If `max` is not requestable,
 * the supported pairs surface and `lunaBindingDefect` reports the naming
 * defect instead of papering over it.
 */
export const LUNA_MODEL = "gpt-5.6-luna";
export const LUNA_EFFORT = "max";

export interface ModelInfo {
  model: string;
  tier: Tier;
  supported_efforts: string[];
  /** A trusted host surface accepts this model now. DISCOVERED-only models are absent. */
  requestable: boolean;
}

export interface ModelCatalog {
  source: string;
  models: ModelInfo[];
  session_binding_digest: string;
  observed_at: number;
}

export type ExclusionReason =
  | "model_not_requestable"
  | "effort_unsupported"
  | "non_product_tier"
  | "tier_disabled"
  | "forced_model"
  | "gpt6_not_admitted";

export interface ExcludedPair {
  model: string;
  effort: string;
  reason: ExclusionReason;
}

export interface CandidatePair {
  pair_id: string;
  tier: Tier;
  model: string;
  effort: string;
}

export interface CandidateSet {
  pairs: CandidatePair[];
  excluded: ExcludedPair[];
  digest: string;
}

export interface CandidateConstraints {
  disabledTiers?: Tier[];
  /** User hard constraint: only this model's pairs participate. */
  forcedModel?: string;
  /** User hard constraint: exactly this pair. */
  forcedPair?: Pair;
  /** GPT-6 admission: open one-shot eligibility or explicit mandate. */
  gpt6Admitted?: boolean;
}

interface Pair {
  model: string;
  effort: string;
}

export function pairId(model: string, effort: string): string {
  return digest({ model, effort }).slice(0, 16);
}

/** Best-effort tier inference for hosts that do not label tiers. */
export function inferTier(model: string): Tier | undefined {
  if (model === LUNA_MODEL) return "luna_max";
  if (model.includes("luna")) return "luna_max";
  if (model.includes("terra")) return "terra";
  if (model.includes("sol")) return "sol";
  if (model.includes("gpt-6")) return "gpt6";
  return undefined;
}

/**
 * Deterministic admission over validated (model, effort) pairs. Never ranks,
 * never shapes a shortlist, never applies a task-type table.
 */
export function buildCandidateSet(catalog: ModelCatalog, constraints: CandidateConstraints = {}): CandidateSet {
  const disabled = new Set(constraints.disabledTiers ?? []);
  const excluded: ExcludedPair[] = [];
  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];

  for (const info of catalog.models) {
    if (!info.requestable) {
      excluded.push({ model: info.model, effort: "*", reason: "model_not_requestable" });
      continue;
    }
    if (info.supported_efforts.length === 0) {
      excluded.push({ model: info.model, effort: "*", reason: "effort_unsupported" });
      continue;
    }
    for (const effort of info.supported_efforts) {
      const key = `${info.model}/${effort}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (disabled.has(info.tier)) {
        excluded.push({ model: info.model, effort, reason: "tier_disabled" });
        continue;
      }
      if (constraints.forcedModel && info.model !== constraints.forcedModel) {
        excluded.push({ model: info.model, effort, reason: "forced_model" });
        continue;
      }
      if (
        constraints.forcedPair &&
        (info.model !== constraints.forcedPair.model || effort !== constraints.forcedPair.effort)
      ) {
        excluded.push({ model: info.model, effort, reason: "forced_model" });
        continue;
      }
      if (info.tier === "gpt6" && !constraints.gpt6Admitted) {
        excluded.push({ model: info.model, effort, reason: "gpt6_not_admitted" });
        continue;
      }
      pairs.push({ pair_id: pairId(info.model, effort), tier: info.tier, model: info.model, effort });
    }
  }

  return {
    pairs,
    excluded,
    digest: digest({ pairs: pairs.map(p => [p.model, p.effort]), policy: "per-call-pairs/1" }),
  };
}

/** Luna binding check: reports a naming defect when max is not requestable. */
export function lunaBindingDefect(catalog: ModelCatalog): string | undefined {
  const luna = catalog.models.find(m => m.model === LUNA_MODEL);
  if (!luna || !luna.requestable) return undefined;
  if (!luna.supported_efforts.includes(LUNA_EFFORT)) {
    return `Luna Max binds to ${LUNA_MODEL}/${LUNA_EFFORT} but supported efforts are [${luna.supported_efforts.join(", ")}]; correct the tier naming`;
  }
  return undefined;
}

/** Baseline pair resolution (default Terra/medium). Absent means unavailable. */
export function resolveBaseline(catalog: ModelCatalog, model: string, effort: string): CandidatePair | undefined {
  const info = catalog.models.find(m => m.model === model);
  if (!info || !info.requestable || !info.supported_efforts.includes(effort)) return undefined;
  return { pair_id: pairId(model, effort), tier: info.tier, model, effort };
}
