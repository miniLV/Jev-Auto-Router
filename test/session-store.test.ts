import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore } from "../src/codex-router/session-store.js";
import type { SessionState } from "../src/codex-router/types.js";

function state(): SessionState {
  return {
    tier: "balanced",
    model: "gpt-6-sol",
    updatedAt: 100,
    turns: 3,
    switches: 1,
    turnsSinceSwitch: 2,
    lastPromptHash: "abc",
    lastContextTokens: 12_000,
    cache: {
      inputTokens: 12_000,
      cachedTokens: 10_000,
      cacheWriteTokens: 2_000,
      outputTokens: 500,
      at: 90,
      warm: true,
    },
  };
}

test("persists routing state and restores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-sessions-"));
  const file = join(dir, "sessions.json");
  const store = new JsonSessionStore(file);
  store.save({ session: state() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const loaded = await store.load();
  assert.deepEqual(loaded.session, state());
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes("prompt text"), false);
});
