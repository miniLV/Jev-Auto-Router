import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROUTER_CONFIG, ResponsesProxy } from "../src/proxy.js";
import { JevTimeoutError, type JevTransport } from "../src/jev-adapter.js";
import { buildCandidateSet } from "../src/catalog.js";
import { pairIdOf, tierChoice } from "./routing-fixtures.js";
import {
  choosingTransport,
  completedEvent,
  readStream,
  RecordingTransport,
  RecordingUpstream,
  sampleRequest,
  sseBody,
  testCatalog,
} from "./routing-fixtures.js";

function proxy(options: {
  routerOff?: boolean;
  mode?: "active" | "shadow";
  jev?: JevTransport;
  baseline?: { model: string; effort: string };
  catalogue?: ReturnType<typeof testCatalog>;
  upstream?: RecordingUpstream;
} = {}) {
  const catalog = options.catalogue ?? testCatalog();
  const transport = options.jev ?? tierChoice("terra");
  const upstream = options.upstream ?? new RecordingUpstream();
  const config = {
    ...DEFAULT_ROUTER_CONFIG,
    routerOff: options.routerOff ?? false,
    mode: options.mode ?? "active",
    baseline: options.baseline ?? DEFAULT_ROUTER_CONFIG.baseline,
  };
  return { proxy: new ResponsesProxy(config, catalog, transport, upstream.upstream), upstream };
}

test("active Jev selection executes: pair applied, record kept, SSE unchanged", async () => {
  const catalog = testCatalog();
  const luna = buildCandidateSet(catalog).pairs.find(p => p.tier === "luna_max");
  assert.ok(luna);
  const { proxy: p } = proxy({ jev: choosingTransport(luna.pair_id) });
  const { forwardRequest, upstream: result, record, observed } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(),
  });
  assert.equal(forwardRequest.model, "gpt-5.6-luna");
  assert.equal(forwardRequest.reasoning?.effort, "max");
  assert.equal(record.route_source, "jev");
  assert.equal(record.mode, "active");
  assert.equal(record.actual_model, "gpt-5.6-luna");
  const passthrough = await readStream(result.body);
  assert.ok(passthrough.includes("response.completed"));
  assert.ok(passthrough.endsWith("[DONE]\n\n"));
  const observation = await observed;
  assert.equal(observation.observation, "requested_match");
  // Recorded execution, not the decision, reports actuals.
  assert.deepEqual(p.telemetry.calls.length, 1);
  assert.ok(record.eligible_pairs.includes(luna.pair_id));
});

test("kill switch restores the host's original model and never downgrades", async () => {
  const { proxy: p, upstream } = proxy({ routerOff: true });
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest("gpt-5.6-sol"),
  });
  assert.equal(forwardRequest.model, "gpt-5.6-sol");
  assert.equal(record.route_source, "bypass");
  assert.equal(record.fallback_reason, "router_off");
  assert.equal(upstream.requests[0].model, "gpt-5.6-sol");
});

test("infrastructure and verification calls use fixed profiles, never Jev", async () => {
  const transport = new RecordingTransport(choosingTransport("x"));
  const upstream = new RecordingUpstream();
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, upstream.upstream);
  await p.routeCall({ task_id: "t", step_type: "infrastructure", request: sampleRequest() });
  assert.equal(transport.requests.length, 0);
  assert.equal(upstream.requests[0].model, DEFAULT_ROUTER_CONFIG.infrastructureProfile.model);
  await p.routeCall({ task_id: "t", step_type: "verification", request: sampleRequest("x") });
  assert.equal(transport.requests.length, 0);
  assert.equal(upstream.requests[1].model, DEFAULT_ROUTER_CONFIG.verificationTier.model);
});

test("privacy refusal skips Jev: zero HTTP, baseline, bypass record", async () => {
  const transport = new RecordingTransport(choosingTransport("x"));
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "tool_step", request: sampleRequest(),
    tool_facts: { tool_name: "shell", exit_status: 1, error_codes: ["E1"], error_digest: "d" },
    raw_hints: ["api_key=AKIA0000000000000000"],
  });
  assert.equal(transport.requests.length, 0);
  assert.equal(record.route_source, "bypass");
  assert.equal(record.fallback_reason, "privacy_refusal");
  assert.equal(forwardRequest.model, "gpt-5.6-terra");
});

test("transport failure uses the baseline and skips Jev for the rest of the task", async () => {
  const transport = new RecordingTransport(async () => {
    throw new Error("network reset");
  });
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const first = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(first.record.route_source, "fallback");
  assert.equal(first.record.fallback_reason, "transport");
  assert.equal(first.forwardRequest.model, "gpt-5.6-terra");
  const httpAttempts = transport.requests.length;
  const second = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(second.record.fallback_reason, "jev_skipped_for_task");
  assert.equal(transport.requests.length, httpAttempts);
  // A different task still routes.
  await p.routeCall({ task_id: "other", step_type: "tool_step", request: sampleRequest() });
  assert.ok(transport.requests.length > httpAttempts);
});

test("low confidence falls back to the recorded baseline, never escalates", async () => {
  const catalog = testCatalog();
  const luna = buildCandidateSet(catalog).pairs.find(p => p.tier === "luna_max");
  assert.ok(luna);
  const { proxy: p } = proxy({ jev: choosingTransport(luna.pair_id, 0.01) });
  const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(forwardRequest.model, "gpt-5.6-terra");
  assert.equal(record.route_source, "fallback");
  assert.equal(record.fallback_reason, "low_confidence");
  assert.notEqual(forwardRequest.model, "gpt-6-astra");
});

test("timeout maps to timeout fallback and counts its transport attempts", async () => {
  const transport = new RecordingTransport(async () => {
    throw new JevTimeoutError();
  });
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const { record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(record.fallback_reason, "timeout");
});

test("baseline unavailable keeps the host's original request, never a provider switch", async () => {
  const { proxy: p } = proxy({
    baseline: { model: "nope", effort: "medium" },
    jev: (async () => {
      throw new Error("network reset");
    }) as never,
  });
  const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest("gpt-5.6-sol") });
  assert.equal(forwardRequest.model, "gpt-5.6-sol");
  assert.equal(record.route_source, "bypass");
  assert.equal(record.fallback_reason, "baseline_unavailable");
});

test("shadow logs the would-be route and executes the baseline", async () => {
  const catalog = testCatalog();
  const luna = buildCandidateSet(catalog).pairs.find(p => p.tier === "luna_max");
  assert.ok(luna);
  const { proxy: p, upstream } = proxy({ mode: "shadow", jev: choosingTransport(luna.pair_id) as never });
  const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(record.mode, "shadow");
  assert.equal(forwardRequest.model, "gpt-5.6-terra");
  assert.equal(record.actual_model, "gpt-5.6-terra");
  assert.equal(record.jev_choice, luna.pair_id);
  assert.equal(upstream.requests[0].model, "gpt-5.6-terra");
});

test("forced model bypasses Jev and executes exactly it", async () => {
  const transport = new RecordingTransport(choosingTransport("x"));
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), forced_model: "gpt-5.6-sol",
  });
  assert.equal(transport.requests.length, 0);
  assert.equal(record.route_source, "bypass");
  assert.equal(forwardRequest.model, "gpt-5.6-sol");
});

test("GPT-6 absent by default; one-shot eligibility admits it once and consumes it", async () => {
  const catalog = testCatalog();
  const gpt6 = buildCandidateSet(catalog, { gpt6Admitted: true }).pairs.find(p => p.tier === "gpt6");
  assert.ok(gpt6);
  const { proxy: p } = proxy({ jev: choosingTransport(gpt6.pair_id) });
  // Without eligibility, GPT-6 never reaches candidates.
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(p.taskState("t").gpt6_eligibility, undefined);
  p.openGpt6("t", "reasoning-blocker", "ev:1");
  assert.ok(p.taskState("t").gpt6_eligibility);
  const used = await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  assert.equal(used.forwardRequest.model, "gpt-6-astra");
  assert.equal(used.record.gpt6_eligibility_reason, "reasoning-blocker");
  // Consumed after use: next call cannot admit GPT-6 again without new evidence.
  assert.equal(p.taskState("t").gpt6_eligibility, undefined);
});

test("mandate executes GPT-6 as a hard constraint", async () => {
  const { proxy: p } = proxy({ jev: tierChoice("gpt6") });
  const { forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(), gpt6_mandate: true,
  });
  assert.equal(forwardRequest.model, "gpt-6-astra");
});

test("FAIL marks the next session call as correction with bounded failure facts", async () => {
  const { proxy: p } = proxy({});
  await p.routeCall({ task_id: "t", step_type: "tool_step", request: sampleRequest() });
  p.verifyTask("t", {
    conditions: [{ id: "a1", condition: "done" }],
    evidence: [{ acceptance_id: "a1", kind: "test", status: "fail", detail_ref: "r1" }],
  });
  const { record } = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest() });
  assert.equal(record.step_type, "correction");
});

test("competing authority stands down to the host request without Jev", async () => {
  const transport = new RecordingTransport(choosingTransport("x"));
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const { forwardRequest, record } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest("gpt-5.6-sol"), competing_authority: true,
  });
  assert.equal(transport.requests.length, 0);
  assert.equal(forwardRequest.model, "gpt-5.6-sol");
  assert.equal(record.fallback_reason, "competing_authority");
});
