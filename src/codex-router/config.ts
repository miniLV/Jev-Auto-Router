import type {
  ModelCandidate,
  RouterConfig,
  Tier,
  TierModels,
} from "./types.js";
import { AUTO_MODEL, TIERS, TIER_RANK } from "./types.js";

export const DEFAULT_TIERS: TierModels = {
  fast: "gpt-6-luna",
  balanced: "gpt-6-sol",
  strong: "gpt-6.1-sol",
  long: "gpt-6-astra",
};

export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const DEFAULT_DOWNGRADE_MAX_CONTEXT_TOKENS = 20_000;
export const DEFAULT_MIN_CONFIDENCE = 0.3;
export const DEFAULT_JEV_MODEL = "jev-1.13.0";
export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";

const TIER_ENV: Record<Tier, string> = {
  fast: "JEV_CODEX_FAST_MODEL",
  balanced: "JEV_CODEX_BALANCED_MODEL",
  strong: "JEV_CODEX_STRONG_MODEL",
  long: "JEV_CODEX_LONG_MODEL",
};

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = envString(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.trunc(value);
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envString(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = envString(env, name)?.toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return fallback;
}

export function parseTier(value: unknown): Tier | undefined {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
    ? (value as Tier)
    : undefined;
}

export function rankOf(tier: Tier): number {
  return TIER_RANK[tier];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const tiers: TierModels = {
    fast: envString(env, TIER_ENV.fast) ?? DEFAULT_TIERS.fast,
    balanced: envString(env, TIER_ENV.balanced) ?? DEFAULT_TIERS.balanced,
    strong: envString(env, TIER_ENV.strong) ?? DEFAULT_TIERS.strong,
    long: envString(env, TIER_ENV.long) ?? DEFAULT_TIERS.long,
  };
  const uncertainCeiling = parseTier(envString(env, "JEV_CODEX_UNCERTAIN_CEILING")) ?? "balanced";
  return {
    tiers,
    allowLong: envFlag(env, "JEV_CODEX_ALLOW_LONG", envFlag(env, "JEV_ALLOW_LONG", false)),
    minConfidence: envNumber(env, "JEV_CODEX_MIN_CONFIDENCE", DEFAULT_MIN_CONFIDENCE),
    uncertainCeiling,
    downgradeMaxContextTokens: envInt(
      env,
      "JEV_CODEX_DOWNGRADE_MAX_CONTEXT_TOKENS",
      DEFAULT_DOWNGRADE_MAX_CONTEXT_TOKENS,
      1,
    ),
    contextWindowTokens: envInt(env, "JEV_CODEX_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW, 1),
    jevModel: envString(env, "JEV_MODEL") ?? DEFAULT_JEV_MODEL,
    jevEndpoint: envString(env, "JEV_ENDPOINT") ?? DEFAULT_JEV_ENDPOINT,
    jevTimeoutMs: envInt(env, "JEV_CODEX_JEV_TIMEOUT_MS", 1_500, 1),
    jevDeadlineMs: envInt(env, "JEV_CODEX_JEV_DEADLINE_MS", 3_000, 1),
    jevMaxRetries: envInt(env, "JEV_CODEX_JEV_MAX_RETRIES", 1),
    apiKey: envString(env, "JEV_API_KEY") ?? envString(env, "TYPESAFE_API_KEY"),
    defaultModel: envString(env, "JEV_CODEX_DEFAULT_MODEL") ?? tiers.strong,
    autoModelDisplayName: envString(env, "JEV_CODEX_MODEL_LABEL") ?? "Jev Router",
    chatgptBaseUrl: envString(env, "JEV_CODEX_CHATGPT_BASE_URL") ?? DEFAULT_CHATGPT_BASE_URL,
    apiBaseUrl: envString(env, "JEV_CODEX_API_BASE_URL") ?? DEFAULT_API_BASE_URL,
    commentary: envFlag(env, "JEV_CODEX_COMMENTARY", true),
    logFile: envString(env, "JEV_CODEX_LOG_FILE"),
    debug: envFlag(env, "JEV_CODEX_DEBUG", false),
  };
}

/** The tier configured for one exact model ID, if any. */
export function configuredTier(model: string, tiers: TierModels): Tier | undefined {
  for (const tier of TIERS) {
    if (tiers[tier] === model) return tier;
  }
  return undefined;
}

/** Best-effort tier inference for a model ID that is not configured exactly. */
export function inferTier(model: string): Tier | undefined {
  if (!/^gpt-/i.test(model) && !/^(?:luna|sol|astra|terra|fable)/i.test(model)) return undefined;
  if (/(?:astra|fable|long)/i.test(model)) return "long";
  if (/(?:luna|haiku|fast|mini|nano|flash)/i.test(model)) return "fast";
  if (/(?:terra|balanced)/i.test(model)) return "balanced";
  if (/(?:sol|opus|strong|max|pro)/i.test(model)) return "strong";
  return "balanced";
}

export function tierForModel(model: string, tiers: TierModels): Tier | undefined {
  return configuredTier(model, tiers) ?? inferTier(model);
}

export function modelForTier(candidates: readonly ModelCandidate[], tier: Tier): string | undefined {
  return candidates.find((candidate) => candidate.tier === tier)?.id;
}

export function candidateForModel(
  candidates: readonly ModelCandidate[],
  model: string,
): ModelCandidate | undefined {
  return candidates.find((candidate) => candidate.id === model);
}

export function availableTiers(candidates: readonly ModelCandidate[]): Tier[] {
  return [...new Set(candidates.map((candidate) => candidate.tier))];
}

interface CatalogEntry {
  slug?: unknown;
  id?: unknown;
  display_name?: unknown;
  description?: unknown;
  supported_in_api?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
  context_window?: unknown;
}

function catalogArray(payload: unknown): CatalogEntry[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const value = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.data)
      ? record.data
      : [];
  return value.filter((entry): entry is CatalogEntry => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

function effortList(entry: CatalogEntry): { efforts: string[]; defaultEffort?: string } {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels
    : [];
  const efforts: string[] = [];
  for (const level of levels) {
    if (!level || typeof level !== "object" || Array.isArray(level)) continue;
    const effort = (level as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort.trim()) efforts.push(effort);
  }
  const defaultEffort = typeof entry.default_reasoning_level === "string"
    ? entry.default_reasoning_level
    : undefined;
  return { efforts, defaultEffort };
}

function descriptionOf(entry: CatalogEntry, tier: Tier): string {
  const display = typeof entry.display_name === "string" ? entry.display_name : undefined;
  const description = typeof entry.description === "string" ? entry.description : undefined;
  const context = typeof entry.context_window === "number" ? `${entry.context_window} context tokens` : undefined;
  return [display, description, context, `Tier: ${tier}`].filter(Boolean).join("; ");
}

/**
 * Build the candidates from the account's native catalog. If the catalog has no
 * recognisable GPT models, fall back to the configured tier models so the router
 * can still start on a cold catalog.
 */
export function candidatesFromCatalog(payload: unknown, tiers: TierModels, allowLong: boolean): ModelCandidate[] {
  const byTier = new Map<Tier, ModelCandidate>();
  for (const entry of catalogArray(payload)) {
    const id = typeof entry.slug === "string"
      ? entry.slug
      : typeof entry.id === "string"
        ? entry.id
        : undefined;
    if (!id || id === AUTO_MODEL) continue;
    if (entry.supported_in_api === false) continue;
    const tier = tierForModel(id, tiers);
    if (!tier) continue;
    if (tier === "long" && !allowLong) continue;
    if (byTier.has(tier)) continue;
    const { efforts, defaultEffort } = effortList(entry);
    byTier.set(tier, {
      id,
      tier,
      description: descriptionOf(entry, tier),
      supportedEfforts: efforts,
      defaultEffort,
      fromCatalog: true,
    });
  }

  if (byTier.size > 0) return TIERS.flatMap((tier) => (byTier.has(tier) ? [byTier.get(tier)!] : []));

  return TIERS
    .filter((tier) => tier !== "long" || allowLong)
    .map((tier) => ({
      id: tiers[tier],
      tier,
      description: `${tiers[tier]}; Tier: ${tier}`,
      supportedEfforts: [],
      fromCatalog: false,
    }));
}

/** Merge newly seen catalog entries into the model metadata map used for capability checks. */
export function mergeCatalogModels(
  target: Map<string, ModelCandidate>,
  payload: unknown,
  tiers: TierModels,
  allowLong: boolean,
): ModelCandidate[] {
  const candidates = candidatesFromCatalog(payload, tiers, allowLong);
  for (const candidate of candidates) target.set(candidate.id, candidate);
  return candidates;
}
