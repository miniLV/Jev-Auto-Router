import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRoute,
  observeExecution,
  observeFromCompletedEvent,
} from "../src/execution-contract.js";
import { completedEvent, sampleRequest, sseBody } from "./routing-fixtures.js";

test("applyRoute sets exactly model and effort; tools and input pass through untouched", () => {
  const request = { ...sampleRequest("gpt-6-astra"), input: [{ role: "user", content: "hi" }], tools: [{ type: "shell" }] };
  const { routed, applied } = applyRoute(request, { model: "gpt-6-luna", effort: "max" });
  assert.equal(routed.model, "gpt-6-luna");
  assert.equal(routed.reasoning?.effort, "max");
  assert.deepEqual(routed.input, request.input);
  assert.deepEqual(routed.tools, request.tools);
  assert.deepEqual(applied, { original_model: "gpt-6-astra", routed_model: "gpt-6-luna", routed_effort: "max" });
});

test("observed match: reported model equals routed model", () => {
  const applied = { original_model: "a", routed_model: "gpt-6-sol", routed_effort: "medium" };
  const observed = observeExecution(applied, {
    model: "gpt-6-sol",
    reasoning: { effort: "medium" },
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 },
  });
  assert.equal(observed.observation, "requested_match");
  assert.equal(observed.actual_model, "gpt-6-sol");
  assert.equal(observed.actual_effort, "medium");
  assert.equal(observed.usage.input_tokens, 100);
  assert.equal(observed.usage.cached_input_tokens, 40);
});

test("observed mismatch: reported model differs from routed model", () => {
  const applied = { original_model: "a", routed_model: "gpt-6-sol", routed_effort: "medium" };
  const observed = observeExecution(applied, { model: "gpt-6-astra" });
  assert.equal(observed.observation, "requested_mismatch");
});

test("UNKNOWN is never MATCH: absent metadata stays unobservable with UNKNOWN usage", () => {
  const applied = { original_model: "a", routed_model: "gpt-6-sol", routed_effort: "medium" };
  const observed = observeExecution(applied, {});
  assert.equal(observed.observation, "unobservable");
  assert.equal(observed.actual_model, "UNKNOWN");
  assert.equal(observed.usage.input_tokens, "UNKNOWN");
});

test("response.completed event observation reads model and openai-style usage", () => {
  const applied = { original_model: "a", routed_model: "gpt-6-sol", routed_effort: "medium" };
  const observed = observeFromCompletedEvent(applied, {
    response: {
      model: "gpt-6-sol",
      usage: { prompt_tokens: 500, completion_tokens: 60, input_tokens_details: { cached_tokens: 300 } },
    },
  });
  assert.equal(observed.observation, "requested_match");
  assert.equal(observed.usage.input_tokens, 500);
  assert.equal(observed.usage.cached_input_tokens, 300);
  assert.equal(observed.usage.output_tokens, 60);
});

test("fixture SSE body is valid completed-event content", async () => {
  const stream = sseBody([completedEvent("gpt-6-luna")]);
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.ok(text.includes("response.completed"));
  assert.ok(text.endsWith("[DONE]\n\n"));
});
