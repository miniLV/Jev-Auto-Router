import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCallRecord,
  buildTaskRecord,
  compass,
  type CallRecord,
  type CallRecordInput,
} from "../src/receipt.js";
import { UNKNOWN } from "../src/types.js";

const PRICES = {
  "gpt-5.6-luna": { input: 0.25, output: 1.25 },
  "gpt-5.6-terra": { input: 1.25, output: 5 },
  "gpt-5.6-sol": { input: 5, output: 20 },
};

function call(partial: Partial<CallRecordInput> = {}): CallRecord {
  return buildCallRecord({
    task_id: "t1",
    call_index: 0,
    step_type: "tool_step",
    mode: "active",
    eligiblePairs: ["p1"],
    selectedPair: { model: "gpt-5.6-luna", effort: "max" },
    route_source: "jev",
    model_latency_ms: 100,
    call_status: "ok",
    observed: {
      actual_model: "gpt-5.6-luna",
      actual_effort: "max",
      observation: "requested_match",
      usage: {
        input_tokens: 4000,
        cached_input_tokens: 3000,
        cache_write_input_tokens: 0,
        output_tokens: 200,
        reasoning_tokens: 0,
      },
    },
    ...partial,
  });
}

test("call record separates Jev selection from fixed fallback and bypass", () => {
  const jev = call({ route_source: "jev", mode: "active" });
  assert.equal(jev.route_source, "jev");
  assert.equal(jev.fallback_reason, undefined);
  const fallback = call({ route_source: "fallback", fallback_reason: "low_confidence", selectedPair: { model: "gpt-5.6-terra", effort: "medium" } });
  assert.equal(fallback.route_source, "fallback");
  assert.equal(fallback.fallback_reason, "low_confidence");
  const bypass = call({ route_source: "bypass", mode: "bypass", fallback_reason: "privacy_refusal" });
  assert.equal(bypass.route_source, "bypass");
});

test("UNKNOWN usage is never coerced to zero anywhere in the aggregates", () => {
  const records = [
    call(),
    call({ task_id: "t1", call_index: 1, model_latency_ms: 200, observed: undefined }),
    call({
      task_id: "t1", call_index: 2, model_latency_ms: 50,
      selectedPair: { model: "gpt-6-astra", effort: "high" },
      route_source: "jev",
      observed: {
        actual_model: "gpt-6-astra",
        actual_effort: "high",
        observation: "requested_match",
        usage: {
          input_tokens: UNKNOWN,
          cached_input_tokens: UNKNOWN,
          cache_write_input_tokens: UNKNOWN,
          output_tokens: UNKNOWN,
          reasoning_tokens: UNKNOWN,
        },
      },
    }),
  ];
  const tasks = [
    { task_id: "t1", verification: "PASS" as const, evidence_refs: [], first_pass: true, correction_cycles: 0, root_takeover: false, critical_failure: false },
  ];
  const { metrics, diagnostics } = compass(records, tasks, PRICES);
  assert.equal(metrics.actual_weighted_cost_per_task, "UNKNOWN");
  assert.equal(metrics.frontier_tokens_per_task, "UNKNOWN");
  assert.equal(diagnostics.cache_hit_ratio, "UNKNOWN");
  assert.equal(metrics.jev_cost_share, "UNKNOWN");
});

test("observed costs aggregate honestly when usage exists", () => {
  const records = [call()];
  const tasks = [
    { task_id: "t1", verification: "PASS" as const, evidence_refs: [], first_pass: true, correction_cycles: 0, root_takeover: false, critical_failure: false },
  ];
  const { metrics } = compass(records, tasks, PRICES);
  const expected = (4000 / 1e6) * 0.25 + (200 / 1e6) * 1.25;
  assert.equal(metrics.actual_weighted_cost_per_task, expected);
  assert.equal(metrics.final_completion_rate, 1);
  assert.equal(metrics.first_pass_rate, 1);
  assert.equal(metrics.actual_model_switches_per_task, 0);
});

test("switches, takeover and cache diagnostics derive from records", () => {
  const records = [
    call({ task_id: "t2", call_index: 0, route_source: "jev" }),
    call({ task_id: "t2", call_index: 1, route_source: "fallback", selectedPair: { model: "gpt-5.6-terra", effort: "medium" },
      observed: {
        actual_model: "gpt-5.6-terra",
        actual_effort: "medium",
        observation: "requested_match",
        usage: { input_tokens: 2000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_tokens: 0 },
      } }),
  ];
  const tasks = [
    { task_id: "t2", verification: "PASS" as const, evidence_refs: [], first_pass: false, correction_cycles: 1, root_takeover: true, critical_failure: true },
  ];
  const { metrics, diagnostics } = compass(records, tasks, PRICES);
  assert.equal(metrics.actual_model_switches_per_task, 1);
  assert.equal(metrics.root_takeover_rate, 1);
  assert.equal(metrics.critical_failure_rate, 1);
  assert.deepEqual(diagnostics.tier_call_share, { luna_max: 1, terra: 1 });
  assert.deepEqual(diagnostics.correction_cycles, [1]);
  assert.equal(diagnostics.gpt6_usage_rate, 0);
});

test("empty population yields UNKNOWN rates, never zeros claimed as measurements", () => {
  const { metrics } = compass([], [], PRICES);
  assert.equal(metrics.final_completion_rate, "UNKNOWN");
  assert.equal(metrics.actual_weighted_cost_per_task, "UNKNOWN");
  assert.equal(metrics.actual_model_switches_per_task, "UNKNOWN");
});

test("task record carries verification, evidence and takeover", () => {
  const record = buildTaskRecord(
    { task_id: "t", status: "taken_over", correction_cycles: 2, seen_defect_ids: [], takeover: "correction_cycles_exhausted" },
    { verification: "FAIL", failing: [], evidence_refs: ["r1"] },
    false,
  );
  assert.equal(record.verification, "FAIL");
  assert.equal(record.root_takeover, true);
  assert.equal(record.critical_failure, true);
  assert.equal(record.correction_cycles, 2);
});
