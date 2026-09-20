import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HARNESS_CONFIG } from "../bench/config.js";
import { REPLAY_LABEL, replayFixtures } from "../bench/fixtures.js";
import { controlledComparison, comparisonFixtures, replay } from "../bench/harness.js";

test("replay labels every output ESTIMATED/COUNTERFACTUAL and never coerces UNKNOWN", () => {
  const report = replay(DEFAULT_HARNESS_CONFIG);
  assert.equal(report.label, REPLAY_LABEL);
  assert.equal(report.label, "ESTIMATED/COUNTERFACTUAL");
  // The t1 tool call with UNKNOWN usage cannot be priced: the delta is UNKNOWN, not zero.
  assert.equal(report.unobserved_calls, 1);
  assert.equal(report.replay_cost, "UNKNOWN");
  assert.equal(report.delta, "UNKNOWN");
});

test("replay with fully observed traces prices both sides honestly", () => {
  const { calls } = replayFixtures();
  const observed = calls.filter(c => c.input_tokens !== "UNKNOWN");
  const report = replay(DEFAULT_HARNESS_CONFIG, observed);
  assert.ok(typeof report.observed_cost === "number");
  assert.ok(typeof report.replay_cost === "number");
  assert.equal(typeof report.delta, "number");
});

test("controlled comparison checks quality before cost", () => {
  const report = controlledComparison(DEFAULT_HARNESS_CONFIG, comparisonFixtures());
  assert.equal(report.quality_gate_passed, true);
  assert.equal(report.baseline_completion_rate, 1);
  assert.equal(report.policy_completion_rate, 1);
  assert.ok(report.economics);
  assert.ok(typeof report.economics?.policy_jev_cost === "number" || report.economics?.policy_jev_cost === "UNKNOWN");
});

test("a cheaper arm with worse completion is a loss, not a saving", () => {
  const tasks = comparisonFixtures();
  tasks[1].policy_pass = false;
  const report = controlledComparison(DEFAULT_HARNESS_CONFIG, tasks);
  assert.equal(report.quality_gate_passed, false);
  assert.equal(report.economics, undefined);
});

test("unpriced models and missing usage cannot improve either arm", () => {
  const tasks = comparisonFixtures();
  tasks[0].policy_calls[0].input_tokens = "UNKNOWN";
  const report = controlledComparison(DEFAULT_HARNESS_CONFIG, tasks);
  assert.equal(report.economics?.policy_cost, "UNKNOWN");
  assert.equal(report.economics?.delta, "UNKNOWN");
  assert.ok((report.economics?.unobserved_calls ?? 0) >= 1);
});
