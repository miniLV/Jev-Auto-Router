import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvedVersionChanged,
  shadowOutcome,
  trackResolvedVersion,
} from "../src/observation.js";

test("shadow logs the would-be route while execution uses the baseline", () => {
  const outcome = shadowOutcome({ model: "gpt-5.6-luna", effort: "max" }, { model: "gpt-5.6-terra", effort: "medium" });
  assert.deepEqual(outcome.executes, { model: "gpt-5.6-terra", effort: "medium" });
  assert.deepEqual(outcome.would_be, { model: "gpt-5.6-luna", effort: "max" });
});

test("shadow of a failed decision executes the baseline with no would-be route", () => {
  const outcome = shadowOutcome(undefined, { model: "gpt-5.6-terra", effort: "medium" });
  assert.equal(outcome.would_be, undefined);
});

test("active latest-alias drift demotes to shadow/baseline until validated", () => {
  assert.equal(resolvedVersionChanged("jev-latest", "jev-2.0", "jev-1.13.0"), true);
  assert.equal(resolvedVersionChanged("jev-latest", "UNKNOWN", "jev-1.13.0"), false);
  assert.equal(resolvedVersionChanged("jev-1.13.0", "jev-1.13.0", "jev-1.13.0"), false);
  assert.equal(resolvedVersionChanged("jev-latest", "jev-2.0", "UNKNOWN"), false);
});

test("tracking keeps the demotion once a drift is seen", () => {
  const policy = { jevVersion: "jev-latest", confidenceFloor: 0.5, deadlineMs: 1000 };
  const first = trackResolvedVersion({ lastResolved: "UNKNOWN", demoted: false }, policy, "jev-2.0");
  assert.equal(first.demoted, false);
  const drift = trackResolvedVersion(first, policy, "jev-2.1");
  assert.equal(drift.demoted, true);
  assert.deepEqual(drift, trackResolvedVersion(drift, policy, "jev-2.1"));
});
