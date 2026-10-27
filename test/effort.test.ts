import test from "node:test";
import assert from "node:assert/strict";
import {
  addOrReplaceUpdate,
  applyEffortUpdates,
  chooseEffort,
  dedupeAdjacentUpdates,
  effectiveEffort,
  validateUpdates,
} from "../src/codex-router/effort.js";
import type { JevScores } from "../src/codex-router/types.js";

const scores = (reasoningRequired: number): JevScores => ({
  taskComplexity: reasoningRequired,
  reasoningRequired,
  toolComplexity: 0.2,
  contextSize: 0.1,
});

test("maps high complexity to high effort and caps it", () => {
  assert.equal(chooseEffort(scores(0.8), "medium", "high", ["low", "medium", "high", "max"])?.effort, "high");
  assert.equal(chooseEffort(scores(0.95), "medium", "high", ["low", "medium", "high", "max"])?.effort, "high");
  assert.equal(chooseEffort(scores(0.1), "medium", "high", ["low", "medium", "high", "max"])?.effort, "low");
});

test("uses the nearest supported effort and falls back when scores are absent", () => {
  assert.equal(chooseEffort(scores(0.4), "medium", "high", ["low", "high"])?.effort, "low");
  const fallback = chooseEffort(undefined, "medium", "high", ["low", "medium", "high"]);
  assert.equal(fallback?.effort, "medium");
  assert.equal(fallback?.source, "fallback");
});

test("adds one update per user anchor and replaces a changed effort", () => {
  const input = [{ role: "user", content: "one" }];
  const first = addOrReplaceUpdate(input, [], "high");
  assert.equal(first.length, 1);
  assert.equal(first[0].effort, "high");
  const replaced = addOrReplaceUpdate(input, first, "low");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].effort, "low");
});

test("reinserts prior updates before their anchors and keeps later updates", () => {
  const firstInput = [{ role: "user", content: "one" }];
  let updates = addOrReplaceUpdate(firstInput, [], "high");
  const secondInput = [
    { role: "user", content: "one" },
    { role: "assistant", content: "working" },
    { role: "user", content: "two" },
  ];
  assert.equal(validateUpdates(secondInput, updates), true);
  updates = addOrReplaceUpdate(secondInput, updates, "low");
  const output = applyEffortUpdates(secondInput, updates) as Array<Record<string, unknown>>;
  assert.deepEqual(output.map((item) => item.type ?? item.role), [
    "configuration_update",
    "user",
    "assistant",
    "configuration_update",
    "user",
  ]);
  assert.equal((output[0].reasoning as { effort: string }).effort, "high");
  assert.equal((output[3].reasoning as { effort: string }).effort, "low");
});

test("rejects updates when the native anchor changed", () => {
  const input = [{ role: "user", content: "one" }];
  const updates = addOrReplaceUpdate(input, [], "high");
  assert.equal(validateUpdates([{ role: "user", content: "different" }], updates), false);
  assert.equal(effectiveEffort("medium", updates), "high");
});

test("removes only adjacent duplicate updates", () => {
  const input = [
    { type: "configuration_update", reasoning: { effort: "high" } },
    { type: "configuration_update", reasoning: { effort: "high" } },
    { role: "user", content: "x" },
    { type: "configuration_update", reasoning: { effort: "high" } },
    { type: "configuration_update", reasoning: { effort: "low" } },
  ];
  const output = dedupeAdjacentUpdates(input) as unknown[];
  assert.equal(output.length, 4);
});
