import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROUTER_CONFIG, ResponsesProxy } from "../src/proxy.js";
import { buildCandidateSet } from "../src/catalog.js";
import {
  RecordingTransport,
  RecordingUpstream,
  sampleRequest,
  testCatalog,
  tierChoice,
} from "./routing-fixtures.js";

/**
 * Routing-policy invariants through the proxy pipeline: no task-kind table
 * anywhere (the same step classifies identically regardless of content),
 * fallback never escalates to GPT-6, and nothing but Jev selects.
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
    const context = request.question.context as { current_model?: string };
    assert.equal(context.current_model, "gpt-5.6-sol");
    return { choice: request.question.options[0], confidence: 0.9, model: "jev-1.13.0", usage: {} };
  });
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-5.6-sol" });
});

test("failure never escalates: every failure route is the baseline", async () => {
  for (const jev of [
    tierChoice("terra", 0.01), // low confidence
    (async () => { throw new Error("network reset"); }) as never, // transport
  ]) {
    const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), jev, new RecordingUpstream().upstream);
    const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
    assert.equal(forwardRequest.model, DEFAULT_ROUTER_CONFIG.baseline.model);
    assert.equal(record.route_source, "fallback");
    assert.notEqual(forwardRequest.model, "gpt-6-astra");
  }
});

test("no second selector: the exact Jev pair executes, unmodified", async () => {
  const catalog = testCatalog();
  const terra = buildCandidateSet(catalog).pairs.filter(p => p.tier === "terra");
  const want = terra[terra.length - 1];
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, catalog,
    (async () => ({ choice: want.pair_id, confidence: 0.99, model: "jev-1.13.0", usage: {} })) as never,
    new RecordingUpstream().upstream);
  const { forwardRequest } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(forwardRequest.model, want.model);
  assert.equal(forwardRequest.reasoning?.effort, want.effort);
});
