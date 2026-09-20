import { createHash } from "node:crypto";

/**
 * Offline evaluation configuration. Prices are frozen per benchmark release
 * and live only here — the runtime never sees them.
 */
export interface PriceWeights {
  /** Price per million tokens by model: input and output. */
  [model: string]: { input: number; output: number };
}

export interface HarnessConfig {
  release: string;
  prices: PriceWeights;
  /** Declared cache regime for every reported run. */
  cacheConditions: "cold" | "warm" | "declared-per-task";
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  release: "v1-eval-0",
  cacheConditions: "declared-per-task",
  prices: {
    "gpt-5.6-luna": { input: 0.25, output: 1.25 },
    "gpt-5.6-terra": { input: 1.25, output: 5 },
    "gpt-5.6-sol": { input: 5, output: 20 },
    "gpt-6-astra": { input: 25, output: 100 },
    "jev-1.13.0": { input: 0.042, output: 0 },
  },
};

export function priceWeightsDigest(config: HarnessConfig): string {
  return createHash("sha256").update(JSON.stringify(config.prices)).digest("hex");
}
