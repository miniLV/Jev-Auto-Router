import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.js";
import { deriveCandidateCatalogId } from "../src/catalog.js";
import { ModelDiscovery, parsePairProofManifest } from "../src/discovery.js";
import { DEFAULT_JEV_POLICY } from "../src/jev-adapter.js";
import { QUESTION_SCHEMA_VERSION } from "../src/route-plan.js";
import { POLICY_VERSION } from "../src/receipt.js";

test("Active discovers the current catalog and rejects a mismatched Jev policy report before listening", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "jev-catalog-startup-"));
  const proofFile = join(tempDir, "proofs.json");
  const missingReportFile = join(tempDir, "missing-report.json");
  const requestedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const proofManifest = {
    version: 1,
    id: "synthetic-test-only",
    caller_edge_id: "edge-startup-test",
    proofs: [{
      model: "gpt-6-sol",
      effort: "medium",
      caller_edge_id: "edge-startup-test",
      requested_at: requestedAt,
      expires_at: expiresAt,
      http_status: 200,
      response_status: "completed",
      observed_model: "gpt-6-sol",
      observed_effort: "medium",
      evidence_artifact_id: "synthetic-startup-test",
      evidence_sha256: "a".repeat(64),
      evidence_summary: "response_completed_effort_confirmed",
    }],
  };
  await writeFile(proofFile, JSON.stringify(proofManifest));

  const keys = [
    "JEV_BASELINE", "JEV_ACTIVE_CANDIDATES", "JEV_UPSTREAM_BASE_URL", "JEV_RELEASE_ID",
    "JEV_ACTIVE_EVIDENCE_FILE", "JEV_CALLER_EDGE_ID", "JEV_CANDIDATE_CATALOG_ID",
    "JEV_PAIR_PROOFS_FILE", "JEV_MODE", "JEV_ROUTER_OFF", "JEV_PORT", "JEV_CONFIDENCE_FLOOR", "JEV_DEADLINE_MS",
  ];
  const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  Object.assign(process.env, {
    JEV_BASELINE: "gpt-6-sol/medium",
    JEV_ACTIVE_CANDIDATES: "gpt-6-sol/medium",
    JEV_UPSTREAM_BASE_URL: "http://caller-edge.test",
    JEV_RELEASE_ID: "release-startup-test",
    JEV_ACTIVE_EVIDENCE_FILE: missingReportFile,
    JEV_CALLER_EDGE_ID: "edge-startup-test",
    JEV_PAIR_PROOFS_FILE: proofFile,
    JEV_MODE: "active",
    JEV_ROUTER_OFF: "",
    JEV_CONFIDENCE_FLOOR: "0.55",
    JEV_DEADLINE_MS: "2000",
    JEV_PORT: "8787",
  });
  delete process.env.JEV_CANDIDATE_CATALOG_ID;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    return new Response(JSON.stringify({ data: [{ id: "gpt-6-sol", supported_efforts: ["medium"] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(main(), /ENOENT/);
    const catalog = await new ModelDiscovery().discover(
      "entry",
      async () => ({ source: "caller-edge", models: [{ model: "gpt-6-sol", supported_efforts: ["medium"] }] }),
      parsePairProofManifest(proofManifest),
      "edge-startup-test",
      Date.now(),
    );
    await writeFile(missingReportFile, JSON.stringify({
      schema_version: "jev-paired-evaluation-report-v2",
      configuration: {
        release: "release-startup-test",
        mode: "active",
        baseline: { model: "gpt-6-sol", effort: "medium" },
        candidates: [{ model: "gpt-6-sol", effort: "medium" }],
        callerEdgeId: "edge-startup-test",
        candidateCatalogId: deriveCandidateCatalogId(catalog, "edge-startup-test"),
        jevVersion: DEFAULT_JEV_POLICY.jevVersion,
        runtimePolicy: { confidenceFloor: 0.56, deadlineMs: 2_000 },
        policyVersion: POLICY_VERSION,
        questionSchemaVersion: QUESTION_SCHEMA_VERSION,
      },
    }));
    await assert.rejects(main(), /runtime policy/);
    assert.deepEqual(fetchCalls, ["http://caller-edge.test/models", "http://caller-edge.test/models"]);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
