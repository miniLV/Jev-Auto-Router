import assert from "node:assert/strict";
import test from "node:test";
import {
  choose,
  DEFAULT_JEV_POLICY,
  JevTimeoutError,
  type JevTransportRequest,
} from "../src/jev-adapter.js";
import { buildCandidateSet } from "../src/catalog.js";
import { buildRoutingState } from "../src/route-plan.js";
import { choosingTransport, RecordingTransport, testCatalog } from "./routing-fixtures.js";

function state() {
  return buildRoutingState({ task_id: "t", call_index: 0, step_type: "tool_step" }).state;
}

function pairIds(): string[] {
  return buildCandidateSet(testCatalog()).pairs.map(p => p.pair_id);
}

test("one Choice over pair IDs: exact lookup, valid pair executes", async () => {
  const ids = pairIds();
  const transport = new RecordingTransport(async () => ({ choice: ids[3], confidence: 0.9, model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 2 } }));
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, transport.transport);
  assert.equal(decision.valid, true);
  assert.equal(decision.chosen_pair_id, ids[3]);
  assert.equal(transport.requests.length, 1);
  const request: JevTransportRequest = transport.requests[0];
  assert.equal(request.model, "jev-1.13.0");
  assert.equal(request.question.type, "Choice");
  assert.deepEqual(request.question.options, ids);
});

test("unknown pair ID is malformed and never patched locally", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, choosingTransport("not-a-pair"));
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "malformed");
});

test("low confidence falls to floor, retaining the selection evidence", async () => {
  const ids = pairIds();
  const decision = await choose(state(), buildCandidateSet(testCatalog()), { ...DEFAULT_JEV_POLICY, confidenceFloor: 0.9 },
    choosingTransport(ids[0], 0.4));
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "floor");
  assert.equal(decision.chosen_pair_id, ids[0]);
  assert.equal(decision.confidence, 0.4);
});

test("version drift is terminal: resolved differs from pinned requested", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY,
    choosingTransport(pairIds()[0], 0.9, "jev-next"));
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "malformed");
});

test("transport failure retries once within the deadline, then reports transport", async () => {
  let calls = 0;
  const decision = await choose(state(), buildCandidateSet(testCatalog()), { ...DEFAULT_JEV_POLICY, deadlineMs: 500 }, async () => {
    calls += 1;
    throw new Error("network reset");
  });
  assert.equal(calls, 2);
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "transport");
});

test("auth failure is terminal without retry", async () => {
  let calls = 0;
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, async () => {
    calls += 1;
    throw new Error("auth: 401");
  });
  assert.equal(calls, 1);
  assert.equal(decision.failure_reason, "transport");
  assert.equal(decision.failure_subreason, "auth");
});

test("deadline exceeded reports timeout, never claims zero usage", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), { ...DEFAULT_JEV_POLICY, deadlineMs: 50 }, async () => {
    throw new JevTimeoutError();
  });
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "timeout");
  assert.equal(decision.jev_usage.input_tokens, "UNKNOWN");
});

test("empty candidate set is malformed before any HTTP", async () => {
  const transport = new RecordingTransport(async () => ({ choice: "x", confidence: 1 }));
  const decision = await choose(state(), buildCandidateSet(testCatalog(), { forcedModel: "nope" }), DEFAULT_JEV_POLICY, transport.transport);
  assert.equal(decision.valid, false);
  assert.equal(transport.requests.length, 0);
});

test("invalid confidence is malformed, not resampled", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY,
    choosingTransport(pairIds()[0], Number.NaN));
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "malformed");
});
