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
  assert.equal(set.pairs.length, 5); // luna 2 + sol 3 (astra excluded by default)
  assert.equal(set.excluded.filter(e => e.reason === "astra_not_admitted").length, 2);
  for (const pair of set.pairs) {
    assert.notEqual(pair.tier, "astra");
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

test("Astra admitted only under explicit admission", () => {
  const set = buildCandidateSet(testCatalog(), { astraAdmitted: true });
  assert.equal(set.pairs.length, 7);
  assert.equal(set.pairs.filter(p => p.tier === "astra").length, 2);
});

test("forced model is a hard constraint recorded as exclusion", () => {
  const set = buildCandidateSet(testCatalog(), { forcedModel: "gpt-6-sol" });
  assert.ok(set.pairs.every(p => p.model === "gpt-6-sol"));
  assert.ok(set.excluded.some(e => e.reason === "forced_model"));
});

test("Active admission is limited to exact allowlisted model/effort pairs", () => {
  const set = buildCandidateSet(testCatalog(), { allowedPairs: [{ model: "gpt-6-luna", effort: "max" }] });
  assert.deepEqual(set.pairs.map(pair => [pair.model, pair.effort]), [["gpt-6-luna", "max"]]);
  assert.ok(set.excluded.some(pair => pair.model === "gpt-6-luna" && pair.effort === "medium" && pair.reason === "not_active_eligible"));
});

test("unrequestable models produce no pairs and are recorded", () => {
  const catalog = testCatalog([{ model: "gpt-6-sol", requestable: false }]);
  const set = buildCandidateSet(catalog);
  assert.ok(!set.pairs.some(p => p.model === "gpt-6-sol"));
  assert.ok(set.excluded.some(e => e.model === "gpt-6-sol" && e.reason === "model_not_requestable"));
});

test("luna binding: max effort must be requestable or the naming defect is reported", () => {
  assert.equal(lunaBindingDefect(testCatalog()), undefined);
  const broken = testCatalog([{ model: LUNA_MODEL, supported_efforts: ["medium"] }]);
  const defect = lunaBindingDefect(broken);
  assert.ok(defect && defect.includes(LUNA_EFFORT));
  const set = buildCandidateSet(broken);
  assert.ok(!set.pairs.some(p => p.model === LUNA_MODEL && p.effort === LUNA_EFFORT));
});

test("baseline resolution: resolves only the exact configured model and effort", () => {
  assert.deepEqual(resolveBaseline(testCatalog(), "gpt-6-sol", "medium")?.model, "gpt-6-sol");
  assert.equal(resolveBaseline(testCatalog(), "gpt-6-sol", "ultra"), undefined);
  const noSol = testCatalog([{ model: "gpt-6-sol", requestable: false }]);
  assert.equal(resolveBaseline(noSol, "gpt-6-sol", "medium"), undefined);
});

test("pair requestability expires at its recorded boundary", () => {
  const catalog = testCatalog([{
    model: "gpt-6-sol",
    proof_expires_at: { low: 100, medium: 10, high: 100 },
  }]);
  assert.ok(buildCandidateSet(catalog, {}, 9).pairs.some(pair => pair.model === "gpt-6-sol" && pair.effort === "medium"));
  const expired = buildCandidateSet(catalog, {}, 10);
  assert.ok(!expired.pairs.some(pair => pair.model === "gpt-6-sol" && pair.effort === "medium"));
  assert.ok(expired.excluded.some(pair => pair.model === "gpt-6-sol" && pair.effort === "medium" && pair.reason === "proof_expired"));
  assert.equal(resolveBaseline(catalog, "gpt-6-sol", "medium", 10), undefined);
});
