import assert from "node:assert/strict";
import test from "node:test";
import {
  BaselineUnavailableError,
  CallCancelledError,
  ResponsesProxy,
  teeAndObserve,
  type RouterConfig,
} from "../src/proxy.js";
import { JevTimeoutError, type JevTransport } from "../src/jev-adapter.js";
import { buildCandidateSet } from "../src/catalog.js";
import { AUTO_MODEL } from "../src/types.js";
import {
  choosingTransport,
  completedEvent,
  delayedSseBody,
  pairIdOf,
  readStream,
  RecordingTransport,
  RecordingUpstream,
  routerConfig,
  sampleRequest,
  sseBody,
  testCatalog,
  tierChoice,
} from "./routing-fixtures.js";

function proxy(options: {
  routerOff?: boolean;
  mode?: "active" | "shadow";
  activeCandidates?: Array<{ model: string; effort: string }>;
  jev?: JevTransport;
  baseline?: { model: string; effort: string };
  catalogue?: ReturnType<typeof testCatalog>;
  upstream?: RecordingUpstream;
  now?: () => number;
  policy?: Partial<RouterConfig["policy"]>;
} = {}) {
  const catalog = options.catalogue ?? testCatalog();
  const transport = options.jev ?? tierChoice("sol");
  const upstream = options.upstream ?? new RecordingUpstream();
  const config = routerConfig({
    routerOff: options.routerOff ?? false,
    mode: options.mode ?? "active",
    baseline: options.baseline ?? { model: "gpt-6-sol", effort: "medium" },
    ...(options.activeCandidates ? { activeCandidates: options.activeCandidates } : {}),
    ...(options.policy ? { policy: { ...routerConfig().policy, ...options.policy } } : {}),
  });
  return { proxy: new ResponsesProxy(config, catalog, transport, upstream.upstream, undefined, options.now), upstream, config };
}

// ---------------------------------------------------------------------------
// Entry boundary (issue 02): only jev/auto routes; real models pass through.
// ---------------------------------------------------------------------------

test("a real model is manual selection: forwarded unchanged, Jev never asked", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p, upstream } = proxy({ jev: jev.transport });
  const request = { ...sampleRequest("gpt-6-luna"), reasoning: { effort: "high" } };
  const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "user_turn", request });
  assert.deepEqual(upstream.requests[0], request);
  assert.deepEqual(forwardRequest, request);
  assert.equal(jev.requests.length, 0);
  assert.equal(record.entry, "manual");
  assert.equal(record.route_source, "bypass");
  assert.equal(record.reason, "manual_model");
  assert.equal(record.applied_model, "gpt-6-luna");
});

test("an unknown or other virtual id is out of policy: forwarded unchanged, no inference", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p, upstream } = proxy({ jev: jev.transport });
  const { record } = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest("gpt-9-ghost") });
  assert.equal(upstream.requests[0].model, "gpt-9-ghost");
  assert.equal(jev.requests.length, 0);
  assert.equal(record.entry, "out_of_policy");
  assert.equal(record.reason, "out_of_policy_entry");
});

test("every automatic dispatch names a real model: the caller edge never sees jev/auto", async () => {
  const { proxy: p, upstream } = proxy({ mode: "active", jev: tierChoice("luna_max") });
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  for (const sent of upstream.requests) {
    assert.notEqual(sent.model, AUTO_MODEL);
  }
});

test("Active offers Jev only exact approved model/effort pairs", async () => {
  const allowed = { model: "gpt-6-luna", effort: "max" };
  const jev = new RecordingTransport(tierChoice("sol"));
  const { proxy: p, upstream } = proxy({ mode: "active", activeCandidates: [allowed], jev: jev.transport });
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  const offered = Object.keys(jev.requests[0].questions.route.criteria);
  assert.deepEqual(offered, [pairIdOf(allowed.model, allowed.effort)]);
  assert.equal(upstream.requests[0].model, allowed.model);
  assert.equal(upstream.requests[0].reasoning?.effort, allowed.effort);
});

test("an effort listed by discovery but absent from proof cannot reach Apply", async () => {
  const catalog = testCatalog([{
    model: "gpt-6-sol",
    supported_efforts: ["medium", "high"],
    proved_efforts: ["medium"],
    requestable: true,
  }]);
  const jev: JevTransport = async () => ({
    model: "jev-1.13.0",
    choice: pairIdOf("gpt-6-sol", "high"),
    confidence: 0.99,
  });
  const jevRequests = new RecordingTransport(jev);
  const { proxy: p, upstream } = proxy({
    catalogue: catalog,
    mode: "active",
    activeCandidates: [{ model: "gpt-6-sol", effort: "medium" }],
    jev: jevRequests.transport,
  });
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), user_turn: { request_text: "do the thing" },
  });
  assert.deepEqual(Object.keys(jevRequests.requests[0].questions.route.criteria), [pairIdOf("gpt-6-sol", "medium")]);
  assert.equal(forwardRequest.model, "gpt-6-sol");
  assert.equal(forwardRequest.reasoning?.effort, "medium");
  assert.deepEqual(upstream.requests.map(request => request.reasoning?.effort), ["medium"]);
  assert.equal(record.applied_effort, "medium");
});

test("expired candidate proofs are excluded before Jev is called", async () => {
  const catalog = testCatalog([{
    model: "gpt-6-sol",
    proved_efforts: ["medium", "high"],
    proof_expires_at: { medium: 10_000, high: 50 },
  }]);
  const jev = new RecordingTransport(choosingTransport(pairIdOf("gpt-6-sol", "high")));
  const { proxy: p, upstream } = proxy({
    catalogue: catalog,
    activeCandidates: [{ model: "gpt-6-sol", effort: "high" }],
    jev: jev.transport,
    now: () => 100,
  });
  const { forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), user_turn: { request_text: "do the thing" },
  });
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(upstream.requests.map(request => request.reasoning?.effort), ["medium"]);
  assert.equal(forwardRequest.reasoning?.effort, "medium");
});

test("a pair expiring during Jev Choice is rejected before Apply", async () => {
  let now = 100;
  const catalog = testCatalog([{
    model: "gpt-6-sol",
    proved_efforts: ["medium", "high"],
    proof_expires_at: { medium: 10_000, high: 150 },
  }]);
  const jev: JevTransport = async () => {
    now = 151;
    return { model: "jev-1.13.0", choice: pairIdOf("gpt-6-sol", "high"), confidence: 0.99 };
  };
  const { proxy: p, upstream } = proxy({
    catalogue: catalog,
    activeCandidates: [{ model: "gpt-6-sol", effort: "high" }],
    jev,
    now: () => now,
  });
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), user_turn: { request_text: "do the thing" },
  });
  assert.equal(forwardRequest.reasoning?.effort, "medium");
  assert.deepEqual(upstream.requests.map(request => request.reasoning?.effort), ["medium"]);
  assert.equal(record.route_source, "fallback");
  assert.equal(record.guard_reason, "PAIR_UNAVAILABLE");
});

test("an expired baseline during Jev Choice fails closed before any upstream request", async () => {
  let now = 100;
  const catalog = testCatalog([{
    model: "gpt-6-sol",
    proved_efforts: ["medium", "high"],
    proof_expires_at: { medium: 150, high: 10_000 },
  }]);
  const jev = async () => {
    now = 151;
    return { model: "jev-1.13.0", choice: pairIdOf("gpt-6-sol", "high"), confidence: 0.99 };
  };
  const jevRequests = new RecordingTransport(jev);
  const { proxy: p, upstream } = proxy({
    catalogue: catalog,
    baseline: { model: "gpt-6-sol", effort: "medium" },
    activeCandidates: [{ model: "gpt-6-sol", effort: "high" }],
    jev: jevRequests.transport,
    now: () => now,
  });
  await assert.rejects(
    () => p.routeCall({
      task_id: "t", step_type: "user_turn", request: sampleRequest(), user_turn: { request_text: "do the thing" },
    }),
    BaselineUnavailableError,
  );
  assert.equal(jevRequests.requests.length, 1);
  assert.equal(upstream.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Fixed Fallback Baseline paths (issue 02).
// ---------------------------------------------------------------------------

test("OFF executes the Fallback Baseline; it never restores the original virtual request", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p, upstream } = proxy({ routerOff: true, jev: jev.transport });
  const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest() });
  assert.equal(jev.requests.length, 0);
  assert.equal(forwardRequest.model, "gpt-6-sol");
  assert.equal(forwardRequest.reasoning?.effort, "medium");
  assert.equal(upstream.requests[0].model, "gpt-6-sol");
  assert.equal(record.route_source, "fallback");
  assert.equal(record.reason, "router_off");
});

test("infrastructure and competing-authority calls use the baseline with distinct reasons", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p, upstream } = proxy({ jev: jev.transport });
  const infra = await p.routeCall({ task_id: "t", step_type: "infrastructure", request: sampleRequest() });
  assert.equal(infra.record.reason, "infrastructure");
  assert.equal(infra.forwardRequest.model, "gpt-6-sol");
  const authority = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest(), competing_authority: true });
  assert.equal(authority.record.reason, "competing_authority");
  assert.equal(upstream.requests[1].model, "gpt-6-sol");
  assert.equal(jev.requests.length, 0);
});

test("baseline unavailable fails explicitly before output: no upstream request, no silent switch", async () => {
  const upstream = new RecordingUpstream();
  const { proxy: p } = proxy({
    routerOff: true,
    baseline: { model: "gpt-6-sol", effort: "high" },
    catalogue: testCatalog([{
      model: "gpt-6-sol",
      supported_efforts: ["medium", "high"],
      proved_efforts: ["medium"],
      requestable: true,
    }]),
    upstream,
  });
  await assert.rejects(
    () => p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest() }),
    BaselineUnavailableError,
  );
  assert.equal(upstream.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Streaming fidelity (issue 02): first bytes flow before completion.
// ---------------------------------------------------------------------------

test("routeCall returns while the upstream body is still streaming; observation never blocks", async () => {
  const upstream = new RecordingUpstream(() => delayedSseBody(
    [{ type: "response.output_text.delta", delta: "hello" }],
    [completedEvent("gpt-6-sol")],
    150,
  ));
  const { proxy: p } = proxy({ mode: "shadow", upstream });
  const result = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  // The first chunk must be readable before the delayed completion event.
  const reader = result.upstream.body.getReader();
  const first = await reader.read();
  assert.ok(!first.done);
  assert.ok(new TextDecoder().decode(first.value).includes("response.output_text.delta"));
  assert.equal(result.record.observed_model, "UNKNOWN");
  reader.releaseLock();
  const text = await readStream(result.upstream.body);
  assert.ok(text.includes("response.completed"));
  const observation = await result.observed;
  assert.equal(observation.actual_model, "gpt-6-sol");
  assert.equal(observation.terminated, "completed");
});

test("SSE bytes pass through unchanged: order, content and terminator", async () => {
  const { proxy: p } = proxy({ mode: "active", jev: tierChoice("sol") });
  const { upstream } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  const passthrough = await readStream(upstream.body);
  assert.ok(passthrough.includes("response.completed"));
  assert.ok(passthrough.endsWith("[DONE]\n\n"));
});

test("SSE terminal scanner distinguishes failure, completion and abnormal EOF without changing bytes", async () => {
  const applied = { original_model: AUTO_MODEL, routed_model: "gpt-6-sol", routed_effort: "medium" };
  const delta = { type: "response.output_text.delta", delta: "partial" };
  const cases = [
    {
      name: "response.failed",
      events: [delta, { type: "response.failed", response: { status: "failed" } }],
      terminated: "failed",
    },
    {
      name: "response.incomplete",
      events: [delta, { type: "response.incomplete", response: { status: "incomplete" } }],
      terminated: "failed",
    },
    {
      name: "response.completed",
      events: [delta, completedEvent("gpt-6-sol")],
      terminated: "completed",
    },
    { name: "EOF without terminal event", events: [delta], terminated: "failed" },
  ] as const;

  for (const item of cases) {
    const source = item.events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source));
        controller.close();
      },
    });
    const { passthrough, observed } = teeAndObserve(applied, body);
    assert.equal(await readStream(passthrough), source, item.name);
    const result = await observed;
    assert.equal(result.terminated, item.terminated, item.name);
    assert.equal(result.response_completed_at === "UNKNOWN", item.terminated !== "completed", item.name);
  }
});

test("an explicit SSE failure outranks completion events in either order", async () => {
  const applied = { original_model: AUTO_MODEL, routed_model: "gpt-6-sol", routed_effort: "medium" };
  const completed = completedEvent("gpt-6-sol");
  const failed = { type: "response.failed", response: { status: "failed" } };
  for (const events of [[completed, failed], [failed, completed]]) {
    const source = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source));
        controller.close();
      },
    });
    const { passthrough, observed } = teeAndObserve(applied, body);
    assert.equal(await readStream(passthrough), source);
    const result = await observed;
    assert.equal(result.terminated, "failed");
    assert.equal(result.response_completed_at, "UNKNOWN");
    assert.equal(result.upstream_completion_ms, "UNKNOWN");
  }
});

// ---------------------------------------------------------------------------
// Shadow Mode (issue 03): one validated Choice, baseline execution.
// ---------------------------------------------------------------------------

test("shadow records the proposal but executes the Fallback Baseline", async () => {
  const luna = pairIdOf("gpt-6-luna", "max");
  const { proxy: p, upstream } = proxy({ mode: "shadow", jev: choosingTransport(luna) });
  const { forwardRequest, record, observed } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  assert.equal(forwardRequest.model, "gpt-6-sol");
  assert.equal(upstream.requests[0].model, "gpt-6-sol");
  assert.equal(record.mode, "shadow");
  assert.equal(record.route_source, "fallback");
  assert.equal(record.reason, "shadow_mode");
  assert.equal(record.proposed_pair_id, luna);
  assert.equal(record.proposed_model, "gpt-6-luna");
  assert.equal(record.guard_verdict, "allow");
  await observed;
  assert.equal(record.observed_model, "gpt-6-sol");
  assert.notEqual(record.observed_model, record.proposed_model);
});

test("privacy refusal skips Jev entirely: baseline executed, distinct reason", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p } = proxy({ jev: jev.transport });
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(),
    raw_hints: ["api_key=AKIA0000000000000000"],
  });
  assert.equal(jev.requests.length, 0);
  assert.equal(record.reason, "privacy_refusal");
  assert.equal(forwardRequest.model, "gpt-6-sol");
});

test("insufficient routing facts do not call Jev: baseline with its own reason", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p } = proxy({ jev: jev.transport });
  const { record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(jev.requests.length, 0);
  assert.equal(record.reason, "insufficient_routing_facts");
  assert.equal(record.proposed_pair_id, undefined);
});

test("an unobservable response keeps observed UNKNOWN; applied never backfills it", async () => {
  const upstream = new RecordingUpstream(() => sseBody([{ type: "response.output_text.delta", delta: "x" }]));
  const { proxy: p } = proxy({ mode: "active", jev: tierChoice("luna_max"), upstream });
  const { record, observed } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  await observed;
  assert.equal(record.observed_model, "UNKNOWN");
  assert.equal(record.observed_effort, "UNKNOWN");
  assert.equal(record.observation, "unobservable");
  assert.equal(record.applied_model, "gpt-6-luna");
  assert.equal(record.model_input_tokens, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// Active per-call apply (issue 04).
// ---------------------------------------------------------------------------

test("active applies the accepted pair; every other request field keeps its semantics", async () => {
  const { proxy: p } = proxy({ mode: "active", jev: tierChoice("luna_max") });
  const request = {
    ...sampleRequest(),
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    tools: [{ type: "function", name: "shell" }],
    metadata: { trace: "keep" },
    service_tier: "priority",
    parallel_tool_calls: false,
  };
  const { forwardRequest } = await p.routeCall({ task_id: "t", step_type: "tool_step", request, current_model: "gpt-6-sol" });
  assert.equal(forwardRequest.model, "gpt-6-luna");
  assert.equal(forwardRequest.reasoning?.effort, "max");
  assert.deepEqual(forwardRequest.input, request.input);
  assert.deepEqual(forwardRequest.tools, request.tools);
  assert.deepEqual(forwardRequest.metadata, request.metadata);
  assert.equal(forwardRequest.service_tier, "priority");
  assert.equal(forwardRequest.parallel_tool_calls, false);
  assert.equal(forwardRequest.stream, true);
});

test("two consecutive calls route independently and can reach different models (A to B)", async () => {
  let call = 0;
  const jev: JevTransport = async request => {
    call += 1;
    const ids = Object.keys(request.questions.route.criteria);
    const wanted = call === 1 ? pairIdOf("gpt-6-luna", "medium") : pairIdOf("gpt-6-sol", "low");
    return { model: "jev-1.13.0", choice: ids.includes(wanted) ? wanted : ids[0], confidence: 0.9, usage: { input_tokens: 10, output_tokens: 2 } };
  };
  const { proxy: p, upstream } = proxy({ mode: "active", jev });
  const first = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), user_turn: { request_text: "do the thing" },
  });
  assert.equal(first.forwardRequest.model, "gpt-6-luna");
  const second = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(),
    current_model: "gpt-6-luna",
  });
  assert.equal(second.forwardRequest.model, "gpt-6-sol");
  assert.equal(second.forwardRequest.reasoning?.effort, "low");
  // Tool-result IDs continue: the exact input the host sent is forwarded.
  assert.deepEqual(upstream.requests.map(r => r.model), ["gpt-6-luna", "gpt-6-sol"]);
});

test("mandate admits Astra as a hard constraint and executes it", async () => {
  const { proxy: p } = proxy({ mode: "active", jev: tierChoice("astra") });
  const { forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), astra_mandate: true, user_turn: { request_text: "use astra" },
  });
  assert.equal(forwardRequest.model, "gpt-6-astra");
});

test("forced model restricts candidates instead of bypassing the policy", async () => {
  const jev = new RecordingTransport(tierChoice("luna_max"));
  const { proxy: p, upstream } = proxy({ mode: "active", jev: jev.transport });
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), forced_model: "gpt-6-sol", user_turn: { request_text: "stay on luna" },
  });
  assert.equal(forwardRequest.model, "gpt-6-sol");
  assert.equal(upstream.requests[0].model, "gpt-6-sol");
  assert.equal(record.reason, undefined);
  assert.equal(record.route_source, "jev");
  // The offered candidate set contained only the forced model's pairs.
  const offered = Object.keys(jev.requests[0].questions.route.criteria);
  const set = buildCandidateSet(testCatalog(), { forcedModel: "gpt-6-sol" });
  assert.deepEqual([...offered].sort(), set.pairs.map(pair => pair.pair_id).sort());
});

test("FAIL marks the next session call as correction and retains local failure facts", async () => {
  const { proxy: p } = proxy({});
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  p.verifyTask("t", {
    conditions: [{ id: "a1", condition: "done" }],
    evidence: [{ acceptance_id: "a1", kind: "test", status: "fail", detail_ref: "r1" }],
  });
  const { record } = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest(), user_turn: { request_text: "fix it" } });
  assert.equal(record.step_type, "correction");
  assert.deepEqual(p.taskState("t").failure_facts, { failing_item_ids: ["a1"] });
});

test("a correction without other routing facts falls back and preserves privacy refusal", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p, upstream } = proxy({ jev: jev.transport });
  p.verifyTask("t", {
    conditions: [{ id: "untrusted-acceptance-id", condition: "done" }],
    evidence: [{ acceptance_id: "untrusted-acceptance-id", kind: "test", status: "fail", detail_ref: "local-ref" }],
  });

  const insufficient = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest() });
  assert.equal(insufficient.record.reason, "insufficient_routing_facts");
  assert.equal(jev.requests.length, 0);
  assert.equal(upstream.requests.length, 1);

  p.verifyTask("sensitive", {
    conditions: [{ id: "another-untrusted-id", condition: "done" }],
    evidence: [{ acceptance_id: "another-untrusted-id", kind: "test", status: "fail", detail_ref: "local-ref" }],
  });
  const refused = await p.routeCall({
    task_id: "sensitive",
    step_type: "user_turn",
    request: sampleRequest(),
    current_model: "gpt-6-sol",
    raw_hints: ["password: caller-secret"],
  });
  assert.equal(refused.record.reason, "privacy_refusal");
  assert.equal(jev.requests.length, 0);
  assert.equal(upstream.requests.length, 2);
});

// ---------------------------------------------------------------------------
// Failure boundaries (issue 05): distinct reasons, one request per call.
// ---------------------------------------------------------------------------

test("every Jev failure maps to its exact reason and executes the baseline once", async () => {
  const cases: Array<{ jev: JevTransport; reason: string }> = [
    { jev: tierChoice("sol", 0.01), reason: "low_confidence" },
    { jev: async () => { throw new JevTimeoutError(); }, reason: "jev_timeout" },
    { jev: async () => { throw new Error("network reset"); }, reason: "jev_failure" },
    { jev: choosingTransport("not-a-pair"), reason: "invalid_choice" },
    { jev: choosingTransport(pairIdOf("gpt-6-sol", "medium"), 0.9, "jev-next"), reason: "jev_version_mismatch" },
  ];
  for (const { jev, reason } of cases) {
    const upstream = new RecordingUpstream();
    const { proxy: p } = proxy({ mode: "active", jev, upstream });
    const { forwardRequest, record } = await p.routeCall({
      task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
    });
    assert.equal(record.reason, reason, `expected ${reason}`);
    assert.equal(record.route_source, "fallback");
    assert.equal(forwardRequest.model, "gpt-6-sol");
    assert.equal(upstream.requests.length, 1);
  }
});

test("low confidence keeps the proposal as evidence without executing it", async () => {
  const { proxy: p } = proxy({ mode: "active", jev: choosingTransport(pairIdOf("gpt-6-luna", "max"), 0.01) });
  const { record, forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  assert.equal(record.proposed_model, "gpt-6-luna");
  assert.equal(record.applied_model, "gpt-6-sol");
  assert.equal(forwardRequest.model, "gpt-6-sol");
});

test("an unpinned Jev version is not Active-eligible: baseline, no Jev call", async () => {
  const jev = new RecordingTransport(choosingTransport("x"));
  const { proxy: p } = proxy({ jev: jev.transport, policy: { jevVersion: "jev-latest" } });
  const { record, forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  assert.equal(jev.requests.length, 0);
  assert.equal(record.reason, "jev_version_mismatch");
  assert.equal(forwardRequest.model, "gpt-6-sol");
});

test("shadow mode tolerates an alias version but still executes the baseline", async () => {
  const { proxy: p } = proxy({
    mode: "shadow",
    jev: choosingTransport(pairIdOf("gpt-6-luna", "medium"), 0.9, "jev-1.14.0"),
    policy: { jevVersion: "jev-latest" },
  });
  const { record, forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
  });
  assert.equal(record.reason, "shadow_mode");
  assert.equal(record.jev_resolved_version, "jev-1.14.0");
  assert.equal(record.proposed_model, "gpt-6-luna");
  assert.equal(forwardRequest.model, "gpt-6-sol");
});

test("transport failure does not poison later calls: the next call routes again", async () => {
  let fail = true;
  const sensitiveError = "credential=jev-transport-secret";
  const jev: JevTransport = async () => {
    if (fail) throw new Error(`unexpected transport detail ${sensitiveError}`);
    return { model: "jev-1.13.0", choice: pairIdOf("gpt-6-luna", "medium"), confidence: 0.9, usage: {} };
  };
  const { proxy: p, upstream } = proxy({ mode: "active", jev });
  const first = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  assert.equal(first.record.reason, "jev_failure");
  assert.equal(first.record.jev_choice_result, "jev_failure");
  assert.equal(first.record.jev_failure_subreason, "network");
  assert.ok(!JSON.stringify(first.record).includes(sensitiveError));
  fail = false;
  const second = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  assert.equal(second.record.reason, undefined);
  assert.equal(second.record.route_source, "jev");
  assert.equal(upstream.requests.length, 2);
});

test("an upstream failure before output surfaces as an error record, never a retry", async () => {
  const attempts: string[] = [];
  const upstreamFn = async (): Promise<never> => {
    attempts.push("attempt");
    throw new Error("edge unavailable");
  };
  const failing = new ResponsesProxy(routerConfig({ mode: "active" }), testCatalog(), tierChoice("sol"), upstreamFn);
  await assert.rejects(
    () => failing.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" }),
    /edge unavailable/,
  );
  assert.equal(attempts.length, 1);
  assert.equal(failing.telemetry.calls.length, 1);
  assert.equal(failing.telemetry.calls[0].call_status, "error");
});

// ---------------------------------------------------------------------------
// Cancellation boundaries (issues 02 and 05).
// ---------------------------------------------------------------------------

test("cancelling during the Jev wait sends no upstream request and records cancelled", async () => {
  const upstream = new RecordingUpstream();
  const controller = new AbortController();
  // Mirrors fetchJevTransport: the abort signal rejects the in-flight wait.
  const jev: JevTransport = () =>
    new Promise((_resolve, reject) => {
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
  const { proxy: p } = proxy({ jev, upstream });
  const pending = p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => pending, CallCancelledError);
  assert.equal(upstream.requests.length, 0);
  assert.equal(p.telemetry.calls.length, 1);
  const record = p.telemetry.calls[0];
  assert.equal(record.call_status, "cancelled");
  assert.equal(record.applied_model, "UNKNOWN");
});

test("cancelling during upstream generation aborts it: one request, cancelled record, no fallback", async () => {
  const upstream = new RecordingUpstream((_request, signal) => delayedSseBody(
    [{ type: "response.output_text.delta", delta: "partial" }],
    [completedEvent("gpt-6-luna")],
    200,
    { signal },
  ));
  const { proxy: p } = proxy({ mode: "active", jev: tierChoice("luna_max"), upstream });
  const controller = new AbortController();
  const result = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol",
    signal: controller.signal,
  });
  const reader = result.upstream.body.getReader();
  const first = await reader.read();
  assert.ok(!first.done);
  controller.abort();
  await assert.rejects(() => reader.read());
  const observation = await result.observed;
  assert.equal(observation.terminated, "aborted");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.aborts.length, 1);
  assert.equal(result.record.call_status, "cancelled");
  assert.equal(result.record.observed_model, "UNKNOWN");
});

test("Astra stays absent without admission and is consumed once when used", async () => {
  const astra = pairIdOf("gpt-6-astra", "medium");
  const { proxy: p } = proxy({ mode: "active", jev: choosingTransport(astra) });
  const refused = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  assert.equal(refused.record.reason, "invalid_choice");
  assert.equal(refused.forwardRequest.model, "gpt-6-sol");
  p.openAstra("t", "reasoning-blocker", "ev:1");
  const used = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest(), current_model: "gpt-6-sol" });
  assert.equal(used.forwardRequest.model, "gpt-6-astra");
  assert.equal(used.record.astra_eligibility_reason, "reasoning-blocker");
  assert.equal(p.taskState("t").astra_eligibility, undefined);
});
