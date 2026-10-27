import test from "node:test";
import assert from "node:assert/strict";
import { parseUsage, UsageScanner } from "../src/codex-router/usage.js";

test("parses cached and cache-write usage", () => {
  const usage = parseUsage({
    input_tokens: 12_000,
    input_tokens_details: { cached_tokens: 10_000 },
    cache_write_input_tokens: 2_000,
    output_tokens: 500,
  }, 123);
  assert.deepEqual(usage, {
    inputTokens: 12_000,
    cachedTokens: 10_000,
    cacheWriteTokens: 2_000,
    outputTokens: 500,
    at: 123,
    warm: true,
  });
});

test("a zero cache read marks the model cold", () => {
  assert.equal(parseUsage({ input_tokens: 100, cached_input_tokens: 0 }, 1)?.warm, false);
});

test("scans a terminal SSE completion event without mutating the stream", () => {
  const seen: unknown[] = [];
  const scanner = new UsageScanner((usage) => seen.push(usage), () => 5);
  scanner.push('event: response.created\ndata: {"type":"response.created"}\n\n');
  scanner.push('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"cache_write_input_tokens":20,"output_tokens":10}}}\n\n');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    inputTokens: 100,
    cachedTokens: 80,
    cacheWriteTokens: 20,
    outputTokens: 10,
    at: 5,
    warm: true,
  });
});

test("ignores malformed and incomplete events", () => {
  const seen: unknown[] = [];
  const scanner = new UsageScanner((usage) => seen.push(usage));
  scanner.push("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\"}\n\n");
  scanner.push("data: not-json\n\n");
  scanner.end();
  assert.equal(seen.length, 0);
});
