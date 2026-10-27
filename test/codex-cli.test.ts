import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, hasExplicitModel } from "../src/codex-router/cli.js";

test("builds a temporary provider and selects the virtual model", () => {
  const args = buildCodexArgs("http://127.0.0.1:1234", []);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-auto"]);
  assert.ok(args.includes('model_provider="jev"'));
  assert.ok(args.includes('model_providers.jev.base_url="http://127.0.0.1:1234"'));
  assert.ok(args.includes('model_providers.jev.wire_api="responses"'));
  assert.ok(args.includes('model_providers.jev.requires_openai_auth=true'));
});

test("a user-selected model is preserved", () => {
  assert.equal(hasExplicitModel(["--model", "gpt-6.1-sol"]), true);
  assert.equal(hasExplicitModel(["-m", "gpt-6.1-sol"]), true);
  assert.equal(hasExplicitModel(["--model=gpt-6.1-sol"]), true);
  const args = buildCodexArgs("http://127.0.0.1:1234", ["--model", "gpt-6.1-sol"]);
  assert.equal(args[0], "--config");
  assert.ok(args.includes("gpt-6.1-sol"));
  assert.equal(args.includes("jev-auto"), false);
});
