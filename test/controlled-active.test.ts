import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { deriveCandidateCatalogId, pairId, type ModelCatalog } from "../src/catalog.js";
import { ModelDiscovery, parsePairProofManifest } from "../src/discovery.js";
import { POLICY_VERSION } from "../src/receipt.js";
import { QUESTION_SCHEMA_VERSION } from "../src/route-plan.js";
import { endpointBindingDigest, startControlledActiveEvaluation } from "../bench/controlled-active.js";
import type { EvaluationPlan } from "../bench/paired-evaluation.js";
import type { HarnessConfig } from "../bench/config.js";

// Stub edge/jev and pair proofs verify the mechanism only; they are not live evidence.
const edgeId = "edge-controlled-test";
const baseline = { model: "gpt-6-sol", effort: "medium" };
const candidate = { model: "gpt-6-luna", effort: "max" };
const jevKey = "test-only-jev-secret";
const models = [
  { id: baseline.model, supported_efforts: [baseline.effort] },
  { id: candidate.model, supported_efforts: [candidate.effort] },
];

interface EdgeCall {
  path: string;
  model?: string;
  effort?: string;
}

async function listen(handler: import("node:http").RequestListener): Promise<Server> {
  return new Promise(resolveListen => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
}

function url(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function bodyOf(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function proof(model: string, effort: string, index: number): Record<string, unknown> {
  return {
    model,
    effort,
    caller_edge_id: edgeId,
    requested_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    http_status: 200,
    response_status: "completed",
    observed_model: model,
    observed_effort: "UNKNOWN",
    evidence_artifact_id: `synthetic-stub-${index}`,
    evidence_sha256: String(index).repeat(64),
    evidence_summary: "response_completed_effort_unreported",
  };
}

function proofManifest(includeCandidate = true): Record<string, unknown> {
  return {
    version: 1,
    id: "synthetic-evaluation-test-only",
    caller_edge_id: edgeId,
    proofs: [proof(baseline.model, baseline.effort, 1), ...(includeCandidate ? [proof(candidate.model, candidate.effort, 2)] : [])],
  };
}

function harnessConfig(candidateCatalog: ModelCatalog, candidateCatalogId: string): HarnessConfig {
  return {
    release: "controlled-test-release",
    mode: "active",
    baseline,
    candidates: [candidate],
    currency: "USD",
    priceSourceRef: "synthetic-test-only",
    callerEdgeId: edgeId,
    candidateCatalog,
    candidateCatalogId,
    jevVersion: "jev-1.13.0",
    policyVersion: POLICY_VERSION,
    questionSchemaVersion: QUESTION_SCHEMA_VERSION,
    runtimePolicy: { confidenceFloor: 0.55, deadlineMs: 2_000 },
    prices: {
      [baseline.model]: { input: 1, cached_input: 0, cache_write_input: 0, output: 1 },
      [candidate.model]: { input: 1, cached_input: 0, cache_write_input: 0, output: 1 },
      "jev-1.13.0": { input: 1, cached_input: 0, cache_write_input: 0, output: 1 },
    },
    cacheConditions: "cold",
  };
}

function taskPlan(revision: string, frozenAt: string, release: string): EvaluationPlan {
  return {
    release,
    frozen_at: frozenAt,
    repository_revision: revision,
    repository_snapshot_digest: "a".repeat(64),
    randomization_seed: "fixture-seed",
    independent_review_method: "fixture-independent-review-v1",
    gates: {
      minimum_quality_score: 4,
      maximum_completion_regression: 0,
      maximum_quality_regression: 0,
      maximum_added_rework_per_task: 0,
      maximum_added_takeover_rate: 0,
      maximum_policy_cost_ratio: 1,
    },
    tasks: [{
      task_id: "opaque-task-1",
      intent_digest: "b".repeat(64),
      snapshot_digest: "c".repeat(64),
      acceptance_id: "opaque-acceptance-1",
      first_arm: "baseline",
      cache_condition: "cold",
    }],
  };
}

interface Fixture {
  directory: string;
  env: NodeJS.ProcessEnv;
  edge: Server;
  jev: Server;
  calls: EdgeCall[];
  modelListCalls: number;
  offerings: string[][];
  jevCalls: number;
  candidateCatalogId: string;
  revision: string;
  now: number;
  close(): Promise<void>;
}

async function fixture(options: { includeCandidateProof?: boolean } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "jev-active-eval-"));
  const calls: EdgeCall[] = [];
  let modelListCalls = 0;
  const offerings: string[][] = [];
  let jevCalls = 0;
  const edge = await listen(async (req, res) => {
    if (req.method === "GET" && req.url === "/models") {
      modelListCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    const request = await bodyOf(req);
    const route = request.reasoning as { effort?: string } | undefined;
    calls.push({ path: req.url ?? "", model: String(request.model), effort: route?.effort });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "stub-response",
      model: request.model,
      reasoning: { effort: route?.effort },
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
  });
  const jev = await listen(async (req, res) => {
    jevCalls += 1;
    const request = await bodyOf(req);
    const choices = request.questions as { route?: { criteria?: Record<string, unknown> } } | undefined;
    const offered = Object.keys(choices?.route?.criteria ?? {});
    offerings.push(offered);
    const choiceId = offered.includes(pairId(candidate.model, candidate.effort)) ? pairId(candidate.model, candidate.effort) : "not-offered";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: choiceId, confidence: 0.95 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    }));
  });
  const edgeUrl = url(edge);
  const jevUrl = url(jev);
  const manifest = proofManifest(options.includeCandidateProof !== false);
  const parsedProofs = parsePairProofManifest(manifest);
  const now = Date.now();
  const catalog = await new ModelDiscovery().discover(
    "controlled-active",
    async () => ({ source: "authenticated-caller-edge:/models", models: models.map(entry => ({ model: entry.id, supported_efforts: entry.supported_efforts })) }),
    parsedProofs,
    edgeId,
    now,
  );
  const revision = "fixture-code-revision";
  const frozenAt = new Date(now - 30_000).toISOString();
  const catalogId = deriveCandidateCatalogId(catalog, edgeId, now);
  const config = harnessConfig(catalog, catalogId);
  const frozen = taskPlan(revision, frozenAt, config.release);
  const controlledPlan = {
    format: "jev-controlled-active-evaluation/1",
    classification: "EVALUATION_ONLY",
    config,
    plan: frozen,
    bindings: {
      upstreamTargetDigest: endpointBindingDigest(edgeUrl),
      jevEndpointTargetDigest: endpointBindingDigest(jevUrl),
      discoveryDigest: catalog.discoveryDigest,
      proofManifestId: catalog.proofManifestId,
      proofManifestDigest: catalog.proofManifestDigest,
    },
  };
  const planFile = join(directory, "plan.json");
  const proofFile = join(directory, "pair-proofs.json");
  await writeFile(planFile, JSON.stringify(controlledPlan));
  await writeFile(proofFile, JSON.stringify(manifest));
  const port = await findPort();
  const env: NodeJS.ProcessEnv = {
    JEV_EVALUATION_ONLY: "EVALUATION_ONLY",
    JEV_EVALUATION_PLAN_FILE: planFile,
    JEV_PAIR_PROOFS_FILE: proofFile,
    JEV_EVALUATION_OUTPUT_DIR: join(directory, "runs"),
    JEV_MODE: "active",
    JEV_PORT: String(port),
    JEV_RELEASE_ID: config.release,
    JEV_BASELINE: `${baseline.model}/${baseline.effort}`,
    JEV_ACTIVE_CANDIDATES: `${candidate.model}/${candidate.effort}`,
    JEV_CALLER_EDGE_ID: edgeId,
    JEV_CANDIDATE_CATALOG_ID: catalogId,
    JEV_VERSION: "jev-1.13.0",
    JEV_CONFIDENCE_FLOOR: "0.55",
    JEV_DEADLINE_MS: "2000",
    JEV_UPSTREAM_BASE_URL: edgeUrl,
    JEV_ENDPOINT: jevUrl,
    JEV_API_KEY: jevKey,
  };
  return {
    directory,
    env,
    edge,
    jev,
    calls,
    get modelListCalls() { return modelListCalls; },
    offerings,
    get jevCalls() { return jevCalls; },
    candidateCatalogId: catalogId,
    revision,
    now,
    close: async () => {
      await Promise.all([close(edge), close(jev)]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function findPort(): Promise<number> {
  const server = await listen((_req, res) => res.end());
  const port = (server.address() as AddressInfo).port;
  await close(server);
  return port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("endpoint bindings retain exact paths and reject embedded secrets or query data", () => {
  const digest = endpointBindingDigest("https://edge.example/v1");
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(digest, endpointBindingDigest("https://edge.example/v1/"));
  for (const value of [
    "https://user:password@edge.example/v1",
    "https://edge.example/v1?api_key=secret",
    "https://edge.example/v1#fragment",
    "file:///tmp/edge",
  ]) assert.throws(() => endpointBindingDigest(value), /endpoint/);
});

test("controlled startup rejects missing evaluation marker before reading a plan or contacting the edge", async () => {
  let revisionChecks = 0;
  await assert.rejects(startControlledActiveEvaluation({}, {
    currentRevision: async () => { revisionChecks += 1; return "unused"; },
  }), /JEV_EVALUATION_ONLY/);
  assert.equal(revisionChecks, 0);
});

test("controlled startup rejects missing required plan, proof, endpoint or credential bindings before discovery", async () => {
  const setup = await fixture();
  try {
    const requiredBindings = [
      "JEV_EVALUATION_PLAN_FILE", "JEV_PAIR_PROOFS_FILE", "JEV_EVALUATION_OUTPUT_DIR", "JEV_API_KEY",
      "JEV_UPSTREAM_BASE_URL", "JEV_ENDPOINT", "JEV_PORT", "JEV_CONFIDENCE_FLOOR", "JEV_DEADLINE_MS",
    ];
    for (const key of requiredBindings) {
      const env = { ...setup.env };
      delete env[key];
      await assert.rejects(startControlledActiveEvaluation(env, {
        currentRevision: async () => setup.revision,
        worktreeClean: async () => true,
        now: () => setup.now,
      }), /./, `${key} is required`);
    }
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup refuses to write run artifacts into the source checkout", async () => {
  const setup = await fixture();
  try {
    setup.env.JEV_EVALUATION_OUTPUT_DIR = join(setup.directory, "runs");
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      cwd: setup.directory,
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /output must be outside/);
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.jevCalls, 0);
    assert.deepEqual(setup.calls, []);
  } finally {
    await setup.close();
  }
});

test("controlled startup rejects an output symlink into the source checkout before caller-edge discovery", async () => {
  const setup = await fixture();
  const aliasDirectory = await mkdtemp(join(tmpdir(), "jev-active-output-link-"));
  try {
    const outputLink = join(aliasDirectory, "runs");
    await symlink(setup.directory, outputLink);
    setup.env.JEV_EVALUATION_OUTPUT_DIR = outputLink;
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      cwd: setup.directory,
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /output must be outside/);
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.jevCalls, 0);
    assert.deepEqual(setup.calls, []);
  } finally {
    await rm(aliasDirectory, { recursive: true, force: true });
    await setup.close();
  }
});

test("controlled startup rejects missing or conflicting process bindings before caller-edge discovery", async () => {
  const setup = await fixture();
  try {
    const invalidEnvironments: Array<[string, string | undefined]> = [
      ["JEV_MODE", "shadow"],
      ["JEV_ROUTER_OFF", "1"],
      ["JEV_PORT", "0"],
      ["JEV_BASELINE", `${candidate.model}/${candidate.effort}`],
      ["JEV_RELEASE_ID", "other-release"],
      ["JEV_VERSION", "jev-1.13.1"],
      ["JEV_CALLER_EDGE_ID", "other-edge"],
      ["JEV_UPSTREAM_BASE_URL", `${setup.env.JEV_UPSTREAM_BASE_URL}/different`],
      ["JEV_ENDPOINT", `${setup.env.JEV_ENDPOINT}/different`],
      ["JEV_CONFIDENCE_FLOOR", "not-a-number"],
      ["JEV_DEADLINE_MS", "NaN"],
      ["JEV_ACTIVE_EVIDENCE_FILE", ""],
    ];
    for (const [key, value] of invalidEnvironments) {
      const env = { ...setup.env, [key]: value };
      await assert.rejects(startControlledActiveEvaluation(env, {
        currentRevision: async () => setup.revision,
        worktreeClean: async () => true,
        now: () => setup.now,
      }), /./, `${key} should be rejected`);
    }
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup treats the environment catalog ID only as an expected value", async () => {
  const setup = await fixture();
  try {
    setup.env.JEV_CANDIDATE_CATALOG_ID = "other-catalog";
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /frozen candidate catalog ID/);
    assert.equal(setup.modelListCalls, 0);
    assert.deepEqual(setup.calls, []);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup rejects a hand-assigned catalog ID in the frozen HarnessConfig", async () => {
  const setup = await fixture();
  try {
    const plan = await readJson(setup.env.JEV_EVALUATION_PLAN_FILE as string);
    (plan.config as { candidateCatalogId: string }).candidateCatalogId = "manual-catalog-label";
    await writeFile(setup.env.JEV_EVALUATION_PLAN_FILE as string, JSON.stringify(plan));
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /frozen candidate catalog ID/);
    assert.equal(setup.modelListCalls, 0);
    assert.deepEqual(setup.calls, []);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup rejects a changed source revision or dirty checkout before caller-edge discovery", async () => {
  const setup = await fixture();
  try {
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => "different-revision",
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /repository revision/);
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => false,
      now: () => setup.now,
    }), /clean source worktree/);
    assert.equal(setup.modelListCalls, 0);
    assert.deepEqual(setup.calls, []);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup verifies the requested listener port before caller-edge discovery", async () => {
  const setup = await fixture();
  const occupied = await listen((_req, res) => res.end());
  try {
    setup.env.JEV_PORT = String((occupied.address() as AddressInfo).port);
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }));
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.jevCalls, 0);
    assert.deepEqual(setup.calls, []);
  } finally {
    await close(occupied);
    await setup.close();
  }
});

test("controlled startup rejects malformed frozen task identifiers and proof-edge mismatches before inference", async () => {
  const setup = await fixture();
  try {
    const plan = await readJson(setup.env.JEV_EVALUATION_PLAN_FILE as string);
    const frozenPlan = plan.plan as { tasks: Array<{ task_id: string }> };
    frozenPlan.tasks[0].task_id = "invalid/task-id";
    await writeFile(setup.env.JEV_EVALUATION_PLAN_FILE as string, JSON.stringify(plan));
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /frozen task has invalid identifiers/);
    assert.equal(setup.modelListCalls, 0);

    const valid = await fixture();
    try {
      const proofs = proofManifest();
      proofs.caller_edge_id = "another-edge";
      await writeFile(valid.env.JEV_PAIR_PROOFS_FILE as string, JSON.stringify(proofs));
      await assert.rejects(startControlledActiveEvaluation(valid.env, {
        currentRevision: async () => valid.revision,
        worktreeClean: async () => true,
        now: () => valid.now,
      }), /caller-edge ID does not match/);
      assert.equal(valid.modelListCalls, 0);
      assert.equal(valid.jevCalls, 0);

      const differentManifest = proofManifest();
      differentManifest.id = "tampered-manifest";
      await writeFile(valid.env.JEV_PAIR_PROOFS_FILE as string, JSON.stringify(differentManifest));
      await assert.rejects(startControlledActiveEvaluation(valid.env, {
        currentRevision: async () => valid.revision,
        worktreeClean: async () => true,
        now: () => valid.now,
      }), /proof manifest does not match the frozen plan binding/);
      assert.equal(valid.modelListCalls, 0);
      assert.equal(valid.jevCalls, 0);
    } finally {
      await valid.close();
    }
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup rejects changed candidates before any caller-edge or Jev request", async () => {
  const setup = await fixture();
  try {
    setup.env.JEV_ACTIVE_CANDIDATES = `${baseline.model}/${baseline.effort}`;
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /do not match the frozen candidate list/);
    assert.deepEqual(setup.calls, []);
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup rejects malformed frozen runtime policy before discovery", async () => {
  const setup = await fixture();
  try {
    const original = await readJson(setup.env.JEV_EVALUATION_PLAN_FILE as string);
    const invalidPolicies = [
      { confidenceFloor: -0.01, deadlineMs: 2_000 },
      { confidenceFloor: 1.01, deadlineMs: 2_000 },
      { confidenceFloor: 0.55, deadlineMs: 2_000.5 },
      { confidenceFloor: 0.55, deadlineMs: 2_147_483_648 },
      { confidenceFloor: 0.55 },
    ];
    for (const runtimePolicy of invalidPolicies) {
      const plan = structuredClone(original);
      const config = plan.config as Record<string, unknown>;
      config.runtimePolicy = runtimePolicy;
      await writeFile(setup.env.JEV_EVALUATION_PLAN_FILE as string, JSON.stringify(plan));
      await assert.rejects(startControlledActiveEvaluation(setup.env, {
        currentRevision: async () => setup.revision,
        worktreeClean: async () => true,
        now: () => setup.now,
      }), /runtime Jev policy/);
    }
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.jevCalls, 0);
    assert.deepEqual(setup.calls, []);
  } finally {
    await setup.close();
  }
});

test("controlled startup applies the frozen zero-confidence policy instead of a parser default", async () => {
  const setup = await fixture();
  let run: Awaited<ReturnType<typeof startControlledActiveEvaluation>> | undefined;
  try {
    const plan = await readJson(setup.env.JEV_EVALUATION_PLAN_FILE as string);
    (plan.config as { runtimePolicy: { confidenceFloor: number } }).runtimePolicy.confidenceFloor = 0;
    await writeFile(setup.env.JEV_EVALUATION_PLAN_FILE as string, JSON.stringify(plan));
    setup.env.JEV_CONFIDENCE_FLOOR = "0";
    run = await startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    });
    assert.equal(run.config.policy.confidenceFloor, 0);
    await run.stop();
  } finally {
    if (run) await run.stop();
    await setup.close();
  }
});

test("controlled startup rejects a candidate absent from the current proof manifest before inference", async () => {
  const setup = await fixture({ includeCandidateProof: false });
  try {
    await assert.rejects(startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    }), /current proved candidate catalog|current exact-pair proof/);
    assert.deepEqual(setup.calls, []);
    assert.equal(setup.modelListCalls, 0);
    assert.equal(setup.jevCalls, 0);
  } finally {
    await setup.close();
  }
});

test("controlled startup serves the exact frozen Active pair on loopback and saves only EVALUATION_ONLY artifacts", async () => {
  const setup = await fixture();
  let run: Awaited<ReturnType<typeof startControlledActiveEvaluation>> | undefined;
  try {
    run = await startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    });
    const address = run.server.address() as AddressInfo;
    assert.equal(address.address, "127.0.0.1");
    const choice = pairId(candidate.model, candidate.effort);

    const unplannedTask = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jev-step": "user_turn", "x-jev-task-id": "not-in-frozen-plan" },
      body: JSON.stringify({ model: "jev/auto", input: [{ role: "user", content: "must not be routed" }] }),
    });
    assert.equal(unplannedTask.status, 403);
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.jevCalls, 0);

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jev-step": "user_turn",
        "x-jev-task-id": "opaque-task-1",
        "x-jev-evaluation-only": "false",
        "x-jev-active-candidates": `${baseline.model}/${baseline.effort}`,
      },
      body: JSON.stringify({ model: "jev/auto", input: [{ role: "user", content: "synthetic private prompt text" }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { model?: string; reasoning?: { effort?: string } };
    assert.deepEqual({ model: payload.model, effort: payload.reasoning?.effort }, candidate);
    assert.equal(setup.jevCalls, 1);
    assert.deepEqual(setup.offerings, [[choice]]);
    assert.deepEqual(setup.calls.map(call => [call.path, call.model, call.effort]), [
      ["/v1/responses", candidate.model, candidate.effort],
    ]);

    await run.stop();
    const manifest = await readJson(run.manifestPath);
    const observations = await readJson(join(dirname(run.manifestPath), "observations.json"));
    assert.equal(manifest.classification, "EVALUATION_ONLY");
    assert.equal(manifest.status, "STOPPED");
    assert.equal((manifest.runtime as { candidates: Array<{ model: string; effort: string }> }).candidates.length, 1);
    assert.equal((manifest.runtime as { candidateCatalogId: string }).candidateCatalogId, setup.candidateCatalogId);
    assert.deepEqual((manifest.runtime as { runtimePolicy: unknown }).runtimePolicy, { confidenceFloor: 0.55, deadlineMs: 2_000 });
    assert.equal(observations.classification, "EVALUATION_ONLY");
    const saved = `${JSON.stringify(manifest)}${JSON.stringify(observations)}`;
    assert.equal(saved.includes(jevKey), false);
    assert.equal(saved.includes(setup.env.JEV_ENDPOINT as string), false);
    assert.equal(saved.includes(setup.env.JEV_UPSTREAM_BASE_URL as string), false);
    assert.equal(saved.includes("synthetic private prompt text"), false);
    assert.equal(saved.includes("opaque-task-1"), false);
    assert.equal("pairing_gate" in observations, false);
  } finally {
    if (run) await run.stop();
    await setup.close();
  }
});

test("controlled stop marks the run failed when it cannot save observations", async () => {
  const setup = await fixture();
  let run: Awaited<ReturnType<typeof startControlledActiveEvaluation>> | undefined;
  try {
    run = await startControlledActiveEvaluation(setup.env, {
      currentRevision: async () => setup.revision,
      worktreeClean: async () => true,
      now: () => setup.now,
    });
    await writeFile(join(dirname(run.manifestPath), "observations.json"), "occupied");
    await assert.rejects(run.stop(), /unable to write the sanitized EVALUATION_ONLY observations artifact/);
    const manifest = await readJson(run.manifestPath);
    assert.equal(manifest.status, "STOP_FAILED");
  } finally {
    if (run) await run.stop();
    await setup.close();
  }
});
