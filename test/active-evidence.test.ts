import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateActiveEvidence } from "../src/active-evidence.js";
import { digest } from "../src/canonical.js";
import { deriveCandidateCatalogId, type ModelEffortPair } from "../src/catalog.js";
import { priceWeightsDigest, type HarnessConfig } from "../bench/config.js";
import { pairedComparison, type CandidateEvaluation, type EvaluationArm, type EvaluationPlan, type EvaluationCall, type PairedTask, type ShadowTaskEvaluation } from "../bench/paired-evaluation.js";
import { testCatalog } from "./routing-fixtures.js";

const catalog = testCatalog();
const candidate = { model: "gpt-6-luna", effort: "max" };
const secondCandidate = { model: "gpt-6-luna", effort: "medium" };
const baseline = { model: "gpt-6-sol", effort: "medium" };
const config: HarnessConfig = {
  release: "fixture-release",
  mode: "active",
  baseline,
  candidates: [candidate],
  currency: "USD",
  priceSourceRef: "fixture-only",
  callerEdgeId: "edge-1",
  candidateCatalog: catalog,
  candidateCatalogId: deriveCandidateCatalogId(catalog, "edge-1", 1),
  jevVersion: "jev-1.13.0",
  runtimePolicy: { confidenceFloor: 0.55, deadlineMs: 2_000 },
  policyVersion: "policy-1",
  questionSchemaVersion: "question-1",
  cacheConditions: "declared-per-task",
  prices: {
    "gpt-6-sol": { input: 1, cached_input: 0.2, cache_write_input: 1, output: 2 },
    "gpt-6-luna": { input: 0.2, cached_input: 0.1, cache_write_input: 0.2, output: 1 },
    "jev-1.13.0": { input: 0.04, cached_input: 0.01, cache_write_input: 0.05, output: 0.1 },
  },
};
const plan: EvaluationPlan = {
  release: config.release,
  frozen_at: "2026-09-20T00:00:00.000Z",
  repository_revision: "fixture-commit",
  repository_snapshot_digest: "repo-snapshot",
  randomization_seed: "seed-1",
  independent_review_method: "review-v1",
  gates: {
    minimum_quality_score: 4,
    maximum_completion_regression: 0,
    maximum_quality_regression: 0,
    maximum_added_rework_per_task: 0,
    maximum_added_takeover_rate: 0,
    maximum_policy_cost_ratio: 0.95,
  },
  tasks: ["t1", "t2"].map((task_id, index) => ({
    task_id,
    intent_digest: `${task_id}-intent`,
    snapshot_digest: `${task_id}-snapshot`,
    acceptance_id: `${task_id}-acceptance`,
    first_arm: index === 0 ? "baseline" as const : "policy" as const,
    cache_condition: "warm" as const,
  })),
};
const runtime = {
  releaseId: config.release,
  baseline,
  activeCandidates: [candidate],
  callerEdgeId: config.callerEdgeId,
  candidateCatalogId: config.candidateCatalogId,
  jevVersion: config.jevVersion,
  runtimePolicy: config.runtimePolicy,
  policyVersion: config.policyVersion,
  questionSchemaVersion: config.questionSchemaVersion,
};

type AssetKind = "transport" | "cancellation" | "shadow" | "diff" | "test";
interface AssetFacts {
  requested_pair?: ModelEffortPair;
  observed_model?: string | null;
  observed_effort?: string;
  first_event_before_completion?: boolean;
  phase?: "jev_wait" | "upstream_generation";
  cancelled?: boolean;
  replayed?: boolean;
  fallback_started?: boolean;
  mode?: "shadow";
  proposed_pair?: ModelEffortPair;
  executed_pair?: ModelEffortPair;
  task_id?: string;
  arm?: "baseline" | "policy" | "shadow";
  acceptance_id?: string;
  review_method?: string;
  quality_score?: number;
  completed?: boolean;
  accepted?: boolean;
  rework_cycles?: number;
  root_takeover?: boolean;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeRef(kind: string, label: string): string {
  return `${kind}:sha256:${sha256(Buffer.from(label))}`;
}

function call(kind: EvaluationCall["kind"], model: string, effort: string, evaluationConfig = config): EvaluationCall {
  return {
    kind,
    model,
    effort,
    ...(kind === "jev" ? { runtimePolicy: evaluationConfig.runtimePolicy } : {}),
    usage: { input_tokens: 1_000, cached_input_tokens: 100, cache_write_input_tokens: 50, output_tokens: 100, reasoning_tokens: 20 },
  };
}

function fakeArm(taskId: string, armName: "baseline" | "policy", pair = candidate, evaluationConfig = config): EvaluationArm {
  const frozen = plan.tasks.find(task => task.task_id === taskId)!;
  const baseline = armName === "baseline";
  const started = frozen.first_arm === "baseline" ? baseline ? "01" : "02" : baseline ? "02" : "01";
  return {
    started_at: `2026-09-20T00:00:${started}.000Z`,
    intent_digest: frozen.intent_digest,
    snapshot_digest: frozen.snapshot_digest,
    acceptance_id: frozen.acceptance_id,
    cache_condition: frozen.cache_condition,
    completed: true,
    accepted: true,
    quality_score: 4.5,
    quality_evidence_refs: [fakeRef("diff", `${taskId}:${armName}:diff`), fakeRef("test", `${taskId}:${armName}:test`)],
    rework_cycles: 0,
    root_takeover: false,
    elapsed_ms: baseline ? 1_000 : 900,
    caller_edge_cost: 0,
    calls: baseline ? [call("upstream", baselinePair.model, baselinePair.effort, evaluationConfig)] : [
      call("upstream", pair.model, pair.effort, evaluationConfig),
      call("jev", evaluationConfig.jevVersion, "UNKNOWN", evaluationConfig),
    ],
  };
}

const baselinePair = baseline;

function pairedTasks(pair = candidate, evaluationConfig = config): PairedTask[] {
  return plan.tasks.map(task => ({
    task_id: task.task_id,
    first_arm: task.first_arm,
    baseline: fakeArm(task.task_id, "baseline", pair, evaluationConfig),
    policy: fakeArm(task.task_id, "policy", pair, evaluationConfig),
  }));
}

function shadowTasks(pair = candidate, evaluationConfig = config): ShadowTaskEvaluation[] {
  return plan.tasks.map(task => ({
    task_id: task.task_id,
    proposed_pair: pair,
    run: {
      ...fakeArm(task.task_id, "baseline", pair, evaluationConfig),
      started_at: "2026-09-20T00:00:03.000Z",
      quality_evidence_refs: [],
      elapsed_ms: 1_100,
      calls: [call("upstream", baseline.model, baseline.effort, evaluationConfig), call("jev", evaluationConfig.jevVersion, "UNKNOWN", evaluationConfig)],
    },
  }));
}

function candidateEvidence(pair = candidate, evaluationConfig = config): CandidateEvaluation[] {
  return [{
    pair,
    binding: {
      release: evaluationConfig.release,
      callerEdgeId: evaluationConfig.callerEdgeId,
      candidateCatalogId: evaluationConfig.candidateCatalogId,
      jevVersion: evaluationConfig.jevVersion,
      runtimePolicy: evaluationConfig.runtimePolicy,
      policyVersion: evaluationConfig.policyVersion,
      questionSchemaVersion: evaluationConfig.questionSchemaVersion,
      priceWeightsDigest: priceWeightsDigest(evaluationConfig),
    },
    transport: "PASS",
    cancellation: "PASS",
    shadow: "PASS",
    evidence_refs: { transport: [], cancellation: [], shadow: [] },
    shadow_tasks: [],
    paired_tasks: [],
  }];
}

function evidenceData(
  evaluationConfig = config,
  candidatePairs = evaluationConfig.candidates,
  observedModel?: string | null,
  observedEffort?: string,
): { evaluations: CandidateEvaluation[]; assets: Array<Record<string, unknown>> } {
  const evaluations = candidatePairs.map(pair => candidateEvidence(pair, evaluationConfig)[0]);
  const configDigest = digest(evaluationConfig);
  const assets: Array<Record<string, unknown>> = [];
  const addAsset = (kind: AssetKind, associationId: string, facts: AssetFacts, candidateId: string | null): string => {
    const schemaVersion = kind === "transport" || kind === "cancellation" || kind === "shadow"
      ? `jev-${kind}-evidence-v1`
      : "jev-quality-evidence-v1";
    const doc = { schema_version: schemaVersion, kind, release_id: evaluationConfig.release, candidate_id: candidateId,
      configuration_digest: configDigest, association_id: associationId, facts };
    const bytes = Buffer.from(JSON.stringify(doc));
    const ref = `${kind}:sha256:${sha256(bytes)}`;
    if (assets.some(asset => asset.ref === ref)) return ref;
    const id = `asset-${assets.length}`;
    assets.push({ id, ...doc, ref, path: `assets/${id}.json`, sha256: sha256(bytes) });
    return ref;
  };
  for (const item of evaluations) {
    const pair = item.pair;
    const candidateId = `${pair.model}/${pair.effort}`;
    const gateAssociation = (kind: "transport" | "cancellation" | "shadow") => `${candidateId}:gate:${kind}`;
    item.evidence_refs.transport = [addAsset("transport", gateAssociation("transport"), {
      requested_pair: pair, observed_model: observedModel === undefined ? pair.model : observedModel,
      observed_effort: observedEffort ?? pair.effort, first_event_before_completion: true,
    }, candidateId)];
    item.evidence_refs.cancellation = [
      addAsset("cancellation", gateAssociation("cancellation"), { phase: "jev_wait", cancelled: true, replayed: false, fallback_started: false }, candidateId),
      addAsset("cancellation", gateAssociation("cancellation"), { phase: "upstream_generation", cancelled: true, replayed: false, fallback_started: false }, candidateId),
    ];
    item.evidence_refs.shadow = [addAsset("shadow", gateAssociation("shadow"), { mode: "shadow", proposed_pair: pair, executed_pair: baseline }, candidateId)];
    item.paired_tasks = plan.tasks.map(task => ({
      task_id: task.task_id,
      first_arm: task.first_arm,
      baseline: fakeArm(task.task_id, "baseline", pair, evaluationConfig),
      policy: fakeArm(task.task_id, "policy", pair, evaluationConfig),
    }));
    item.shadow_tasks = shadowTasks(pair, evaluationConfig);
    for (const task of item.paired_tasks) {
      for (const [armName, run] of [["baseline", task.baseline], ["policy", task.policy]] as const) {
        const sharedBaseline = armName === "baseline";
        const associationId = `${sharedBaseline ? "run" : candidateId}:task:${task.task_id}:${armName}`;
        run.quality_evidence_refs = [];
        for (const kind of ["diff", "test"] as const) {
          run.quality_evidence_refs.push(addAsset(kind, associationId, {
            task_id: task.task_id, arm: armName, acceptance_id: run.acceptance_id,
            review_method: plan.independent_review_method, quality_score: run.quality_score as number,
            completed: run.completed, accepted: run.accepted, rework_cycles: run.rework_cycles, root_takeover: run.root_takeover,
          }, sharedBaseline ? null : candidateId));
        }
      }
    }
    for (const task of item.shadow_tasks) {
      const associationId = `${candidateId}:task:${task.task_id}:shadow`;
      task.run.quality_evidence_refs = [];
      for (const kind of ["diff", "test"] as const) {
        task.run.quality_evidence_refs.push(addAsset(kind, associationId, {
          task_id: task.task_id, arm: "shadow", acceptance_id: plan.tasks.find(entry => entry.task_id === task.task_id)!.acceptance_id,
          review_method: plan.independent_review_method, quality_score: task.run.quality_score as number,
          completed: task.run.completed, accepted: task.run.accepted, rework_cycles: task.run.rework_cycles, root_takeover: task.run.root_takeover,
        }, candidateId));
      }
    }
  }
  return { evaluations, assets };
}

async function fixture(
  t: TestContext,
  evaluationConfig = config,
  observedModel?: string | null,
  observedEffort?: string,
): Promise<{ report: Record<string, unknown>; reportPath: string; bundlePath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "jev-active-evidence-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const assetsDir = join(root, "assets");
  await mkdir(assetsDir);
  const { evaluations, assets } = evidenceData(evaluationConfig, evaluationConfig.candidates, observedModel, observedEffort);
  const manifest = [];
  for (const asset of assets) {
    const path = asset.path as string;
    await writeFile(join(root, path as string), JSON.stringify({
      schema_version: asset.schema_version,
      kind: asset.kind,
      release_id: asset.release_id,
      candidate_id: asset.candidate_id,
      configuration_digest: asset.configuration_digest,
      association_id: asset.association_id,
      facts: asset.facts,
    }));
    manifest.push({
      id: asset.id,
      ref: asset.ref,
      path,
      sha256: asset.sha256,
      kind: asset.kind,
      schema_version: asset.schema_version,
      release_id: asset.release_id,
      candidate_id: asset.candidate_id,
      configuration_digest: asset.configuration_digest,
      association_id: asset.association_id,
    });
  }
  const bundle = {
    schema_version: "jev-active-evaluation-bundle-v1",
    config: evaluationConfig,
    plan,
    tasks: pairedTasks(evaluationConfig.candidates[0], evaluationConfig),
    candidate_evaluations: evaluations,
    evidence_manifest: manifest,
  };
  const bundlePath = join(root, "bundle.json");
  const bundleBytes = Buffer.from(JSON.stringify(bundle));
  await writeFile(bundlePath, bundleBytes);
  const report = {
    ...pairedComparison(evaluationConfig, plan, bundle.tasks, evaluations),
    schema_version: "jev-paired-evaluation-report-v2",
    active_evidence_bundle: {
      schema_version: "jev-active-evaluation-bundle-v1",
      path: "bundle.json",
      sha256: sha256(bundleBytes),
    },
  } as unknown as Record<string, unknown>;
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  return { report, reportPath, bundlePath, root };
}

async function refreshReport(data: { report: Record<string, unknown>; reportPath: string; bundlePath: string }): Promise<void> {
  const bundleBytes = await readFile(data.bundlePath);
  const bundle = JSON.parse(bundleBytes.toString("utf8")) as Record<string, unknown>;
  const evaluationConfig = bundle.config as HarnessConfig;
  const report = {
    ...pairedComparison(
      evaluationConfig,
      bundle.plan as EvaluationPlan,
      bundle.tasks as PairedTask[],
      bundle.candidate_evaluations as CandidateEvaluation[],
    ),
    active_evidence_bundle: {
      schema_version: "jev-active-evaluation-bundle-v1",
      path: "bundle.json",
      sha256: sha256(bundleBytes),
    },
  } as unknown as Record<string, unknown>;
  data.report = report;
  await writeFile(data.reportPath, JSON.stringify(report));
}

async function replaceBundle(root: string, report: Record<string, unknown>, edit: (bundle: Record<string, unknown>) => void): Promise<void> {
  const bundlePath = join(root, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
  edit(bundle);
  const bytes = Buffer.from(JSON.stringify(bundle));
  await writeFile(bundlePath, bytes);
  (report.active_evidence_bundle as Record<string, unknown>).sha256 = sha256(bytes);
  await writeFile(join(root, "report.json"), JSON.stringify(report));
}

test("Active accepts a complete synthetic evidence bundle bound to the current runtime", async t => {
  const data = await fixture(t);
  await assert.doesNotReject(validateActiveEvidence(data.report, runtime, data.reportPath));
});

test("the evaluator saves a report with a relative path and raw-byte bundle digest", async t => {
  const data = await fixture(t);
  const evaluator = join(__dirname, "../bench/evaluate.js");
  const result = spawnSync(process.execPath, [evaluator, data.bundlePath, "--report", data.reportPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(data.reportPath, "utf8")) as Record<string, unknown>;
  const bundleRef = report.active_evidence_bundle as Record<string, unknown>;
  assert.equal(bundleRef.path, "bundle.json");
  assert.equal(bundleRef.sha256, sha256(await readFile(data.bundlePath)));
  await assert.doesNotReject(validateActiveEvidence(report, runtime, data.reportPath));
});

test("Active rejects transport PASS evidence without observing the requested candidate model", async t => {
  const data = await fixture(t, config, null);
  await assert.rejects(validateActiveEvidence(data.report, runtime, data.reportPath), /transport evidence facts/);
});

test("Active accepts an observed candidate model when the observed effort is explicitly unknown", async t => {
  const data = await fixture(t, config, undefined, "UNKNOWN");
  await assert.doesNotReject(validateActiveEvidence(data.report, runtime, data.reportPath));
});

test("Active accepts two fully evidenced candidates sharing the same baseline quality assets", async t => {
  const multiConfig = { ...config, candidates: [candidate, secondCandidate] };
  const data = await fixture(t, multiConfig);
  const multiRuntime = { ...runtime, activeCandidates: [candidate, secondCandidate] };
  const bundle = JSON.parse(await readFile(data.bundlePath, "utf8")) as { evidence_manifest: Array<{ candidate_id: string | null; association_id: string }> };
  assert.equal(bundle.evidence_manifest.filter(asset => asset.candidate_id === null && asset.association_id.endsWith(":baseline")).length, 4);
  await assert.doesNotReject(validateActiveEvidence(data.report, multiRuntime, data.reportPath));
});

test("Active rejects a shared baseline reference when its task facts diverge between candidates", async t => {
  const multiConfig = { ...config, candidates: [candidate, secondCandidate] };
  const data = await fixture(t, multiConfig);
  await replaceBundle(data.root, data.report, bundle => {
    const evaluations = bundle.candidate_evaluations as Array<Record<string, unknown>>;
    const tasks = evaluations[1].paired_tasks as Array<Record<string, unknown>>;
    const baselineRun = tasks[0].baseline as Record<string, unknown>;
    baselineRun.quality_score = 4.25;
  });
  await assert.rejects(validateActiveEvidence(data.report, runtime, data.reportPath), /reused across different run associations/);
});

test("An ineligible candidate with missing evidence does not block a different approved candidate", async t => {
  const multiConfig = { ...config, candidates: [candidate, secondCandidate] };
  const data = await fixture(t, multiConfig);
  await replaceBundle(data.root, data.report, bundle => {
    const evaluations = bundle.candidate_evaluations as Array<Record<string, unknown>>;
    evaluations[1].evidence_refs = { transport: [], cancellation: [], shadow: [] };
    evaluations[1].paired_tasks = [];
    evaluations[1].shadow_tasks = [];
    const manifest = bundle.evidence_manifest as Array<Record<string, unknown>>;
    bundle.evidence_manifest = manifest.filter(asset => asset.candidate_id !== `${secondCandidate.model}/${secondCandidate.effort}`);
  });
  await refreshReport(data);
  assert.deepEqual(data.report.active_candidate_allowlist, ["gpt-6-luna/max"]);
  await assert.doesNotReject(validateActiveEvidence(data.report, runtime, data.reportPath));
});

test("Active recalculates the evaluation and rejects a hand-edited PASS", async t => {
  const data = await fixture(t);
  await replaceBundle(data.root, data.report, bundle => {
    const evaluations = bundle.candidate_evaluations as Array<Record<string, unknown>>;
    evaluations[0].transport = "FAIL";
  });
  await refreshReport(data);
  const decisions = data.report.candidate_decisions as Array<Record<string, unknown>>;
  decisions[0].transport = "PASS";
  decisions[0].active_eligible = true;
  decisions[0].blockers = [];
  data.report.active_candidate_allowlist = ["gpt-6-luna/max"];
  await assert.rejects(validateActiveEvidence(data.report, runtime, data.reportPath), /does not match the paired evaluation bundle/);
});

test("Active rejects missing and byte-modified evidence assets without revealing their contents", async t => {
  const changedBundle = await fixture(t);
  await writeFile(changedBundle.bundlePath, `${await readFile(changedBundle.bundlePath, "utf8")} `);
  await assert.rejects(validateActiveEvidence(changedBundle.report, runtime, changedBundle.reportPath), /bundle digest/);

  const missing = await fixture(t);
  const manifest = JSON.parse(await readFile(missing.bundlePath, "utf8")) as { evidence_manifest: Array<{ path: string }> };
  await rm(join(missing.root, manifest.evidence_manifest[0].path));
  await assert.rejects(validateActiveEvidence(missing.report, runtime, missing.reportPath), /evidence asset/);

  const changed = await fixture(t);
  const changedManifest = JSON.parse(await readFile(changed.bundlePath, "utf8")) as { evidence_manifest: Array<{ path: string }> };
  await writeFile(join(changed.root, changedManifest.evidence_manifest[0].path), "private-prompt-tool-output-secret");
  await assert.rejects(async () => {
    await validateActiveEvidence(changed.report, runtime, changed.reportPath);
  }, error => {
    assert.match(String(error), /evidence asset/);
    assert.doesNotMatch(String(error), /private-prompt-tool-output-secret/);
    return true;
  });
});

test("Active rejects path traversal and symlink escapes in the evidence manifest", async t => {
  const bundleTraversal = await fixture(t);
  (bundleTraversal.report.active_evidence_bundle as Record<string, unknown>).path = "../bundle.json";
  await assert.rejects(validateActiveEvidence(bundleTraversal.report, runtime, bundleTraversal.reportPath), /evaluation bundle path/);

  const traversal = await fixture(t);
  await replaceBundle(traversal.root, traversal.report, bundle => {
    const assets = bundle.evidence_manifest as Array<Record<string, unknown>>;
    assets[0].path = "../secret.json";
  });
  await assert.rejects(validateActiveEvidence(traversal.report, runtime, traversal.reportPath), /relative path/);

  const symlink = await fixture(t);
  const manifest = JSON.parse(await readFile(symlink.bundlePath, "utf8")) as { evidence_manifest: Array<{ path: string }> };
  const outside = join(symlink.root, "..", "outside-evidence.json");
  await writeFile(outside, "opaque outside asset");
  await rm(join(symlink.root, manifest.evidence_manifest[0].path));
  const { symlink: makeSymlink } = await import("node:fs/promises");
  await makeSymlink(outside, join(symlink.root, manifest.evidence_manifest[0].path));
  await assert.rejects(validateActiveEvidence(symlink.report, runtime, symlink.reportPath), /evidence asset/);
  await rm(outside, { force: true });
});

test("Active rejects the right asset hash bound to another candidate or config", async t => {
  const data = await fixture(t);
  await replaceBundle(data.root, data.report, bundle => {
    const entries = bundle.evidence_manifest as Array<Record<string, unknown>>;
    entries[0].candidate_id = "gpt-6-luna/medium";
  });
  await assert.rejects(validateActiveEvidence(data.report, runtime, data.reportPath), /association/);
});

test("Active rejects unknown asset kinds, schemas, report versions and hash-only legacy reports", async t => {
  const unknownKind = await fixture(t);
  await replaceBundle(unknownKind.root, unknownKind.report, bundle => {
    const entries = bundle.evidence_manifest as Array<Record<string, unknown>>;
    entries[0].kind = "raw_tool_output";
  });
  await assert.rejects(validateActiveEvidence(unknownKind.report, runtime, unknownKind.reportPath), /evidence manifest/);

  const old = await fixture(t);
  old.report.schema_version = "jev-paired-evaluation-report-v1";
  await assert.rejects(validateActiveEvidence(old.report, runtime, old.reportPath), /report version/);

  const hashOnly = await fixture(t);
  delete hashOnly.report.active_evidence_bundle;
  await assert.rejects(validateActiveEvidence(hashOnly.report, runtime, hashOnly.reportPath), /evaluation bundle/);
});

test("Active rejects runtime mismatches and frozen task changes after recomputation", async t => {
  const data = await fixture(t);
  await assert.rejects(validateActiveEvidence(data.report, { ...runtime, jevVersion: "jev-2.0.0" }, data.reportPath), /Jev version/);

  const changed = await fixture(t);
  await replaceBundle(changed.root, changed.report, bundle => {
    const runs = bundle.candidate_evaluations as Array<Record<string, unknown>>;
    runs[0].pair = { model: "gpt-6-luna", effort: "medium" };
  });
  await assert.rejects(validateActiveEvidence(changed.report, runtime, changed.reportPath), /report does not match|Active candidate|manifest association/);
});

test("Active evidence rejects an EVALUATION_ONLY artifact even if it contains PASS-shaped fields", async t => {
  const data = await fixture(t);
  data.report.classification = "EVALUATION_ONLY";
  await assert.rejects(validateActiveEvidence(data.report, runtime, data.reportPath), /EVALUATION_ONLY/);
});
