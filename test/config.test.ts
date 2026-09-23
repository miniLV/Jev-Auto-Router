import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, currentCandidateCatalogId, parseActiveCandidates, parseBaseline } from "../src/index.js";
import { testCatalog } from "./routing-fixtures.js";

const baseEnv = {
  JEV_BASELINE: "gpt-6-luna/max",
  JEV_ACTIVE_CANDIDATES: "gpt-6-luna/max",
  JEV_CONFIDENCE_FLOOR: "0.55",
  JEV_DEADLINE_MS: "2000",
  JEV_UPSTREAM_BASE_URL: "http://127.0.0.1:8788",
  JEV_RELEASE_ID: "release-1",
  JEV_ACTIVE_EVIDENCE_FILE: "/tmp/paired-report.json",
  JEV_CALLER_EDGE_ID: "edge-1",
  JEV_CANDIDATE_CATALOG_ID: "catalog-1",
};

test("the Fallback Baseline is required configuration: no universal default exists", () => {
  assert.throws(() => configFromEnv({}), /JEV_BASELINE/);
  assert.deepEqual(configFromEnv(baseEnv).baseline, { model: "gpt-6-luna", effort: "max" });
  assert.equal(configFromEnv({ ...baseEnv, JEV_PAIR_PROOFS_FILE: "/tmp/pair-proofs.json" }).pairProofsFile, "/tmp/pair-proofs.json");
});

test("the caller-edge URL is required; the router has no direct upstream default", () => {
  assert.throws(
    () => configFromEnv({ JEV_BASELINE: baseEnv.JEV_BASELINE }),
    /JEV_UPSTREAM_BASE_URL.*authenticated.*caller edge/,
  );
});

test("baseline parsing rejects malformed pairs", () => {
  assert.throws(() => parseBaseline("gpt-6-sol"), /<model>\/<effort>/);
  assert.throws(() => parseBaseline("a/b/c"), /<model>\/<effort>/);
  assert.deepEqual(parseBaseline("gpt-6-sol/high"), { model: "gpt-6-sol", effort: "high" });
});

test("Active configuration requires an exact pair allowlist and parses it without duplicates", () => {
  assert.deepEqual(parseActiveCandidates("gpt-6-luna/max,gpt-6-sol/high"), [
    { model: "gpt-6-luna", effort: "max" },
    { model: "gpt-6-sol", effort: "high" },
  ]);
  assert.throws(() => parseActiveCandidates("gpt-6-luna"), /<model>\/<effort>/);
  assert.throws(() => parseActiveCandidates("gpt-6-luna/max,gpt-6-luna/max"), /must not repeat/);
  const { JEV_ACTIVE_CANDIDATES: _discarded, ...withoutCandidates } = baseEnv;
  assert.throws(() => configFromEnv({ ...withoutCandidates, JEV_MODE: "active" }), /JEV_ACTIVE_CANDIDATES/);
  assert.deepEqual(configFromEnv({ ...withoutCandidates, JEV_MODE: "active", JEV_ROUTER_OFF: "1" }).activeCandidates, []);
});

test("Active configuration requires a release-bound evaluation report and edge identifiers", () => {
  assert.throws(() => configFromEnv({ ...baseEnv, JEV_ACTIVE_EVIDENCE_FILE: "", JEV_MODE: "active" }), /JEV_ACTIVE_EVIDENCE_FILE/);
  assert.throws(() => configFromEnv({ ...baseEnv, JEV_RELEASE_ID: "UNKNOWN", JEV_MODE: "active" }), /JEV_RELEASE_ID/);
  assert.throws(() => configFromEnv({ ...baseEnv, JEV_CALLER_EDGE_ID: "UNKNOWN", JEV_MODE: "active" }), /CALLER_EDGE_ID/);
  const { JEV_CANDIDATE_CATALOG_ID: _expected, ...withoutExpectedCatalog } = baseEnv;
  assert.equal(configFromEnv({ ...withoutExpectedCatalog, JEV_MODE: "active" }).candidateCatalogIdExpected, undefined);
  assert.equal(configFromEnv(baseEnv).candidateCatalogIdExpected, "catalog-1");
});

test("JEV_CANDIDATE_CATALOG_ID pins an expectation and cannot define the current catalog", () => {
  const catalog = testCatalog();
  const config = configFromEnv({ ...baseEnv, JEV_CANDIDATE_CATALOG_ID: "" });
  const actual = currentCandidateCatalogId(config, catalog, 1);
  assert.match(actual, /^proved-pairs-v1-[a-f0-9]{64}$/);
  assert.throws(() => currentCandidateCatalogId(configFromEnv(baseEnv), catalog, 1), /does not match/);
  assert.equal(currentCandidateCatalogId({ ...config, candidateCatalogIdExpected: actual }, catalog, 1), actual);
});

test("an evaluation marker cannot bypass the production Active report requirement", () => {
  assert.throws(() => configFromEnv({
    ...baseEnv,
    JEV_MODE: "active",
    JEV_ACTIVE_EVIDENCE_FILE: undefined,
    JEV_EVALUATION_ONLY: "EVALUATION_ONLY",
  }), /JEV_ACTIVE_EVIDENCE_FILE/);
});

test("shadow is the default mode; active must be explicit; other values fail fast", () => {
  assert.equal(configFromEnv(baseEnv).mode, "shadow");
  assert.equal(configFromEnv({ ...baseEnv, JEV_MODE: "active" }).mode, "active");
  assert.throws(() => configFromEnv({ ...baseEnv, JEV_MODE: "turbo" }), /JEV_MODE/);
});

test("OFF is an explicit flag that composes with any mode", () => {
  const config = configFromEnv({ ...baseEnv, JEV_MODE: "active", JEV_ROUTER_OFF: "1" });
  assert.equal(config.routerOff, true);
  assert.equal(config.mode, "active");
});

test("Active requires explicit finite Jev policy values and rejects out-of-range settings", () => {
  for (const variable of ["JEV_CONFIDENCE_FLOOR", "JEV_DEADLINE_MS"] as const) {
    const missing = { ...baseEnv, JEV_MODE: "active", [variable]: undefined };
    assert.throws(() => configFromEnv(missing), new RegExp(`${variable} must be explicitly set`));
  }

  for (const value of ["", "NaN", "Infinity", "-Infinity", "not-a-number"]) {
    assert.throws(
      () => configFromEnv({ ...baseEnv, JEV_MODE: "active", JEV_CONFIDENCE_FLOOR: value }),
      /JEV_CONFIDENCE_FLOOR/,
    );
    assert.throws(
      () => configFromEnv({ ...baseEnv, JEV_MODE: "active", JEV_DEADLINE_MS: value }),
      /JEV_DEADLINE_MS/,
    );
  }

  for (const confidenceFloor of ["-0.01", "1.01"]) {
    assert.throws(() => configFromEnv({ ...baseEnv, JEV_MODE: "active", JEV_CONFIDENCE_FLOOR: confidenceFloor }), /JEV_CONFIDENCE_FLOOR/);
  }
  for (const deadlineMs of ["0", "-1", "1.5", "2147483648"]) {
    assert.throws(() => configFromEnv({ ...baseEnv, JEV_MODE: "active", JEV_DEADLINE_MS: deadlineMs }), /JEV_DEADLINE_MS/);
  }
  assert.equal(configFromEnv({ ...baseEnv, JEV_MODE: "active", JEV_CONFIDENCE_FLOOR: "0", JEV_DEADLINE_MS: "2147483647" }).policy.deadlineMs, 2_147_483_647);
});

test("Shadow defaults are recorded as the effective Jev policy", () => {
  const shadow = configFromEnv({ ...baseEnv, JEV_CONFIDENCE_FLOOR: undefined, JEV_DEADLINE_MS: undefined });
  assert.deepEqual({ confidenceFloor: shadow.policy.confidenceFloor, deadlineMs: shadow.policy.deadlineMs }, {
    confidenceFloor: 0.55,
    deadlineMs: 2_000,
  });
});
