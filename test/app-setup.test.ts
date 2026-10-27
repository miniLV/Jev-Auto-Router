import test from "node:test";
import assert from "node:assert/strict";
import { addAutoModel, updateCodexConfig } from "../src/codex-router/app-setup.js";

test("app setup updates top-level keys and preserves other tables", () => {
  const input = [
    'model_reasoning_effort = "high"',
    'model = "old-model"',
    "",
    "[desktop]",
    "appearanceTheme = \"system\"",
    "",
    "[model_providers.magpie]",
    'name = "magpie"',
  ].join("\n");
  const output = updateCodexConfig(input, 18767, "/tmp/catalog.json");
  assert.match(output, /^model = "jev-auto"$/m);
  assert.match(output, /^model_provider = "jev"$/m);
  assert.match(output, /^model_catalog_json = "\/tmp\/catalog\.json"$/m);
  assert.match(output, /^\[desktop\]$/m);
  assert.match(output, /^\[model_providers\.magpie\]$/m);
  assert.match(output, /^\[model_providers\.jev\]$/m);
  assert.match(output, /^base_url = "http:\/\/127\.0\.0\.1:18767"$/m);
});

test("app setup replaces an existing jev provider section", () => {
  const input = [
    'model = "jev-auto"',
    "",
    "[model_providers.jev]",
    'base_url = "http://old"',
    "",
    "[other]",
    "x = 1",
  ].join("\n");
  const output = updateCodexConfig(input, 19000, "/tmp/catalog.json");
  assert.equal((output.match(/\[model_providers\.jev\]/g) ?? []).length, 1);
  assert.match(output, /base_url = "http:\/\/127\.0\.0\.1:19000"/);
  assert.match(output, /^\[other\]$/m);
});

test("app setup adds the virtual model once", () => {
  const catalog = {
    models: [
      { slug: "gpt-6.1-sol", display_name: "Sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }] },
    ],
  };
  const first = addAutoModel(catalog) as { models: Array<Record<string, unknown>> };
  const second = addAutoModel(first) as { models: Array<Record<string, unknown>> };
  assert.equal(first.models[0].slug, "jev-auto");
  assert.equal(first.models[0].display_name, "Jev Auto Router");
  assert.equal(first.models[0].visibility, "list");
  assert.equal(second.models.filter((model) => model.slug === "jev-auto").length, 1);
});
