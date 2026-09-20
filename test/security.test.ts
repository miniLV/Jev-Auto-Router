import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROUTER_CONFIG, ResponsesProxy } from "../src/proxy.js";
import {
  choosingTransport,
  RecordingTransport,
  RecordingUpstream,
  sampleRequest,
  testCatalog,
  tierChoice,
} from "./routing-fixtures.js";

class RecordingTransportForCheck extends RecordingTransport {
  constructor() {
    super(async request => ({ choice: request.question.options[0], confidence: 0.9, model: "jev-1.13.0", usage: {} }));
  }
}

test("secrets never leave the host: logs and records carry digests, not content", async () => {
  const secret = "sk-abcdefghijklmnopqrst0123456789";
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), tierChoice("terra"), new RecordingUpstream().upstream);
  const { record, forwardRequest } = await p.routeCall({
    task_id: "t", step_type: "user_turn", request: sampleRequest(),
    user_turn: { request_text: `deploy with ${secret} now` },
    raw_hints: [`credential ${secret}`],
  });
  // Privacy refusal: no Jev call made, baseline executed.
  assert.equal(record.fallback_reason, "privacy_refusal");
  const serialized = JSON.stringify({ record, forwardRequest });
  assert.ok(!serialized.includes(secret));
});

test("Jev requests carry compact facts only, never raw prompt or tool text", async () => {
  const transport = new RecordingTransportForCheck();
  const p = new ResponsesProxy(DEFAULT_ROUTER_CONFIG, testCatalog(), transport.transport, new RecordingUpstream().upstream);
  const sensitive = "please summarize /etc/passwd contents";
  await p.routeCall({
    task_id: "t", step_type: "tool_step", request: { ...sampleRequest(), input: [{ role: "user", content: sensitive }] },
    tool_facts: { tool_name: "read", exit_status: 0, error_codes: [] },
    raw_hints: ["file tail output"],
  });
  for (const tracked of [JSON.stringify(transport.requests), JSON.stringify(p.telemetry.calls)]) {
    assert.ok(!tracked.includes(sensitive));
    assert.ok(!tracked.includes("file tail output"));
    assert.ok(!tracked.includes("/etc/passwd"));
  }
});

test("kill switch is zero-friction and restores the host request faithfully", async () => {
  const p = new ResponsesProxy({ ...DEFAULT_ROUTER_CONFIG, routerOff: true }, testCatalog(),
    choosingTransport("unused"), new RecordingUpstream().upstream);
  const request = sampleRequest("gpt-5.6-sol");
  const { forwardRequest, record } = await p.routeCall({ task_id: "t", step_type: "user_turn", request });
  assert.deepEqual(forwardRequest, request);
  assert.equal(record.actual_model, "gpt-5.6-sol");
});
