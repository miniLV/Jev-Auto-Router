import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parsePriceTable } from "../src/codex-router/config.js";

test("parses a per-model price table", () => {
  const table = parsePriceTable(JSON.stringify({
    "gpt-6-sol": { input: 1, cached_input: 0.1, cache_write_input: 1.25, output: 4 },
  }));
  assert.deepEqual(table, {
    "gpt-6-sol": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 4 },
  });
});

test("rejects malformed or incomplete prices", () => {
  assert.equal(parsePriceTable("not-json"), undefined);
  assert.equal(parsePriceTable(JSON.stringify({ "gpt-6-sol": { input: 1 } })), undefined);
});

test("loads optimization knobs from the environment", () => {
  const config = loadConfig({
    JEV_CODEX_TASK_TURN_BUDGET: "10",
    JEV_CODEX_LOCK_BEFORE_END_TURNS: "2",
    JEV_CODEX_UPGRADE_MODE: "always",
    JEV_CODEX_SESSION_FILE: "/tmp/jev-sessions.json",
    JEV_CODEX_SESSION_TTL_MS: "60000",
    JEV_CODEX_STRIP_ENCRYPTED_REASONING: "1",
    JEV_CODEX_PRICES: JSON.stringify({
      "gpt-6-sol": { input: 1, cached_input: 0.1, cache_write_input: 1.25, output: 4 },
    }),
  });
  assert.equal(config.taskTurnBudget, 10);
  assert.equal(config.lockBeforeEndTurns, 2);
  assert.equal(config.upgradeMode, "always");
  assert.equal(config.sessionFile, "/tmp/jev-sessions.json");
  assert.equal(config.sessionTtlMs, 60_000);
  assert.equal(config.stripEncryptedReasoning, true);
  assert.equal(config.prices?.["gpt-6-sol"]?.cacheWriteInput, 1.25);
});
