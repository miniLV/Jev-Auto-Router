import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCallRecord,
  buildTaskRecord,
  compass,
  type CallRecord,
  type CallRecordInput,
} from "../src/receipt.js";
import type { JevDecision } from "../src/route-plan.js";
import { UNKNOWN } from "../src/types.js";

const PRICES = {
  "gpt-6-luna": { input: 0.25, output: 1.25 },
  "gpt-6-sol": { input: 1.25, output: 5 },
  "gpt-6-astra": { input: 5, output: 20 },
};

function call(partial: Partial<CallRecordInput> = {}): CallRecord {
  return buildCallRecord({
    task_id: "t1",
    call_index: 0,
    step_type: "tool_step",
    entry: "auto",
    mode: "active",
    eligiblePairs: ["p1"],
    proposedPair: { model: "gpt-6-luna", effort: "max" },
    appliedPair: { model: "gpt-6-luna", effort: "max" },
    originalModel: "jev/auto",
    route_source: "jev",
    model_latency_ms: 100,
    call_status: "ok",
    observed: {
      actual_model: "gpt-6-luna",
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
  assert.equal(jev.reason, undefined);
  const fallback = call({ route_source: "fallback", reason: "low_confidence", appliedPair: { model: "gpt-6-sol", effort: "medium" } });
  assert.equal(fallback.route_source, "fallback");
  assert.equal(fallback.reason, "low_confidence");
  const bypass = call({ entry: "manual", route_source: "bypass", mode: "bypass", reason: "manual_model" });
  assert.equal(bypass.route_source, "bypass");
  assert.equal(bypass.entry, "manual");
});

test("proposed, applied and observed stay independent; nothing backfills", () => {
  const record = call({
    proposedPair: { model: "gpt-6-luna", effort: "max" },
    appliedPair: { model: "gpt-6-sol", effort: "medium" },
    observed: undefined,
  });
  assert.equal(record.proposed_model, "gpt-6-luna");
  assert.equal(record.applied_model, "gpt-6-sol");
  assert.equal(record.observed_model, UNKNOWN);
  assert.equal(record.observed_effort, UNKNOWN);
  assert.equal(record.observation, "pending");
  assert.equal(record.model_input_tokens, UNKNOWN);
});

test("a cancelled call without an upstream request keeps applied UNKNOWN", () => {
  const record = call({
    proposedPair: undefined,
    appliedPair: undefined,
    observed: undefined,
    route_source: "fallback",
    call_status: "cancelled",
  });
  assert.equal(record.applied_model, UNKNOWN);
  assert.equal(record.observed_model, UNKNOWN);
  assert.equal(record.jev_choice_result, undefined);
  assert.equal(record.jev_failure_subreason, undefined);
});

test("Choice outcome and failure subreason are bounded and independent of route reason", () => {
  const decision: JevDecision = {
    decision_id: "d1",
    candidate_set_digest: "c1",
    jev_requested_version: "jev-1.13.0",
    jev_resolved_version: "UNKNOWN",
    question_schema_version: "choice-pairs/2",
    valid: false,
    failure_reason: "transport",
    failure_subreason: "credential=secret-from-error",
    jev_latency_ms: 5,
    jev_usage: { input_tokens: UNKNOWN, output_tokens: UNKNOWN },
  };
  const record = call({ decision, route_source: "fallback", reason: "shadow_mode" });
  assert.equal(record.reason, "shadow_mode");
  assert.equal(record.jev_choice_result, "jev_failure");
  assert.equal(record.jev_failure_subreason, "other");
  assert.ok(!JSON.stringify(record).includes("secret-from-error"));
});

test("an alias Choice remains diagnostic and is not recorded as version-qualified", () => {
  const decision: JevDecision = {
    decision_id: "d2",
    candidate_set_digest: "c1",
    jev_requested_version: "jev-latest",
    jev_resolved_version: "jev-1.14.0",
    question_schema_version: "choice-pairs/2",
    chosen_pair_id: "p1",
    confidence: 0.9,
    valid: true,
    jev_latency_ms: 5,
    jev_usage: { input_tokens: 1, output_tokens: 1 },
  };
  const record = call({
    decision,
    route_source: "fallback",
    reason: "shadow_mode",
    guardVerdict: "deny",
    guardReason: "VERSION_DRIFT",
  });
  assert.equal(record.jev_choice_result, "jev_version_mismatch");
  assert.equal(record.jev_failure_subreason, "version_unpinned");
  assert.equal(record.guard_verdict, "deny");
  assert.equal(record.guard_reason, "VERSION_DRIFT");
});

test("UNKNOWN usage is never coerced to zero anywhere in the aggregates", () => {
  const records = [
    call(),
    call({ task_id: "t1", call_index: 1, model_latency_ms: 200, observed: undefined }),
    call({
      task_id: "t1", call_index: 2, model_latency_ms: 50,
      proposedPair: { model: "gpt-6-astra", effort: "high" },
      appliedPair: { model: "gpt-6-astra", effort: "high" },
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

test("switches, takeover and cache diagnostics derive from observed records only", () => {
  const records = [
    call({ task_id: "t2", call_index: 0, route_source: "jev" }),
    call({
      task_id: "t2", call_index: 1, route_source: "fallback", reason: "low_confidence",
      proposedPair: { model: "gpt-6-luna", effort: "max" },
      appliedPair: { model: "gpt-6-sol", effort: "medium" },
      observed: {
        actual_model: "gpt-6-sol",
        actual_effort: "medium",
        observation: "requested_match",
        usage: { input_tokens: 2000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_tokens: 0 },
      },
    }),
    call({ task_id: "t2", call_index: 2, observed: undefined, appliedPair: { model: "gpt-6-sol", effort: "medium" } }),
  ];
  const tasks = [
    { task_id: "t2", verification: "PASS" as const, evidence_refs: [], first_pass: false, correction_cycles: 1, root_takeover: true, critical_failure: true },
  ];
  const { metrics, diagnostics } = compass(records, tasks, PRICES);
  assert.equal(metrics.actual_model_switches_per_task, 1);
  assert.equal(metrics.root_takeover_rate, 1);
  assert.equal(metrics.critical_failure_rate, 1);
  assert.deepEqual(diagnostics.tier_call_share, { luna_max: 1, sol: 1, unknown: 1 });
  assert.deepEqual(diagnostics.correction_cycles, [1]);
  assert.equal(diagnostics.astra_usage_rate, 0);
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
