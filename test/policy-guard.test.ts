import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "../src/policy-guard.js";
import { buildCandidateSet } from "../src/catalog.js";
import { choose, DEFAULT_JEV_POLICY } from "../src/jev-adapter.js";
import { buildRoutingState } from "../src/route-plan.js";
import { choosingTransport, testCatalog } from "./routing-fixtures.js";

async function validDecision(tier: "sol" | "astra" = "sol", constraints = {}) {
  const catalog = testCatalog();
  const set = buildCandidateSet(catalog, constraints);
  const pair = set.pairs.find(p => p.tier === tier);
  assert.ok(pair, `no ${tier} pair in fixture`);
  const state = buildRoutingState({ step_type: "tool_step", known_model_ids: [] }).state;
  return { decision: await choose(state, set, DEFAULT_JEV_POLICY, choosingTransport(pair.pair_id)), set };
}

test("ALLOW returns exactly the selected pair", async () => {
  const { decision, set } = await validDecision();
  const verdict = validate(decision, set, {});
  assert.equal(verdict.verdict, "ALLOW");
});

test("choice outside the candidate set is DENY with no substitute", async () => {
  const { set } = await validDecision();
  const other = buildCandidateSet(testCatalog());
  const decision = { ...(await choose(buildRoutingState({ step_type: "tool_step", known_model_ids: [] }).state,
    other, DEFAULT_JEV_POLICY, choosingTransport(other.pairs[0].pair_id))), chosen_pair_id: "unknown" };
  const verdict = validate(decision, set, {});
  assert.deepEqual(verdict, { verdict: "DENY", reason: "INVALID_DECISION" });
});

test("invalid decision object is DENY", async () => {
  const set = buildCandidateSet(testCatalog());
  const verdict = validate(
    { ...((await validDecision()).decision), valid: false, chosen_pair_id: undefined },
    set, {},
  );
  assert.deepEqual(verdict, { verdict: "DENY", reason: "INVALID_DECISION" });
});

test("user hard constraint denies a Sol selection for a Astra-mandated call", async () => {
  const { decision, set } = await validDecision("sol", { astraAdmitted: true });
  const verdict = validate(decision, set, { forcedModel: "gpt-6-astra" });
  assert.deepEqual(verdict, { verdict: "DENY", reason: "HARD_CONSTRAINT" });
});

test("Astra without admission is DENY, never a silent substitution", async () => {
  const { decision, set } = await validDecision("astra", { astraAdmitted: true });
  const verdict = validate(decision, set, {});
  assert.deepEqual(verdict, { verdict: "DENY", reason: "ASTRA_NOT_ADMITTED" });
});

test("Astra with admission is ALLOW", async () => {
  const { decision, set } = await validDecision("astra", { astraAdmitted: true });
  const verdict = validate(decision, set, { astraAdmitted: true });
  assert.equal(verdict.verdict, "ALLOW");
});

test("version drift between resolved and requested is DENY", async () => {
  const { decision, set } = await validDecision();
  const verdict = validate({ ...decision, jev_resolved_version: "jev-next" }, set, {});
  assert.deepEqual(verdict, { verdict: "DENY", reason: "VERSION_DRIFT" });
});

test("missing resolved version is DENY and never matches the pinned request", async () => {
  const { decision, set } = await validDecision();
  const verdict = validate({ ...decision, jev_resolved_version: "UNKNOWN" }, set, {});
  assert.deepEqual(verdict, { verdict: "DENY", reason: "VERSION_DRIFT" });
});

test("an alias request is DENY even when the response repeats the alias", async () => {
  const { decision, set } = await validDecision();
  const verdict = validate({
    ...decision,
    jev_requested_version: "jev-latest",
    jev_resolved_version: "jev-latest",
  }, set, {});
  assert.deepEqual(verdict, { verdict: "DENY", reason: "VERSION_DRIFT" });
});

test("defense in depth: a privacy-refused decision is DENY", async () => {
  const { decision, set } = await validDecision();
  const verdict = validate(decision, set, {}, true);
  assert.deepEqual(verdict, { verdict: "DENY", reason: "PRIVACY_REFUSAL" });
});
