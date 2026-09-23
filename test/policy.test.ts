import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesProxy } from "../src/proxy.js";
import { buildCandidateSet } from "../src/catalog.js";
import { validate } from "../src/policy-guard.js";
import type { JevDecision } from "../src/route-plan.js";
import { pairIdOf } from "./routing-fixtures.js";
import {
  RecordingTransport,
  RecordingUpstream,
  routerConfig,
  sampleRequest,
  testCatalog,
  tierChoice,
} from "./routing-fixtures.js";

/**
 * Routing-policy invariants through the proxy pipeline: no task-kind table
 * anywhere (the same step classifies identically regardless of content),
 * fallback never escalates to Astra, and nothing but Jev selects.
 */

test("no task-kind table: candidate construction ignores task shape", () => {
  const catalog = testCatalog();
  const a = buildCandidateSet(catalog);
  const b = buildCandidateSet(testCatalog());
  assert.deepEqual(a.pairs.map(p => p.pair_id), b.pairs.map(p => p.pair_id));
  // Different catalog tiers produce different sets; task content never does.
});

test("the current model reaches Jev only to judge whether switching pays", async () => {
  const transport = new RecordingTransport(async request => {
    const context = request.state;
    assert.equal(context.current_model, "gpt-6-luna");
    return { choice: Object.keys(request.questions.route.criteria)[0], confidence: 0.9, model: "jev-1.13.0", usage: {} };
  });
  const p = new ResponsesProxy(routerConfig({ mode: "active" }), testCatalog(), transport.transport, new RecordingUpstream().upstream);
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-luna" });
});

test("failure never escalates: every failure route is the baseline", async () => {
  for (const jev of [
    tierChoice("sol", 0.01), // low confidence
    (async () => { throw new Error("network reset"); }), // transport
  ]) {
    const p = new ResponsesProxy(routerConfig({ mode: "active", baseline: { model: "gpt-6-sol", effort: "medium" } }), testCatalog(), jev, new RecordingUpstream().upstream);
    const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
    assert.equal(forwardRequest.model, "gpt-6-sol");
    assert.equal(record.route_source, "fallback");
    assert.notEqual(forwardRequest.model, "gpt-6-astra");
  }
});

test("no second selector: the exact Jev pair executes, unmodified", async () => {
  const catalog = testCatalog();
  const terra = buildCandidateSet(catalog).pairs.filter(p => p.tier === "sol");
  const want = terra[terra.length - 1];
  const p = new ResponsesProxy(routerConfig({ mode: "active" }), catalog,
    (async () => ({ choice: want.pair_id, confidence: 0.99, model: "jev-1.13.0", usage: {} })),
    new RecordingUpstream().upstream);
  const { forwardRequest } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  assert.equal(forwardRequest.model, want.model);
  assert.equal(forwardRequest.reasoning?.effort, want.effort);
});

// ---------------------------------------------------------------------------
// Guard: deterministic validation, never a second choice.
// ---------------------------------------------------------------------------

function decisionOf(partial: Partial<JevDecision>): JevDecision {
  return {
    decision_id: "d",
    candidate_set_digest: "set",
    jev_requested_version: "jev-1.13.0",
    jev_resolved_version: "jev-1.13.0",
    question_schema_version: "choice-pairs/2",
    valid: true,
    chosen_pair_id: pairIdOf("gpt-6-luna", "medium"),
    confidence: 0.9,
    jev_latency_ms: 5,
    jev_usage: { input_tokens: 10, output_tokens: 2 },
    ...partial,
  };
}

test("guard allows an exact member with valid shape and confidence", () => {
  const set = buildCandidateSet(testCatalog());
  const verdict = validate(decisionOf({ chosen_pair_id: pairIdOf("gpt-6-luna", "medium"), confidence: 0.9 }), set, {});
  assert.deepEqual(verdict, { verdict: "ALLOW", pair_id: pairIdOf("gpt-6-luna", "medium") });
});

test("guard denies invalid decisions, missing members and schema breaks", () => {
  const set = buildCandidateSet(testCatalog());
  assert.deepEqual(validate(decisionOf({ valid: false }), set, {}), { verdict: "DENY", reason: "INVALID_DECISION" });
  assert.deepEqual(validate(decisionOf({ chosen_pair_id: "nope" }), set, {}), { verdict: "DENY", reason: "INVALID_DECISION" });
  assert.deepEqual(validate(decisionOf({ confidence: Number.NaN }), set, {}), { verdict: "DENY", reason: "LOW_CONFIDENCE" });
  assert.deepEqual(
    validate(decisionOf({ jev_resolved_version: "jev-other" }), set, {}),
    { verdict: "DENY", reason: "VERSION_DRIFT" },
  );
});

test("guard enforces hard constraints and Astra admission", () => {
  const set = buildCandidateSet(testCatalog(), { astraAdmitted: true });
  const terra = pairIdOf("gpt-6-sol", "medium");
  assert.deepEqual(
    validate(decisionOf({ chosen_pair_id: terra }), set, { forcedModel: "gpt-6-luna" }),
    { verdict: "DENY", reason: "HARD_CONSTRAINT" },
  );
  assert.deepEqual(
    validate(decisionOf({ chosen_pair_id: pairIdOf("gpt-6-astra", "medium") }), set, {}),
    { verdict: "DENY", reason: "ASTRA_NOT_ADMITTED" },
  );
});

test("guard is defense in depth for the privacy boundary", () => {
  const set = buildCandidateSet(testCatalog());
  assert.deepEqual(
    validate(decisionOf({ chosen_pair_id: pairIdOf("gpt-6-luna", "medium") }), set, {}, true),
    { verdict: "DENY", reason: "PRIVACY_REFUSAL" },
  );
});
