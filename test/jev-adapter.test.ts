import assert from "node:assert/strict";
import test from "node:test";
import {
  choose,
  DEFAULT_JEV_POLICY,
  isPinnedJevVersion,
  JevTimeoutError,
  type JevTransportRequest,
} from "../src/jev-adapter.js";
import { buildCandidateSet } from "../src/catalog.js";
import { buildRoutingState } from "../src/route-plan.js";
import { fetchJevTransport } from "../src/index.js";
import { choosingTransport, RecordingTransport, testCatalog } from "./routing-fixtures.js";

function state() {
  return buildRoutingState({ step_type: "tool_step", known_model_ids: [] }).state;
}

function pairIds(): string[] {
  return buildCandidateSet(testCatalog()).pairs.map(p => p.pair_id);
}

test("only a concrete configured release can be pinned", () => {
  assert.equal(isPinnedJevVersion("jev-1.13.0"), true);
  assert.equal(isPinnedJevVersion("jev-latest"), false);
  assert.equal(isPinnedJevVersion("UNKNOWN"), false);
  assert.equal(isPinnedJevVersion(""), false);
});

test("one Choice over pair IDs: exact lookup, valid pair executes", async () => {
  const ids = pairIds();
  const transport = new RecordingTransport(async () => ({ choice: ids[3], confidence: 0.9, model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 2 } }));
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, transport.transport);
  assert.equal(decision.valid, true);
  assert.equal(decision.chosen_pair_id, ids[3]);
  assert.equal(transport.requests.length, 1);
  const request: JevTransportRequest = transport.requests[0];
  assert.equal(request.model, "jev-1.13.0");
  assert.equal(request.questions.route.type, "choice");
  assert.deepEqual(Object.keys(request.questions.route.criteria), ids);
  assert.equal(request.state.step_type, "tool_step");
});

test("HTTP transport decodes the official answers.route response", async () => {
  const originalFetch = globalThis.fetch;
  let posted: unknown;
  globalThis.fetch = async (_url, init) => {
    posted = JSON.parse(String(init?.body));
    return Response.json({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: pairIds()[0], confidence: 0.8 } },
      usage: { input_tokens: 400, output_tokens: 40 },
    });
  };
  try {
    const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY,
      fetchJevTransport("https://api.typesafe.ai/v1/systemone", "synthetic-key"));
    assert.equal(decision.valid, true);
    assert.deepEqual(decision.jev_usage, { input_tokens: 400, output_tokens: 40 });
    assert.ok(posted && typeof posted === "object" && "state" in posted && "questions" in posted);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown pair ID is malformed and never patched locally", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY,
    choosingTransport("not-a-pair", 0.9, "jev-1.14.0"));
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "malformed");
  assert.equal(decision.jev_requested_version, "jev-1.13.0");
  assert.equal(decision.jev_resolved_version, "jev-1.14.0");
});

test("low confidence falls to floor, retaining the selection evidence", async () => {
  const ids = pairIds();
  const decision = await choose(state(), buildCandidateSet(testCatalog()), { ...DEFAULT_JEV_POLICY, confidenceFloor: 0.9 },
    choosingTransport(ids[0], 0.4));
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "floor");
  assert.equal(decision.chosen_pair_id, ids[0]);
  assert.equal(decision.confidence, 0.4);
  assert.equal(decision.jev_resolved_version, "jev-1.13.0");
});

test("version drift is retained for the Guard to reject", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY,
    choosingTransport(pairIds()[0], 0.9, "jev-next"));
  assert.equal(decision.valid, true);
  assert.equal(decision.jev_requested_version, "jev-1.13.0");
  assert.equal(decision.jev_resolved_version, "jev-next");
});

test("missing response version stays UNKNOWN without erasing the proposal", async () => {
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY,
    async () => ({ choice: pairIds()[0], confidence: 0.9 }));
  assert.equal(decision.valid, true);
  assert.equal(decision.jev_requested_version, "jev-1.13.0");
  assert.equal(decision.jev_resolved_version, "UNKNOWN");
  assert.equal(decision.chosen_pair_id, pairIds()[0]);
});

test("transport failure is terminal: exactly one Choice attempt, no retry", async () => {
  let calls = 0;
  const decision = await choose(state(), buildCandidateSet(testCatalog()), { ...DEFAULT_JEV_POLICY, deadlineMs: 500 }, async () => {
    calls += 1;
    throw new Error("network reset");
  });
  assert.equal(calls, 1);
  assert.equal(decision.valid, false);
  assert.equal(decision.failure_reason, "transport");
});

test("auth failure is terminal with its subreason", async () => {
  let calls = 0;
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, async () => {
    calls += 1;
    throw new Error("auth: 401");
  });
  assert.equal(calls, 1);
  assert.equal(decision.failure_reason, "transport");
  assert.equal(decision.failure_subreason, "auth");
});

test("invalid API request is terminal with its subreason", async () => {
  let calls = 0;
  const decision = await choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, async () => {
    calls += 1;
    throw new Error("non_retryable: 400");
  });
  assert.equal(calls, 1);
  assert.equal(decision.failure_subreason, "non_retryable");
});

test("an alias version records its resolved version without drift failure", async () => {
  const decision = await choose(
    state(),
    buildCandidateSet(testCatalog()),
    { ...DEFAULT_JEV_POLICY, jevVersion: "jev-latest" },
    choosingTransport(pairIds()[0], 0.9, "jev-2.0"),
  );
  assert.equal(decision.valid, true);
  assert.equal(decision.jev_requested_version, "jev-latest");
  assert.equal(decision.jev_resolved_version, "jev-2.0");
});

test("cancellation during the Choice propagates the abort instead of a fallback", async () => {
  const controller = new AbortController();
  const transport = async (): Promise<never> => {
    return await new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const pending = choose(state(), buildCandidateSet(testCatalog()), DEFAULT_JEV_POLICY, transport, controller.signal);
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: Error) => error.name === "AbortError",
  );
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
