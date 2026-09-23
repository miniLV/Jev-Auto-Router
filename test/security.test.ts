import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesProxy } from "../src/proxy.js";
import {
  choosingTransport,
  RecordingTransport,
  RecordingUpstream,
  routerConfig,
  sampleRequest,
  testCatalog,
  tierChoice,
} from "./routing-fixtures.js";

class RecordingTransportForCheck extends RecordingTransport {
  constructor() {
    super(async request => ({ choice: Object.keys(request.questions.route.criteria)[0], confidence: 0.9, model: "jev-1.13.0", usage: {} }));
  }
}

test("secrets never leave the host: logs and records carry digests, not content", async () => {
  const secret = "sk-abcdefghijklmnopqrst0123456789";
  const p = new ResponsesProxy(routerConfig({ mode: "active" }), testCatalog(), tierChoice("sol"), new RecordingUpstream().upstream);
  const { record, forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(),
    user_turn: { request_text: `deploy with ${secret} now` },
    raw_hints: [`credential ${secret}`],
  });
  // Privacy refusal: no Jev call made, baseline executed.
  assert.equal(record.reason, "privacy_refusal");
  const serialized = JSON.stringify({ record, forwardRequest });
  assert.ok(!serialized.includes(secret));
});

test("Jev requests carry compact facts only, never raw prompt or tool text", async () => {
  const transport = new RecordingTransportForCheck();
  const p = new ResponsesProxy(routerConfig({ mode: "active" }), testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const sensitive = "please summarize /etc/passwd contents";
  await p.routeCall({
    task_id: "t", step_type: "tool_step", request: { ...sampleRequest(), input: [{ role: "user", content: sensitive }] },
    current_model: "gpt-6-sol",
    raw_hints: ["file tail output"],
  });
  for (const tracked of [JSON.stringify(transport.requests), JSON.stringify(p.telemetry.calls)]) {
    assert.ok(!tracked.includes(sensitive));
    assert.ok(!tracked.includes("file tail output"));
    assert.ok(!tracked.includes("/etc/passwd"));
  }
});

test("the kill switch is zero-friction: OFF executes the configured baseline pair exactly", async () => {
  const p = new ResponsesProxy(routerConfig({ routerOff: true, baseline: { model: "gpt-6-sol", effort: "medium" } }), testCatalog(),
    choosingTransport("unused"), new RecordingUpstream().upstream);
  const { forwardRequest, record, observed } = await p.routeCall({ task_id: "t", step_type: "user_turn", request: sampleRequest() });
  assert.equal(forwardRequest.model, "gpt-6-sol");
  assert.equal(forwardRequest.reasoning?.effort, "medium");
  assert.equal(record.reason, "router_off");
  assert.equal(record.applied_model, "gpt-6-sol");
  await observed;
  assert.equal(record.observed_model, "gpt-6-sol");
});

test("upstream credentials never ride along to Jev: transports see only the routing payload", async () => {
  const transport = new RecordingTransportForCheck();
  const p = new ResponsesProxy(routerConfig({ mode: "active" }), testCatalog(), transport.transport, new RecordingUpstream().upstream);
  await p.routeCall({
    task_id: "t", step_type: "tool_step",
    request: { ...sampleRequest(), headers_like: { authorization: "Bearer sk-upstream-secret-000000" } },
    current_model: "gpt-6-sol",
  });
  const sent = JSON.stringify(transport.requests[0]);
  assert.ok(!sent.includes("sk-upstream-secret"));
});
