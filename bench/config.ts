import { createHash } from "node:crypto";
import type { ModelCatalog, ModelEffortPair } from "../src/catalog.js";
import type { JevPolicyParameters } from "../src/jev-adapter.js";

export type CandidatePair = ModelEffortPair;

/** Frozen prices per million tokens. Controlled runs require every bucket. */
export interface PriceWeights {
  [model: string]: {
    input: number;
    cached_input: number;
    cache_write_input: number;
    output: number;
  };
}

export interface HarnessConfig {
  release: string;
  mode: "active" | "shadow";
  baseline: CandidatePair;
  candidates: CandidatePair[];
  currency: string;
  priceSourceRef: string;
  callerEdgeId: string;
  /** Current sanitized discovery/proof snapshot used to verify the catalog ID. */
  candidateCatalog: ModelCatalog;
  candidateCatalogId: string;
  jevVersion: string;
  runtimePolicy: JevPolicyParameters;
  policyVersion: string;
  questionSchemaVersion: string;
  prices: PriceWeights;
  cacheConditions: "cold" | "warm" | "declared-per-task";
}

export function priceWeightsDigest(config: HarnessConfig): string {
  const sorted = Object.fromEntries(Object.entries(config.prices).sort(([a], [b]) => a.localeCompare(b)).map(([model, rates]) => [model, {
    input: rates.input,
    cached_input: rates.cached_input,
    cache_write_input: rates.cache_write_input,
    output: rates.output,
  }]));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
