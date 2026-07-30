import type { LocalUsage, OfficialSnapshot, UsageViewModel } from "./types.js";

function decimalParts(value: string): { whole: string; fraction: string } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("Invalid decimal");
  return { whole: match[1], fraction: match[2] ?? "" };
}

function decimalPlaces(value: string): number {
  return decimalParts(value).fraction.length;
}

function scaleDecimal(value: string, places: number): bigint {
  const { whole, fraction } = decimalParts(value);
  return BigInt(`${whole}${fraction.padEnd(places, "0")}`);
}

function formatScaled(value: bigint, places: number): string {
  const divisor = 10n ** BigInt(places);
  return `${value / divisor}.${(value % divisor).toString().padStart(places, "0")}`;
}

export function displayCredit(value: string): string {
  const { whole, fraction } = decimalParts(value);
  return `${whole}.${fraction.padEnd(Math.max(2, fraction.length), "0")}`;
}

export function subtractCredits(limit: string, used: string): string | undefined {
  const places = Math.max(decimalPlaces(limit), decimalPlaces(used), 2);
  const difference = scaleDecimal(limit, places) - scaleDecimal(used, places);
  return difference < 0n ? undefined : formatScaled(difference, places);
}

export function allocateCredits(used: string, models: LocalUsage["models"]): Array<{ model: string; credits: string }> {
  const known = models.filter((entry) => Number.isSafeInteger(entry.tokens) && entry.tokens > 0);
  const totalTokens = known.reduce((total, entry) => total + entry.tokens, 0);
  if (totalTokens <= 0) return [];

  const places = Math.max(2, decimalPlaces(used));
  const totalMinor = scaleDecimal(used, places);
  const denominator = BigInt(totalTokens);
  const rows = known.map((entry, index) => {
    const numerator = totalMinor * BigInt(entry.tokens);
    return { ...entry, index, base: numerator / denominator, remainder: numerator % denominator };
  });
  let unitsLeft = totalMinor - rows.reduce((total, row) => total + row.base, 0n);
  for (const row of [...rows].sort((a, b) => b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index)) {
    if (unitsLeft <= 0n) break;
    row.base += 1n;
    unitsLeft -= 1n;
  }
  return rows.map((row) => ({ model: row.model, credits: formatScaled(row.base, places) }));
}

export function makeViewModel(official: OfficialSnapshot, local: LocalUsage | undefined): UsageViewModel {
  if (!official.rateLimit) {
    return {
      officialCredit: { status: "unavailable" },
      estimatedCreditAttribution: [],
      attributionQuality: { status: "unavailable", message: "Official credit is unavailable, so estimates are unavailable." }
    };
  }
  const rate = official.rateLimit;
  const officialCredit = {
    status: "available" as const,
    limit: displayCredit(rate.limit),
    used: displayCredit(rate.used),
    remaining: displayCredit(rate.remaining),
    remainingPercent: rate.remainingPercent,
    resetsAt: rate.resetsAt
  };
  if (!local || local.models.length === 0) {
    return {
      officialCredit,
      estimatedCreditAttribution: [],
      attributionQuality: { status: "unavailable", message: "Local model attribution is unavailable." }
    };
  }
  return {
    officialCredit,
    estimatedCreditAttribution: allocateCredits(rate.used, local.models),
    attributionQuality: {
      status: "estimated",
      message: official.usageAvailable
        ? "Estimated from local model-token shares. The local window is source-own and may not reconcile with official activity; official credit remains authoritative."
        : "Estimated from local model-token shares. The local window is source-own and is not reconciled with official activity; official credit remains authoritative."
    }
  };
}
