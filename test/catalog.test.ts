import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCandidateSet,
  lunaBindingDefect,
  LUNA_EFFORT,
  LUNA_MODEL,
  resolveBaseline,
} from "../src/catalog.js";
import { testCatalog } from "./routing-fixtures.js";

test("builds validated (model, effort) pairs from requestable models", () => {
  const set = buildCandidateSet(testCatalog());
  assert.equal(set.pairs.length, 7); // luna 2 + terra 3 + sol 2 (gpt6 excluded by default)
  assert.equal(set.excluded.filter(e => e.reason === "gpt6_not_admitted").length, 2);
  for (const pair of set.pairs) {
    assert.notEqual(pair.tier, "gpt6");
    assert.match(pair.pair_id, /^[0-9a-f]{16}$/);
  }
});

test("candidate construction never ranks: order follows catalog, no task-shape input", () => {
  const set = buildCandidateSet(testCatalog());
  const models = set.pairs.map(p => p.model);
  assert.deepEqual([...models], [...new Set(models)].flatMap(m => models.filter(x => x === m)));
  // Digest binds the decision.
  assert.equal(set.digest, buildCandidateSet(testCatalog()).digest);
});

test("GPT-6 admitted only under explicit admission", () => {
  const set = buildCandidateSet(testCatalog(), { gpt6Admitted: true });
  assert.equal(set.pairs.length, 9);
  assert.equal(set.pairs.filter(p => p.tier === "gpt6").length, 2);
});

test("forced model is a hard constraint recorded as exclusion", () => {
  const set = buildCandidateSet(testCatalog(), { forcedModel: "gpt-5.6-sol" });
  assert.ok(set.pairs.every(p => p.model === "gpt-5.6-sol"));
  assert.ok(set.excluded.some(e => e.reason === "forced_model"));
});

test("unrequestable models produce no pairs and are recorded", () => {
  const catalog = testCatalog([{ model: "gpt-5.6-sol", requestable: false }]);
  const set = buildCandidateSet(catalog);
  assert.ok(!set.pairs.some(p => p.model === "gpt-5.6-sol"));
  assert.ok(set.excluded.some(e => e.model === "gpt-5.6-sol" && e.reason === "model_not_requestable"));
});

test("luna binding: max effort must be requestable or the naming defect is reported", () => {
  assert.equal(lunaBindingDefect(testCatalog()), undefined);
  const broken = testCatalog([{ model: LUNA_MODEL, supported_efforts: ["medium"] }]);
  const defect = lunaBindingDefect(broken);
  assert.ok(defect && defect.includes(LUNA_EFFORT));
  const set = buildCandidateSet(broken);
  assert.ok(!set.pairs.some(p => p.model === LUNA_MODEL && p.effort === LUNA_EFFORT));
});

test("baseline resolution: Terra/medium when available, absent otherwise", () => {
  assert.deepEqual(resolveBaseline(testCatalog(), "gpt-5.6-terra", "medium")?.model, "gpt-5.6-terra");
  assert.equal(resolveBaseline(testCatalog(), "gpt-5.6-terra", "ultra"), undefined);
  const noTerra = testCatalog([{ model: "gpt-5.6-terra", requestable: false }]);
  assert.equal(resolveBaseline(noTerra, "gpt-5.6-terra", "medium"), undefined);
});
