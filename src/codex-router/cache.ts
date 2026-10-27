import type { PriceTable } from "./types.js";

export interface DowngradeInput {
  prefixTokens: number;
  currentModel: string;
  targetModel: string;
  prices?: PriceTable;
  /** false means the last response reported no cache read; switching is cheap. */
  cacheWarm?: boolean;
  remainingTurns: number;
  outputTokensPerTurn: number;
}

export interface DowngradeDecision {
  allowed: boolean;
  reason: "cache-cold" | "cache-break-even" | "downgrade-not-worth-cache-rebuild";
  rebuildCost?: number;
  savingPerTurn?: number;
  breakEvenTurns?: number;
}

const MILLION = 1_000_000;

/**
 * Compare the cost of rebuilding the target model's prefix with the estimated
 * per-turn saving. This is intentionally small and pure: prices are caller
 * supplied, and missing prices fall back to the context threshold.
 */
export function evaluateDowngrade(input: DowngradeInput): DowngradeDecision | undefined {
  if (!input.prices) {
    return input.cacheWarm === false ? { allowed: true, reason: "cache-cold" } : undefined;
  }

  const current = input.prices[input.currentModel];
  const target = input.prices[input.targetModel];
  if (!current || !target) return undefined;

  const prefix = Math.max(0, input.prefixTokens);
  const output = Math.max(0, input.outputTokensPerTurn);
  const remainingTurns = Math.max(1, input.remainingTurns);
  const rebuildCost = (prefix / MILLION) * target.cacheWriteInput;
  const currentTurnCost = (prefix / MILLION) * current.cachedInput + (output / MILLION) * current.output;
  const targetTurnCost = (prefix / MILLION) * target.cachedInput + (output / MILLION) * target.output;
  const savingPerTurn = currentTurnCost - targetTurnCost;

  if (savingPerTurn <= 0) {
    return {
      allowed: false,
      reason: "downgrade-not-worth-cache-rebuild",
      rebuildCost,
      savingPerTurn,
      breakEvenTurns: Infinity,
    };
  }

  if (input.cacheWarm === false) {
    return {
      allowed: true,
      reason: "cache-cold",
      rebuildCost,
      savingPerTurn,
      breakEvenTurns: 0,
    };
  }

  const breakEvenTurns = rebuildCost / savingPerTurn;
  return {
    allowed: breakEvenTurns <= remainingTurns,
    reason: breakEvenTurns <= remainingTurns ? "cache-break-even" : "downgrade-not-worth-cache-rebuild",
    rebuildCost,
    savingPerTurn,
    breakEvenTurns,
  };
}

/** The effective hard lock: a task budget can lock earlier than the session cap. */
export function effectiveTurnLock(config: {
  lockAfterTurns: number;
  taskTurnBudget: number;
  lockBeforeEndTurns: number;
}): number {
  const sessionLock = config.lockAfterTurns > 0 ? config.lockAfterTurns : Number.POSITIVE_INFINITY;
  const taskLock = config.taskTurnBudget > 0
    ? Math.max(1, config.taskTurnBudget - config.lockBeforeEndTurns)
    : Number.POSITIVE_INFINITY;
  const lock = Math.min(sessionLock, taskLock);
  return Number.isFinite(lock) ? lock : 0;
}

/** Remaining turns used by the break-even estimate. */
export function remainingTurns(config: {
  taskTurnBudget: number;
  assumedRemainingTurns: number;
}, turns: number): number {
  if (config.taskTurnBudget > 0) return Math.max(1, config.taskTurnBudget - turns);
  return Math.max(1, config.assumedRemainingTurns);
}
