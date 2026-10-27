/** The virtual model Codex selects to opt into turn-level routing. */
export const AUTO_MODEL = "jev-router";

/** Capability tiers. The names are policy labels; concrete model IDs are configuration. */
export const TIERS = ["fast", "balanced", "strong", "long"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_RANK: Record<Tier, number> = {
  fast: 0,
  balanced: 1,
  strong: 2,
  long: 3,
};

export interface TierModels {
  fast: string;
  balanced: string;
  strong: string;
  long: string;
}

export interface ModelCandidate {
  id: string;
  tier: Tier;
  description: string;
  supportedEfforts: string[];
  defaultEffort?: string;
  fromCatalog: boolean;
}

export interface RouterConfig {
  tiers: TierModels;
  allowLong: boolean;
  minConfidence: number;
  uncertainCeiling: Tier;
  downgradeMaxContextTokens: number;
  contextWindowTokens: number;
  jevModel: string;
  jevEndpoint: string;
  jevTimeoutMs: number;
  jevDeadlineMs: number;
  jevMaxRetries: number;
  apiKey?: string;
  defaultModel: string;
  autoModelDisplayName: string;
  chatgptBaseUrl: string;
  apiBaseUrl: string;
  commentary: boolean;
  logFile?: string;
  debug: boolean;
}

export interface JevScores {
  taskComplexity: number;
  reasoningRequired: number;
  toolComplexity: number;
  contextSize: number;
}

export interface JevAnswer {
  choice: string;
  confidence: number;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  scores?: JevScores;
}

export interface JevFailure {
  reason: string;
  detail?: string;
  latencyMs: number;
}

export type JevResult =
  | { answer: JevAnswer; failure?: undefined }
  | { answer?: undefined; failure: JevFailure };

export interface RouteInput {
  prompt: string;
  currentModel: string;
  currentTier: Tier;
  contextTokens: number;
  candidates: ModelCandidate[];
}
