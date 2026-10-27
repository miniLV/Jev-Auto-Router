import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPrompt,
  conversationKey,
  estimateContextTokens,
  freshTurnPrompt,
  hasToolSurface,
} from "../src/codex-router/turn.js";

const tools = [{ type: "additional_tools", tools: [] }];

test("recognises a fresh user turn after tool definitions", () => {
  const body = {
    input: [...tools, { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing test" }] }],
  };
  assert.equal(hasToolSurface(body), true);
  assert.equal(freshTurnPrompt(body), "fix the failing test");
});

test("a tool result after the user message is a continuation, not a fresh turn", () => {
  const body = {
    input: [
      ...tools,
      { type: "message", role: "user", content: "run the test" },
      { type: "function_call", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: "failed" },
    ],
  };
  assert.equal(freshTurnPrompt(body), null);
});

test("an assistant item after the user message is not a fresh turn", () => {
  const body = {
    input: [
      ...tools,
      { type: "message", role: "user", content: "continue" },
      { type: "message", role: "assistant", content: "still working" },
    ],
  };
  assert.equal(freshTurnPrompt(body), null);
});

test("auxiliary title generation is not routed", () => {
  const body = {
    input: [...tools, { type: "message", role: "user", content: "Generate a concise, single-line task title" }],
  };
  assert.equal(freshTurnPrompt(body), null);
});

test("a body without a tool surface is not a primary Codex turn", () => {
  const body = { input: [{ type: "message", role: "user", content: "hello" }] };
  assert.equal(freshTurnPrompt(body), null);
});

test("removes Codex UI envelopes from the prompt", () => {
  const prompt = cleanPrompt(
    "<environment_context>cwd</environment_context>\nFix the bug\n<system-reminder>ignore me</system-reminder>",
  );
  assert.equal(prompt, "Fix the bug");
});

test("conversation key prefers prompt_cache_key and stays stable", () => {
  const first = conversationKey({ prompt_cache_key: "session-1", input: [...tools] });
  const second = conversationKey({ prompt_cache_key: "session-1", input: [...tools] });
  assert.equal(first, second);
  assert.notEqual(first, conversationKey({ prompt_cache_key: "session-2", input: [...tools] }));
});

test("context estimate is a positive integer", () => {
  const value = estimateContextTokens([{ role: "user", content: "hello" }]);
  assert.equal(Number.isInteger(value), true);
  assert.equal(value > 0, true);
});
