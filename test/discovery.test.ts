import assert from "node:assert/strict";
import test from "node:test";
import { ModelDiscovery } from "../src/discovery.js";
import { inferTier } from "../src/catalog.js";

test("trusted surface models become requestable entries with supported efforts", async () => {
  const discovery = new ModelDiscovery();
  const catalog = await discovery.discover("s1", async () => ({
    source: "app-server",
    models: [{ model: "gpt-5.6-terra", supported_efforts: ["low", "medium"] }],
  }), 0);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].requestable, true);
  assert.deepEqual(catalog.models[0].supported_efforts, ["low", "medium"]);
});

test("non-product models are not catalogued", async () => {
  const discovery = new ModelDiscovery();
  const catalog = await discovery.discover("s1", async () => ({
    source: "app-server",
    models: [{ model: "some-other-model", supported_efforts: ["low"] }],
  }), 0);
  assert.equal(catalog.models.length, 0);
});

test("discovery caches per session binding", async () => {
  const discovery = new ModelDiscovery();
  let calls = 0;
  const fetchList = async () => {
    calls += 1;
    return { source: "app-server", models: [{ model: "gpt-5.6-sol" }] };
  };
  const first = await discovery.discover("s1", fetchList, 0);
  const second = await discovery.discover("s1", fetchList, 1);
  assert.equal(calls, 2);
  assert.deepEqual(first, second);
  await discovery.discover("s2", fetchList, 2);
  assert.equal(calls, 3);
});

test("tier inference covers the four product tiers", () => {
  assert.equal(inferTier("gpt-5.6-luna"), "luna_max");
  assert.equal(inferTier("gpt-5.6-terra-x"), "terra");
  assert.equal(inferTier("gpt-5.6-sol"), "sol");
  assert.equal(inferTier("gpt-6-astra"), "gpt6");
  assert.equal(inferTier("claude"), undefined);
});
