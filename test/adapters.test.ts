import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasValidUsage, normalizeRateLimits } from "../src/app-server.js";
import { aggregateLocalUsage, buildCcusageArgs, resolveCcusageLauncher } from "../src/local.js";
import { allocateCredits, makeViewModel } from "../src/credit.js";

test("rate limits prefer the codex limit and reject incomplete values", () => {
  assert.deepEqual(normalizeRateLimits({
    rateLimitsByLimitId: { codex: { individualLimit: { limit: "500.00", used: "12.50", remainingPercent: 97.5, resetsAt: 1785542400 } } },
    rateLimits: { individualLimit: { limit: "1.00", used: "1.00", remainingPercent: 0, resetsAt: 1 } }
  }), { limit: "500.00", used: "12.50", remaining: "487.50", remainingPercent: 97.5, resetsAt: "2026-08-01T00:00:00.000Z" });
  assert.equal(normalizeRateLimits({ rateLimits: { limit: 500, used: 12.5, remainingPercent: 97.5, resetsAt: "2026-08-01T00:00:00Z" } }), undefined);
});

test("local aggregation retains only named model totals and generic skip counts", () => {
  const result = aggregateLocalUsage({
    sessions: [{
      directory: "privacy-canary-directory",
      sessionFile: "privacy-canary-session-file",
      sessionId: "privacy-canary-session-id",
      prompt: "privacy-canary-prompt",
      models: {
        "gpt-5.6-terra": { inputTokens: 10, cachedInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 16 },
        mystery: { inputTokens: 99, totalTokens: 99 }
      }
    }]
  });
  assert.deepEqual(result, { models: [{ model: "gpt-5.6-terra", tokens: 16 }], skippedEntries: 1 });
  assert.doesNotMatch(JSON.stringify(result), /privacy-canary|mystery/);
});

test("local usage invokes project-local ccusage for Codex sessions offline", () => {
  assert.deepEqual(buildCcusageArgs({ since: "2026-07-01", until: "2026-07-30", timezone: "UTC" }), [
    "codex", "session", "--json", "--offline", "--since", "2026-07-01", "--until", "2026-07-30"
  ]);
  assert.throws(() => buildCcusageArgs({ since: "2026-07-01T00:00:00.000Z", until: "2026-07-30", timezone: "UTC" }));
  assert.match(resolveCcusageLauncher() ?? "", /node_modules\/ccusage\/src\/cli\.js$/);
});

test("ccusage launcher resolution stays inside the installed package", () => {
  const root = mkdtempSync(join(tmpdir(), "ccusage-launcher-"));
  const packageDirectory = join(root, "node_modules", "ccusage");
  try {
    mkdirSync(join(packageDirectory, "src"), { recursive: true });
    writeFileSync(join(packageDirectory, "src", "cli.js"), "");
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ bin: { ccusage: "./src/cli.js" } }));
    assert.equal(resolveCcusageLauncher(root), realpathSync(join(packageDirectory, "src", "cli.js")));
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ bin: { ccusage: "../../outside.js" } }));
    writeFileSync(join(root, "outside.js"), "");
    assert.equal(resolveCcusageLauncher(root), undefined);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("usage requires the exact summary and dailyUsageBuckets token shape", () => {
  const summary = { lifetimeTokens: 1, peakDailyTokens: 1, longestRunningTurnSec: 1, currentStreakDays: 1, longestStreakDays: 1 };
  assert.equal(hasValidUsage({ summary, dailyUsageBuckets: [{ startDate: "2026-07-30", tokens: 3 }] }), true);
  assert.equal(hasValidUsage({ summary: { inputTokens: 1 }, dailyUsageBuckets: [{ startDate: "2026-07-30", tokens: 3 }] }), false);
  assert.equal(hasValidUsage({ summary, dailyUsageBuckets: [{ inputTokens: 3 }] }), false);
  assert.equal(hasValidUsage({ summary, daily: [{ startDate: "2026-07-30", tokens: 3 }] }), false);
  assert.equal(hasValidUsage({ summary, buckets: [{ startDate: "2026-07-30", tokens: 3 }] }), false);
});

test("estimated rows use deterministic largest remainder and sum to the integer official credit", () => {
  const allocation = allocateCredits("1.00", [
    { model: "gpt-5.6-sol", tokens: 1 },
    { model: "gpt-5.6-terra", tokens: 1 },
    { model: "gpt-5.6", tokens: 1 }
  ]);
  assert.deepEqual(allocation, [
    { model: "gpt-5.6-sol", credits: "1", share: 1 / 3 },
    { model: "gpt-5.6-terra", credits: "0", share: 1 / 3 },
    { model: "gpt-5.6", credits: "0", share: 1 / 3 }
  ]);
  assert.equal(allocation.reduce((total, row) => total + BigInt(row.credits), 0n), 1n);
});

test("the public view model rounds every credit value to an integer before export or rendering", () => {
  const view = makeViewModel({
    rateLimit: { limit: "500.49", used: "12.50", remaining: "487.99", remainingPercent: 97.5, resetsAt: "2026-08-01T00:00:00.000Z" },
    usageAvailable: true
  }, {
    models: [{ model: "gpt-5.6-sol", tokens: 2 }, { model: "gpt-5.6-terra", tokens: 1 }],
    skippedEntries: 0
  }, { since: "2026-07-16", until: "2026-07-30", timezone: "UTC" });
  assert.deepEqual(view.officialCredit, {
    status: "available", limit: "500", used: "13", remaining: "487", remainingPercent: 97.5, resetsAt: "2026-08-01T00:00:00.000Z"
  });
  assert.deepEqual(view.estimatedCreditAttribution, [
    { model: "gpt-5.6-sol", credits: "9", share: 2 / 3 },
    { model: "gpt-5.6-terra", credits: "4", share: 1 / 3 }
  ]);
});

test("availability diagnostics are preserved for the dashboard and API", () => {
  const view = makeViewModel({
    usageAvailable: false,
    diagnostic: { source: "official", code: "read-timeout", message: "Official Credit did not respond within 8 seconds.", remediation: "Restart or update Codex, then retry." }
  }, {
    models: [],
    skippedEntries: 0,
    diagnostic: { source: "local", code: "codex-missing", message: "Local session usage could not start because Codex was not found.", remediation: "Install or repair the Codex CLI, then run npm run setup." }
  }, { since: "2026-08-01", until: "2026-08-01", timezone: "UTC" });
  assert.equal(view.attributionQuality.message, "Official Credit did not respond within 8 seconds.");
  assert.deepEqual(view.diagnostics.map(({ source, code }) => ({ source, code })), [
    { source: "official", code: "read-timeout" },
    { source: "local", code: "codex-missing" }
  ]);
});
