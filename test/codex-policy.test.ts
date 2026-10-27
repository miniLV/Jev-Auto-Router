import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride, shouldUseExactModel } from "../src/codex-router/policy.js";
import type { RouterConfig, Tier } from "../src/codex-router/types.js";

const config: Pick<RouterConfig, "tiers" | "minConfidence" | "uncertainCeiling" | "downgradeMaxContextTokens" | "allowLong"> = {
  tiers: {
    fast: "gpt-6-luna",
    balanced: "gpt-6-sol",
    strong: "gpt-6.1-sol",
    long: "gpt-6-astra",
  },
  minConfidence: 0.3,
  uncertainCeiling: "balanced",
  downgradeMaxContextTokens: 20_000,
  allowLong: false,
};

const all: Tier[] = ["fast", "balanced", "strong", "long"];
const base = {
  prompt: "refactor the parser",
  current: "balanced" as Tier,
  available: all,
  contextTokens: 0,
  config,
};

const sure = (choice: Tier) => ({ choice, confidence: 0.95 });
const unsure = (choice: Tier) => ({ choice, confidence: 0.2 });

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("strong") }), {
    tier: "strong",
    reason: "jev",
    changed: true,
  });
});

test("explicit user override wins over Jev", () => {
  const result = decide({ ...base, prompt: "use luna to fix this typo", jev: sure("strong") });
  assert.equal(result.tier, "fast");
  assert.equal(result.reason, "override");
});

test("detectOverride only fires on an imperative request", () => {
  assert.equal(detectOverride("switch to opus", config.tiers), "strong");
  assert.equal(detectOverride("use luna", config.tiers), "fast");
  assert.equal(detectOverride("use gpt-6.1-sol", config.tiers), "strong");
  assert.equal(detectOverride("the sol of this problem", config.tiers), null);
});

test("keeps the current model when Jev is unavailable", () => {
  const result = decide({ ...base, jev: null });
  assert.equal(result.tier, "balanced");
  assert.equal(result.changed, false);
  assert.match(result.reason, /jev-unavailable/);
});

test("never downgrades on a low-confidence answer", () => {
  const result = decide({ ...base, current: "strong", jev: unsure("fast") });
  assert.equal(result.tier, "strong");
  assert.match(result.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the balanced tier", () => {
  const result = decide({ ...base, current: "fast", jev: unsure("long") });
  assert.equal(result.tier, "balanced");
  assert.match(result.reason, /low-confidence-capped/);
});

test("refuses a downgrade once the cache rebuild is too large", () => {
  const result = decide({ ...base, current: "strong", jev: sure("fast"), contextTokens: 80_000 });
  assert.equal(result.tier, "strong");
  assert.match(result.reason, /downgrade-not-worth-cache-rebuild/);
});

test("allows the same downgrade early in the conversation", () => {
  assert.equal(decide({ ...base, current: "strong", jev: sure("fast") }).tier, "fast");
});

test("steps up when the chosen tier is unavailable", () => {
  const result = decide({
    ...base,
    current: "fast",
    available: ["fast", "strong"],
    jev: sure("balanced"),
  });
  assert.equal(result.tier, "strong");
  assert.match(result.reason, /unavailable/);
});

test("does not use the long tier unless it is enabled", () => {
  const result = decide({
    ...base,
    current: "strong",
    available: ["fast", "balanced", "strong", "long"],
    jev: sure("long"),
  });
  assert.equal(result.tier, "strong");
});

test("accepts an exact model change only when the policy accepted Jev", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "strong", "strong"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "strong", "strong"), false);
});

test("blocks an upgrade when no trigger is present", () => {
  const result = decide({ ...base, current: "fast", jev: sure("strong"), allowUpgrade: false });
  assert.equal(result.tier, "fast");
  assert.match(result.reason, /upgrade-not-triggered/);
});

test("a price gate can refuse a downgrade before the context threshold", () => {
  const result = decide({
    ...base,
    current: "strong",
    jev: sure("fast"),
    contextTokens: 0,
    downgrade: { allowed: false, reason: "price-gate" },
  });
  assert.equal(result.tier, "strong");
  assert.match(result.reason, /price-gate/);
});

test("a price gate can allow a downgrade above the context threshold", () => {
  const result = decide({
    ...base,
    current: "strong",
    jev: sure("fast"),
    contextTokens: 500_000,
    downgrade: { allowed: true },
  });
  assert.equal(result.tier, "fast");
});
