import test from "node:test";
import assert from "node:assert/strict";
import { effectiveTurnLock, evaluateDowngrade, remainingTurns } from "../src/codex-router/cache.js";
import type { PriceTable } from "../src/codex-router/types.js";

const prices: PriceTable = {
  "strong-model": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 20 },
  "fast-model": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 4 },
};

const base = {
  prefixTokens: 100_000,
  currentModel: "strong-model",
  targetModel: "fast-model",
  prices,
  remainingTurns: 10,
  outputTokensPerTurn: 1_000,
};

test("allows a downgrade when the remaining turns clear the break-even", () => {
  const decision = evaluateDowngrade(base);
  assert.ok(decision);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "cache-break-even");
  assert.ok(decision.breakEvenTurns! < 10);
});

test("refuses a downgrade when only one turn remains", () => {
  const decision = evaluateDowngrade({ ...base, remainingTurns: 1 });
  assert.ok(decision);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "downgrade-not-worth-cache-rebuild");
});

test("a cold cache skips the rebuild calculation", () => {
  const decision = evaluateDowngrade({ ...base, cacheWarm: false, remainingTurns: 1 });
  assert.equal(decision?.allowed, true);
  assert.equal(decision?.reason, "cache-cold");
  assert.equal(decision?.breakEvenTurns, 0);
});

test("missing prices fall back to the caller", () => {
  assert.equal(evaluateDowngrade({ ...base, prices: undefined }), undefined);
});

test("dynamic lock prefers the earlier of session and task horizon", () => {
  assert.equal(effectiveTurnLock({ lockAfterTurns: 12, taskTurnBudget: 8, lockBeforeEndTurns: 2 }), 6);
  assert.equal(effectiveTurnLock({ lockAfterTurns: 0, taskTurnBudget: 8, lockBeforeEndTurns: 2 }), 6);
  assert.equal(effectiveTurnLock({ lockAfterTurns: 12, taskTurnBudget: 0, lockBeforeEndTurns: 2 }), 12);
  assert.equal(effectiveTurnLock({ lockAfterTurns: 0, taskTurnBudget: 0, lockBeforeEndTurns: 2 }), 0);
});

test("remaining turns uses the task budget when present", () => {
  assert.equal(remainingTurns({ taskTurnBudget: 10, assumedRemainingTurns: 3 }, 4), 6);
  assert.equal(remainingTurns({ taskTurnBudget: 0, assumedRemainingTurns: 3 }, 4), 3);
});
