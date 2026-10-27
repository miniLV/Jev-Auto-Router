/** The virtual model Codex selects to opt into turn-level routing. */
export const AUTO_MODEL = "jev-auto";

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
  /** Provider advertises cache-preserving mid-conversation reasoning updates. */
  supportsEffortUpdates: boolean;
  fromCatalog: boolean;
}

export interface ModelPrice {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface CacheObservation {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  at: number;
  warm: boolean;
}

export interface EffortUpdate {
  anchorIndex: number;
  anchorSignature: string;
  effort: string;
}

export interface SessionState {
  tier: Tier;
  model: string;
  updatedAt: number;
  turns: number;
  switches: number;
  turnsSinceSwitch: number;
  lastPromptHash?: string;
  lastContextTokens?: number;
  cache?: CacheObservation;
  lastFailureAt?: number;
  effortModel?: string;
  effortBaseline?: string;
  effortUpdates?: EffortUpdate[];
}

export type UpgradeMode = "always" | "triggered";

export interface RouterConfig {
  tiers: TierModels;
  allowLong: boolean;
  minConfidence: number;
  uncertainCeiling: Tier;
  downgradeMaxContextTokens: number;
  lockAfterTurns: number;
  maxSwitchesPerSession: number;
  switchCooldownTurns: number;
  cacheTtlMs: number;
  contextWindowTokens: number;
  prices?: PriceTable;
  assumedRemainingTurns: number;
  taskTurnBudget: number;
  lockBeforeEndTurns: number;
  outputTokensPerTurn: number;
  effortRouting: "off" | "turn";
  effortCap: string;
  effortFallback: string;
  upgradeMode: UpgradeMode;
  upgradeComplexityThreshold: number;
  upgradeFailureTtlMs: number;
  stripEncryptedReasoning: boolean;
  sessionTtlMs: number;
  sessionFile?: string;
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
