import { digest } from "./canonical.js";
import type { Tier } from "./types.js";

/**
 * Luna Max binds to gpt-6-luna at max effort. If `max` is not requestable,
 * the supported pairs surface and `lunaBindingDefect` reports the naming
 * defect instead of papering over it.
 */
export const LUNA_MODEL = "gpt-6-luna";
export const LUNA_EFFORT = "max";

export interface ModelInfo {
  model: string;
  tier: Tier;
  /** Efforts advertised by discovery; these are not requestability evidence. */
  supported_efforts: string[];
  /** Exact efforts proved by a successful request through the current caller edge. */
  proved_efforts: string[];
  /** Stable version digest of each exact pair proof, keyed by effort. */
  proof_versions: Record<string, string>;
  /** Expiration time (epoch ms) for each exact pair proof. */
  proof_expires_at: Record<string, number>;
  /** Pairs whose successful response did not authoritatively report effort. */
  effort_observation_unknown: string[];
  /** True only when at least one exact effort pair has a current proof. */
  requestable: boolean;
}

export interface ModelCatalog {
  source: string;
  models: ModelInfo[];
  session_binding_digest: string;
  observed_at: number;
  discoveryDigest: string;
  proofManifestId: string;
  proofManifestDigest: string;
  proofExclusions: Array<{ model: string; effort: string; reason: string }>;
  effortObservationGapCount: number;
}

export type ExclusionReason =
  | "model_not_requestable"
  | "pair_not_proved"
  | "proof_expired"
  | "effort_unsupported"
  | "non_product_tier"
  | "tier_disabled"
  | "forced_model"
  | "not_active_eligible"
  | "astra_not_admitted";

export interface ExcludedPair {
  model: string;
  effort: string;
  reason: ExclusionReason;
}

export interface CandidatePair extends ModelEffortPair {
  pair_id: string;
  tier: Tier;
}

export interface ModelEffortPair {
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
  /** Exact Candidate Pairs approved for Active; other catalog entries stay excluded. */
  allowedPairs?: ModelEffortPair[];
  /** User hard constraint: only this model's pairs participate. */
  forcedModel?: string;
  /** User hard constraint: exactly this pair. */
  forcedPair?: ModelEffortPair;
  /** Astra admission: open one-shot eligibility or explicit mandate. */
  astraAdmitted?: boolean;
}

export function pairId(model: string, effort: string): string {
  return digest({ model, effort }).slice(0, 16);
}

/** Stable identity for the currently proved pairs on one caller edge. */
export function deriveCandidateCatalogId(catalog: ModelCatalog, callerEdgeId: string, now = Date.now()): string {
  const pairs = catalog.models.flatMap(info => currentlyProvedEfforts(info, now).map(effort => {
    const proofVersion = info.proof_versions[effort];
    if (!proofVersion) throw new Error(`missing proof version for ${info.model}/${effort}`);
    return { model: info.model, effort, proofVersion };
  }));
  pairs.sort((left, right) => compare(left.model, right.model) || compare(left.effort, right.effort));
  return `proved-pairs-v1-${digest({ version: 1, callerEdgeId, pairs })}`;
}

/** Best-effort tier inference for hosts that do not label tiers. */
export function inferTier(model: string): Tier | undefined {
  if (model === LUNA_MODEL) return "luna_max";
  if (model.includes("luna")) return "luna_max";
  if (model.includes("sol")) return "sol";
  if (model.includes("astra")) return "astra";
  return undefined;
}

/**
 * Deterministic admission over validated (model, effort) pairs. Never ranks,
 * never shapes a shortlist, never applies a task-type table.
 */
export function buildCandidateSet(catalog: ModelCatalog, constraints: CandidateConstraints = {}, now = Date.now()): CandidateSet {
  const disabled = new Set(constraints.disabledTiers ?? []);
  const excluded: ExcludedPair[] = [];
  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];

  for (const info of catalog.models) {
    if (!info.requestable || info.proved_efforts.length === 0) {
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

      if (!info.proved_efforts.includes(effort)) {
        excluded.push({ model: info.model, effort, reason: "pair_not_proved" });
        continue;
      }
      if (!(info.proof_expires_at[effort] > now)) {
        excluded.push({ model: info.model, effort, reason: "proof_expired" });
        continue;
      }

      if (disabled.has(info.tier)) {
        excluded.push({ model: info.model, effort, reason: "tier_disabled" });
        continue;
      }
      if (constraints.allowedPairs && !constraints.allowedPairs.some(pair => pair.model === info.model && pair.effort === effort)) {
        excluded.push({ model: info.model, effort, reason: "not_active_eligible" });
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
      if (info.tier === "astra" && !constraints.astraAdmitted) {
        excluded.push({ model: info.model, effort, reason: "astra_not_admitted" });
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
export function lunaBindingDefect(catalog: ModelCatalog, now = Date.now()): string | undefined {
  const luna = catalog.models.find(m => m.model === LUNA_MODEL);
  if (!luna) return undefined;
  const provedEfforts = currentlyProvedEfforts(luna, now);
  if (provedEfforts.length > 0 && !provedEfforts.includes(LUNA_EFFORT)) {
    return `Luna Max binds to ${LUNA_MODEL}/${LUNA_EFFORT} but currently proved efforts are [${provedEfforts.join(", ")}]; correct the tier naming`;
  }
  return undefined;
}

/** Resolve the explicitly configured baseline pair. Absent means unavailable. */
export function resolveBaseline(catalog: ModelCatalog, model: string, effort: string, now = Date.now()): CandidatePair | undefined {
  const info = catalog.models.find(m => m.model === model);
  if (!info || !info.requestable || !currentlyProvedEfforts(info, now).includes(effort)) return undefined;
  return { pair_id: pairId(model, effort), tier: info.tier, model, effort };
}

export function currentlyProvedEfforts(info: ModelInfo, now = Date.now()): string[] {
  return info.proved_efforts.filter(effort => info.proof_expires_at[effort] > now);
}

export function currentEffortObservationGapCount(catalog: ModelCatalog, now = Date.now()): number {
  return catalog.models.reduce((count, model) => count + model.effort_observation_unknown.filter(
    effort => model.proof_expires_at[effort] > now,
  ).length, 0);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
