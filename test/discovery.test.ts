import assert from "node:assert/strict";
import test from "node:test";
import { ModelDiscovery, parsePairProofManifest, type HostModelList, type PairProof } from "../src/discovery.js";
import { buildCandidateSet, deriveCandidateCatalogId, inferTier, resolveBaseline } from "../src/catalog.js";

const NOW = Date.parse("2026-09-23T00:00:00.000Z");
const EDGE = "edge-config-v1";

// Synthetic validation fixture only; these identifiers and digests are not real caller-edge evidence.
function proof(overrides: Partial<PairProof> = {}): PairProof {
  return {
    model: "gpt-6-sol",
    effort: "medium",
    caller_edge_id: EDGE,
    requested_at: "2026-09-22T00:00:00.000Z",
    expires_at: "2026-10-22T00:00:00.000Z",
    http_status: 200,
    response_status: "completed",
    observed_model: "gpt-6-sol",
    observed_effort: "UNKNOWN",
    evidence_artifact_id: "edge-check-2026-09-22-01",
    evidence_sha256: "a".repeat(64),
    evidence_summary: "response_completed_effort_unreported",
    ...overrides,
  };
}

function manifest(proofs: PairProof[], callerEdgeId = EDGE, id = "proof-set-2026-09-22") {
  return parsePairProofManifest({
    version: 1,
    id,
    caller_edge_id: callerEdgeId,
    proofs,
  });
}

async function discover(
  proofs: PairProof[] = [],
  callerEdgeId = EDGE,
  now = NOW,
  sessionId = "session-1",
  models: HostModelList["models"] = [
    { model: "gpt-6-sol", supported_efforts: ["medium", "high"] },
    { model: "gpt-6-luna", supported_efforts: ["max"] },
  ],
) {
  return new ModelDiscovery().discover(sessionId, async () => ({
    source: "caller-edge-model-list",
    models,
  }), manifest(proofs, callerEdgeId), callerEdgeId, now);
}

test("a model listing alone is discovered but cannot make an exact pair requestable", async () => {
  const catalog = await discover();
  assert.equal(catalog.models[0].requestable, false);
  assert.deepEqual(catalog.models[0].supported_efforts, ["medium", "high"]);
  assert.deepEqual(catalog.models[0].proved_efforts, []);
  assert.deepEqual(buildCandidateSet(catalog, { astraAdmitted: true }).pairs, []);
  assert.equal(resolveBaseline(catalog, "gpt-6-sol", "medium", NOW), undefined);
});

test("a successful proof admits only its exact pair and preserves an unobserved effort gap", async () => {
  const catalog = await discover([proof()]);
  assert.deepEqual(catalog.models[0].proved_efforts, ["medium"]);
  assert.deepEqual(buildCandidateSet(catalog, { astraAdmitted: true }).pairs.map(pair => [pair.model, pair.effort]), [
    ["gpt-6-sol", "medium"],
  ]);
  assert.equal(catalog.effortObservationGapCount, 1);
  assert.equal(catalog.proofManifestId, "proof-set-2026-09-22");
  assert.match(catalog.proofManifestDigest, /^[0-9a-f]{64}$/);
});

test("a listed pair rejected by the caller edge remains unproved", async () => {
  const catalog = await discover([proof({
    http_status: 400,
    response_status: "failed",
    evidence_summary: "response_failed",
  })]);
  assert.equal(catalog.models[0].requestable, false);
  assert.deepEqual(buildCandidateSet(catalog, { astraAdmitted: true }).pairs, []);
  assert.ok(catalog.proofExclusions.some(item => item.reason === "request_failed"));
});

test("proofs are scoped to the current caller edge and expiration window", async () => {
  const edgeChanged = await discover([proof()], "edge-config-v2");
  assert.deepEqual(edgeChanged.models[0].proved_efforts, []);
  assert.ok(edgeChanged.proofExclusions.some(item => item.reason === "caller_edge_mismatch"));

  const expired = await discover([proof({ expires_at: "2026-09-22T23:59:59.000Z" })]);
  assert.deepEqual(expired.models[0].proved_efforts, []);
  assert.ok(expired.proofExclusions.some(item => item.reason === "expired"));
});

test("model or effort mismatches cannot prove a requested pair", async () => {
  const modelMismatch = await discover([proof({ observed_model: "gpt-6-luna" })]);
  assert.deepEqual(modelMismatch.models[0].proved_efforts, []);
  assert.ok(modelMismatch.proofExclusions.some(item => item.reason === "model_mismatch"));

  const modelUnknown = await discover([proof({ observed_model: "UNKNOWN" })]);
  assert.deepEqual(modelUnknown.models[0].proved_efforts, []);
  assert.ok(modelUnknown.proofExclusions.some(item => item.reason === "model_mismatch"));

  const effortMismatch = await discover([proof({
    observed_effort: "high",
    evidence_summary: "response_completed_effort_confirmed",
  })]);
  assert.deepEqual(effortMismatch.models[0].proved_efforts, []);
  assert.ok(effortMismatch.proofExclusions.some(item => item.reason === "effort_mismatch"));
});

test("proofs must be unique, discovered, complete, unexpired, and auditable", async () => {
  const duplicate = await discover([proof(), proof()]);
  assert.deepEqual(duplicate.models[0].proved_efforts, []);
  assert.ok(duplicate.proofExclusions.some(item => item.reason === "duplicate_pair"));

  const unlisted = await discover([proof({ model: "gpt-6-luna", effort: "high", observed_model: "gpt-6-luna" })]);
  assert.deepEqual(unlisted.models.find(model => model.model === "gpt-6-luna")?.proved_efforts, []);
  assert.ok(unlisted.proofExclusions.some(item => item.reason === "pair_not_discovered"));

  assert.throws(() => parsePairProofManifest({ version: 1, id: "proof-set", caller_edge_id: EDGE, proofs: [{ ...proof(), request_body: "must not be retained" }] }), /unsupported proof fields/);
});

test("discovery caches only when edge and proof-manifest identity also match", async () => {
  const discovery = new ModelDiscovery();
  let calls = 0;
  const fetchList = async () => {
    calls += 1;
    return { source: "caller-edge-model-list", models: [{ model: "gpt-6-sol", supported_efforts: ["medium"] }] };
  };
  const firstProofs = manifest([proof()]);
  const secondProofs = manifest([proof({ evidence_sha256: "b".repeat(64) })]);
  const first = await discovery.discover("s1", fetchList, firstProofs, EDGE, NOW);
  const same = await discovery.discover("s1", fetchList, firstProofs, EDGE, NOW + 1);
  const changedProof = await discovery.discover("s1", fetchList, secondProofs, EDGE, NOW);
  const changedEdge = await discovery.discover("s1", fetchList, firstProofs, "edge-config-v2", NOW);
  assert.equal(calls, 4); // model-list discovery is read per call; cache output binds evidence
  assert.deepEqual(first, same);
  assert.notEqual(first.session_binding_digest, changedProof.session_binding_digest);
  assert.notEqual(first.session_binding_digest, changedEdge.session_binding_digest);
});

test("candidate catalog identity is stable across session and input ordering, but binds edge and proved evidence", async () => {
  const medium = proof();
  const high = proof({
    effort: "high",
    observed_effort: "high",
    evidence_artifact_id: "edge-check-2026-09-22-02",
    evidence_sha256: "b".repeat(64),
    evidence_summary: "response_completed_effort_confirmed",
  });
  const first = await discover([medium, high]);
  const reordered = await discover(
    [high, medium],
    EDGE,
    NOW + 1,
    "different-session",
    [
      { model: "gpt-6-luna", supported_efforts: ["max"] },
      { model: "gpt-6-sol", supported_efforts: ["high", "medium", "low"] },
    ],
  );
  const id = deriveCandidateCatalogId(first, EDGE, NOW);
  assert.equal(deriveCandidateCatalogId(reordered, EDGE, NOW + 1), id);
  assert.notEqual(deriveCandidateCatalogId(first, "edge-config-v2", NOW), id);

  const removed = await discover([medium]);
  assert.notEqual(deriveCandidateCatalogId(removed, EDGE, NOW), id);
  const refreshed = await discover([medium, proof({
    effort: "high",
    observed_effort: "high",
    evidence_artifact_id: "edge-check-2026-09-22-03",
    evidence_sha256: "c".repeat(64),
    evidence_summary: "response_completed_effort_confirmed",
  })]);
  assert.notEqual(deriveCandidateCatalogId(refreshed, EDGE, NOW), id);

  const expired = await discover([medium, high], EDGE, Date.parse(high.expires_at));
  assert.notEqual(deriveCandidateCatalogId(expired, EDGE, Date.parse(high.expires_at)), id);
});

test("missing effort facts do not invent an effort or candidate", async () => {
  const catalog = await new ModelDiscovery().discover("s1", async () => ({
    source: "app-server",
    models: [{ model: "gpt-6-sol" }],
  }), manifest([]), EDGE, NOW);
  assert.deepEqual(catalog.models[0].supported_efforts, []);
  assert.deepEqual(catalog.models[0].proved_efforts, []);
  assert.deepEqual(buildCandidateSet(catalog).pairs, []);
});

test("non-product models are not catalogued", async () => {
  const catalog = await new ModelDiscovery().discover("s1", async () => ({
    source: "app-server",
    models: [{ model: "some-other-model", supported_efforts: ["low"] }],
  }), manifest([]), EDGE, NOW);
  assert.equal(catalog.models.length, 0);
});

test("tier inference covers the GPT-6 model tiers; removed Terra stays out", () => {
  assert.equal(inferTier("gpt-6-luna"), "luna_max");
  assert.equal(inferTier("gpt-6-sol"), "sol");
  assert.equal(inferTier("gpt-6-astra"), "astra");
  assert.equal(inferTier("gpt-5.6-terra"), undefined);
  assert.equal(inferTier("claude"), undefined);
});
