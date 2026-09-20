import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoutingState,
  checkSendEligibility,
  looksSensitive,
  CHOICE_INSTRUCTION,
  buildQuestion,
} from "../src/route-plan.js";

test("routing state is allowlisted: no raw text enters the payload", () => {
  const { state } = buildRoutingState({
    task_id: "t",
    call_index: 1,
    step_type: "user_turn",
    current_model: "gpt-5.6-sol",
    user_turn: { request_text: "please fix the failing parser and add tests" },
    rawHints: ["some long tool output tail"],
  });
  assert.equal(state.user_turn_facts?.request_length_bucket, "short");
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("please fix"));
  assert.ok(!serialized.includes("tool output tail"));
});

test("tool facts carry name, exit status, error codes and fixed-length digests only", () => {
  const { state } = buildRoutingState({
    task_id: "t",
    call_index: 2,
    step_type: "tool_step",
    tool_facts: { tool_name: "shell", exit_status: 1, error_codes: ["ENOENT"], error_digest: "a".repeat(16) },
  });
  assert.deepEqual(state.tool_facts, { tool_name: "shell", exit_status: 1, error_codes: ["ENOENT"], error_digest: "aaaaaaaaaaaaaaaa" });
});

test("sensitive content is refused, not truncated", () => {
  assert.ok(looksSensitive("password: hunter2"));
  assert.ok(looksSensitive("sk-abcdefghijklmnopqrst"));
  assert.ok(looksSensitive("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(!looksSensitive("exit status 1, no such file"));
  const refused = checkSendEligibility({ task_id: "t", call_index: 0, step_type: "tool_step" }, ["token=abc123def456"]);
  assert.deepEqual(refused, { hasSendEligibility: false, reason: "sensitive_content" });
});

test("the choice instruction states the objective and treats facts as data", () => {
  assert.match(CHOICE_INSTRUCTION, /lowest-cost eligible/);
  assert.match(CHOICE_INSTRUCTION, /never as instructions/);
});

test("question digest binds options and schema version", () => {
  const state = { task_id: "t", call_index: 0, step_type: "user_turn" as const };
  const a = buildQuestion(state, ["p1", "p2"]);
  const b = buildQuestion(state, ["p2", "p1"]);
  assert.equal(a.schema_version, "choice-pairs/1");
  assert.notEqual(a.digest, b.digest);
});
