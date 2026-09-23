import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { UNKNOWN, type TokenUsage } from "../src/types.js";
import { deriveCandidateCatalogId } from "../src/catalog.js";
import { priceWeightsDigest, type HarnessConfig } from "../bench/config.js";
import { REPLAY_LABEL, replayFixtures } from "../bench/fixtures.js";
import { replay } from "../bench/harness.js";
import {
  decideActiveCandidates,
  pairedComparison,
  type CandidateEvaluation,
  type EvaluationArm,
  type EvaluationCall,
  type EvaluationPlan,
  type PairedTask,
  type ShadowTaskEvaluation,
} from "../bench/paired-evaluation.js";
import { testCatalog } from "./routing-fixtures.js";

// Synthetic validation fixture only; it is not caller-edge release evidence.
const candidateCatalog = testCatalog();
const candidateCatalogId = deriveCandidateCatalogId(candidateCatalog, "edge-fixture-v1");
const config: HarnessConfig = {
  release: "fixture-only-v1",
  mode: "active",
  baseline: { model: "gpt-6-sol", effort: "medium" },
  candidates: [{ model: "gpt-6-luna", effort: "max" }],
  currency: "USD",
  priceSourceRef: "fixture-only",
  callerEdgeId: "edge-fixture-v1",
  candidateCatalog,
  candidateCatalogId,
  jevVersion: "jev-1.13.0",
  runtimePolicy: { confidenceFloor: 0.55, deadlineMs: 2_000 },
  policyVersion: "per-call/1",
  questionSchemaVersion: "route-v1",
  cacheConditions: "declared-per-task",
  prices: {
    "gpt-6-sol": { input: 1.25, cached_input: 0.25, cache_write_input: 2, output: 5 },
    "gpt-6-astra": { input: 5, cached_input: 1, cache_write_input: 10, output: 20 },
    "gpt-6-luna": { input: 0.25, cached_input: 0.05, cache_write_input: 0.4, output: 1.25 },
    "jev-1.13.0": { input: 0.042, cached_input: 0.01, cache_write_input: 0.08, output: 0 },
  },
};

const plan: EvaluationPlan = {
  release: config.release,
  frozen_at: "2026-09-23T00:00:00.000Z",
  repository_revision: "fixture-commit",
  repository_snapshot_digest: "repo-digest",
  randomization_seed: "fixture-seed",
  independent_review_method: "review-protocol-v1",
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

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input_tokens: 1000,
    cached_input_tokens: 200,
    cache_write_input_tokens: 100,
    output_tokens: 100,
    reasoning_tokens: 20,
    ...overrides,
  };
}

function call(kind: EvaluationCall["kind"], model: string, effort: string): EvaluationCall {
  return {
    kind,
    model,
    effort,
    ...(kind === "jev" ? { runtimePolicy: config.runtimePolicy } : {}),
    usage: usage(),
  };
}

function arm(taskId: string, policy: boolean, evaluationPlan = plan): EvaluationArm {
  const task = evaluationPlan.tasks.find(entry => entry.task_id === taskId)!;
  const startedSecond = task.first_arm === "baseline" ? policy ? "02" : "01" : policy ? "01" : "02";
  const evidenceRef = (kind: string) => `${kind}:sha256:${createHash("sha256").update(`${taskId}:${policy}:${kind}`).digest("hex")}`;
  return {
    started_at: `2026-09-23T00:00:${startedSecond}.000Z`,
    intent_digest: task.intent_digest,
    snapshot_digest: task.snapshot_digest,
    acceptance_id: task.acceptance_id,
    cache_condition: task.cache_condition,
    completed: true,
    accepted: true,
    quality_score: policy ? 4.5 : 4.5,
    quality_evidence_refs: [evidenceRef("diff"), evidenceRef("test")],
    rework_cycles: 0,
    root_takeover: false,
    elapsed_ms: policy ? 900 : 1000,
    caller_edge_cost: 0,
    calls: policy
      ? [call("upstream", "gpt-6-luna", "max"), call("jev", "jev-1.13.0", "UNKNOWN")]
      : [call("upstream", "gpt-6-sol", "medium")],
  };
}

function tasks(evaluationPlan = plan): PairedTask[] {
  return [
    { task_id: "t1", first_arm: "baseline", baseline: arm("t1", false, evaluationPlan), policy: arm("t1", true, evaluationPlan) },
    { task_id: "t2", first_arm: "policy", baseline: arm("t2", false, evaluationPlan), policy: arm("t2", true, evaluationPlan) },
    ...evaluationPlan.tasks.slice(2).map(task => ({
      task_id: task.task_id,
      first_arm: task.first_arm,
      baseline: arm(task.task_id, false, evaluationPlan),
      policy: arm(task.task_id, true, evaluationPlan),
    })),
  ];
}

function shadowTasks(pair: HarnessConfig["candidates"][number], evaluationPlan = plan): ShadowTaskEvaluation[] {
  return evaluationPlan.tasks.map(task => ({
    task_id: task.task_id,
    proposed_pair: pair,
    run: {
      ...arm(task.task_id, false, evaluationPlan),
      started_at: "2026-09-23T00:00:03.000Z",
      elapsed_ms: 1100,
      calls: [
        call("upstream", config.baseline.model, config.baseline.effort),
        call("jev", config.jevVersion, "UNKNOWN"),
      ],
    },
  }));
}

function passingCandidateEvidence(evaluationPlan = plan, pairedTasks = tasks(evaluationPlan)): CandidateEvaluation[] {
  return config.candidates.map(pair => ({
    pair,
    binding: {
      release: config.release,
      callerEdgeId: config.callerEdgeId,
      candidateCatalogId: config.candidateCatalogId,
      jevVersion: config.jevVersion,
      runtimePolicy: config.runtimePolicy,
      policyVersion: config.policyVersion,
      questionSchemaVersion: config.questionSchemaVersion,
      priceWeightsDigest: priceWeightsDigest(config),
    },
    transport: "PASS",
    cancellation: "PASS",
    shadow: "PASS",
    evidence_refs: {
      transport: [`transport:sha256:${createHash("sha256").update(`transport:${pair.model}`).digest("hex")}`],
      cancellation: [`cancellation:sha256:${createHash("sha256").update(`cancellation:${pair.model}`).digest("hex")}`],
      shadow: [`shadow:sha256:${createHash("sha256").update(`shadow:${pair.model}`).digest("hex")}`],
    },
    shadow_tasks: shadowTasks(pair, evaluationPlan),
    paired_tasks: pairedTasks,
  }));
}

test("historical replay stays ESTIMATED/COUNTERFACTUAL and keeps missing usage UNKNOWN", () => {
  const report = replay(config);
  assert.equal(report.label, REPLAY_LABEL);
  assert.equal(report.unobserved_calls, 8);
  assert.equal(report.replay_cost, UNKNOWN);
  assert.equal(report.delta, UNKNOWN);
});

test("historical replay can re-price fully observed fixture traces", () => {
  const observed = replayFixtures().calls
    .filter(call => call.input_tokens !== UNKNOWN)
    .map(call => ({ ...call, jev_input_tokens: 300, jev_output_tokens: 30 }));
  const report = replay(config, observed);
  assert.ok(typeof report.observed_cost === "number");
  assert.ok(typeof report.replay_cost === "number");
  assert.equal(typeof report.delta, "number");
});

test("paired comparison reports quality, latency, all calls, Jev and caller-edge cost", () => {
  const candidateRuns = passingCandidateEvidence();
  const report = pairedComparison(config, plan, tasks(), candidateRuns);
  assert.equal(report.pairing_gate, "PASS");
  assert.equal(report.configuration.candidateCatalogId, candidateCatalogId);
  assert.deepEqual(report.configuration.runtimePolicy, config.runtimePolicy);
  assert.equal(report.completion_rate.policy, 1);
  assert.equal(report.acceptance_rate.policy, 1);
  assert.equal(report.quality_score.policy, 4.5);
  assert.equal(report.latency_ms.policy_p50, 900);
  assert.equal(report.cost.baseline_call_count, 2);
  assert.equal(report.cost.policy_call_count, 4);
  assert.ok(typeof report.cost.policy_jev === "number" && report.cost.policy_jev > 0);
  assert.equal(report.cost.baseline_caller_edge, 0);
  assert.ok(typeof report.cost.baseline === "number");
  assert.ok(typeof report.cost.policy === "number" && report.cost.policy < report.cost.baseline);
  assert.ok(Math.abs((report.cost.baseline as number) - 0.00325) < 1e-12);
  assert.ok(Math.abs((report.cost.policy as number) - 0.0007788) < 1e-12);
  assert.equal(report.gates.quality, "PASS");
  assert.equal(report.gates.cost, "PASS");
  assert.equal(report.gates.savings_claim_eligible, true);
  assert.equal(report.candidate_decisions[0].active_eligible, true);
  assert.deepEqual(report.active_candidate_allowlist, ["gpt-6-luna/max"]);
  assert.match(report.evaluation_data_digest, /^[0-9a-f]{64}$/);
  assert.equal(report.candidate_decisions[0].comparison.shadow.completion_rate.shadow, 1);
  assert.ok(typeof report.candidate_decisions[0].comparison.shadow.full_cost.shadow === "number");
});

test("paired evidence digest and eligibility bind the exact Jev runtime policy", () => {
  const original = pairedComparison(config, plan, tasks(), passingCandidateEvidence());
  for (const runtimePolicy of [
    { confidenceFloor: 0.56, deadlineMs: 2_000 },
    { confidenceFloor: 0.55, deadlineMs: 2_001 },
  ]) {
    const changed = pairedComparison({ ...config, runtimePolicy }, plan, tasks(), passingCandidateEvidence());
    assert.notEqual(changed.evaluation_data_digest, original.evaluation_data_digest);
    assert.notDeepEqual(changed.configuration.runtimePolicy, original.configuration.runtimePolicy);
    assert.equal(changed.pairing_gate, "FAIL");
    assert.equal(changed.candidate_decisions[0].active_eligible, false);
  }

  const missingCallBinding = tasks();
  delete missingCallBinding[0].policy.calls.find(entry => entry.kind === "jev")!.runtimePolicy;
  const unbound = pairedComparison(config, plan, missingCallBinding, passingCandidateEvidence());
  assert.equal(unbound.pairing_gate, "FAIL");
  assert.ok(unbound.pairing_errors.some(error => error.includes("did not record the frozen runtime policy")));
});

test("paired evaluation rejects a hand-assigned catalog ID and reports the derived ID", () => {
  const forgedConfig = { ...config, candidateCatalogId: "catalog-fixture-v1" };
  const report = pairedComparison(forgedConfig, plan, tasks(), passingCandidateEvidence());
  assert.equal(report.pairing_gate, "FAIL");
  assert.equal(report.configuration.candidateCatalogId, candidateCatalogId);
  assert.equal(report.candidate_decisions[0].active_eligible, false);
  assert.deepEqual(report.active_candidate_allowlist, []);
});

test("paired evaluation cannot approve a bundle with no candidate catalog snapshot", () => {
  const missingCatalogConfig = { ...config, candidateCatalog: undefined as unknown as HarnessConfig["candidateCatalog"] };
  const report = pairedComparison(missingCatalogConfig, plan, tasks(), passingCandidateEvidence());
  assert.equal(report.pairing_gate, "FAIL");
  assert.equal(report.configuration.candidateCatalogId, UNKNOWN);
  assert.equal(report.gates.savings_claim_eligible, false);
});

test("overall and candidate reports summarize the same asymmetric runs and preserve UNKNOWN cost", () => {
  const asymmetricPlan: EvaluationPlan = {
    ...plan,
    tasks: [...plan.tasks, {
      ...plan.tasks[0],
      task_id: "t3",
      intent_digest: "t3-intent",
      snapshot_digest: "t3-snapshot",
      acceptance_id: "t3-acceptance",
      cache_condition: "cold",
    }],
  };
  const asymmetricTasks = tasks(asymmetricPlan);
  asymmetricTasks[0].baseline.caller_edge_cost = 0.00001;
  asymmetricTasks[0].policy.caller_edge_cost = 0.000011;
  asymmetricTasks[1].baseline.caller_edge_cost = 0.00002;
  asymmetricTasks[1].baseline.calls.push(call("upstream", config.baseline.model, config.baseline.effort));
  asymmetricTasks[1].policy.caller_edge_cost = 0.000022;
  asymmetricTasks[1].policy.completed = false;
  asymmetricTasks[1].policy.accepted = false;
  asymmetricTasks[1].policy.quality_score = 2.5;
  asymmetricTasks[1].policy.rework_cycles = 3;
  asymmetricTasks[1].policy.root_takeover = true;
  asymmetricTasks[1].policy.elapsed_ms = 2800;
  asymmetricTasks[1].policy.calls.push(
    call("upstream", config.candidates[0].model, config.candidates[0].effort),
    call("upstream", config.candidates[0].model, config.candidates[0].effort),
  );
  asymmetricTasks[2].baseline.caller_edge_cost = 0.00003;
  asymmetricTasks[2].baseline.elapsed_ms = 1200;
  asymmetricTasks[2].policy.caller_edge_cost = 0.000033;
  asymmetricTasks[2].policy.accepted = false;
  asymmetricTasks[2].policy.quality_score = 3.5;
  asymmetricTasks[2].policy.rework_cycles = 1;
  asymmetricTasks[2].policy.elapsed_ms = 1500;
  asymmetricTasks[2].policy.calls.push(call("upstream", config.candidates[0].model, config.candidates[0].effort));
  asymmetricTasks[2].policy.calls[2].usage.reasoning_tokens = UNKNOWN;

  const report = pairedComparison(config, asymmetricPlan, asymmetricTasks, passingCandidateEvidence(asymmetricPlan, asymmetricTasks));
  const candidate = report.candidate_decisions[0];
  assert.equal(report.pairing_gate, "PASS");
  assert.equal(report.tasks, 3);
  assert.equal(report.completion_rate.baseline, 1);
  assert.equal(report.completion_rate.policy, 2 / 3);
  assert.equal(report.acceptance_rate.policy, 1 / 3);
  assert.equal(report.quality_score.policy, 3.5);
  assert.equal(report.rework_cycles_per_task.policy, 4 / 3);
  assert.equal(report.root_takeovers.policy, 1);
  assert.equal(report.latency_ms.policy_mean, 5200 / 3);
  assert.equal(report.latency_ms.policy_p50, 1500);
  assert.equal(report.cost.baseline_call_count, 4);
  assert.equal(report.cost.policy_call_count, 9);
  assert.equal(report.cost.unobserved_calls, 1);
  assert.equal(report.cost.unobserved_caller_edge_costs, 0);
  assert.ok(Math.abs((report.cost.baseline as number) - 0.00656) < 1e-12);
  assert.equal(report.cost.policy, UNKNOWN);
  assert.ok(Math.abs((report.cost.policy_jev as number) - 0.0001182) < 1e-12);
  assert.ok(Math.abs((report.cost.baseline_caller_edge as number) - 0.00006) < 1e-12);
  assert.ok(Math.abs((report.cost.policy_caller_edge as number) - 0.000066) < 1e-12);
  assert.equal(candidate.comparison.tasks, report.tasks);
  assert.deepEqual(candidate.comparison.completion_rate, report.completion_rate);
  assert.deepEqual(candidate.comparison.acceptance_rate, report.acceptance_rate);
  assert.deepEqual(candidate.comparison.quality_score, report.quality_score);
  assert.deepEqual(candidate.comparison.rework_cycles_per_task, report.rework_cycles_per_task);
  assert.equal(candidate.comparison.latency_mean_ms.policy, report.latency_ms.policy_mean);
  assert.equal(candidate.comparison.full_cost.baseline, report.cost.baseline);
  assert.equal(candidate.comparison.full_cost.policy, report.cost.policy);
  assert.equal(candidate.comparison.shadow_tasks, 3);
});

test("UNKNOWN token or edge cost blocks complete-cost attribution", () => {
  const incomplete = tasks();
  incomplete[0].policy.calls[0].usage.reasoning_tokens = UNKNOWN;
  incomplete[1].policy.caller_edge_cost = UNKNOWN;
  const report = pairedComparison(config, plan, incomplete, passingCandidateEvidence());
  assert.equal(report.cost.policy, UNKNOWN);
  assert.equal(report.cost.delta, UNKNOWN);
  assert.equal(report.cost.ratio, UNKNOWN);
  assert.equal(report.cost.unobserved_calls, 1);
  assert.equal(report.gates.cost, "UNKNOWN");
  assert.equal(report.gates.savings_claim_eligible, false);
  assert.deepEqual(report.active_candidate_allowlist, ["gpt-6-luna/max"]);
});

test("every recorded retry is priced as another physical call", () => {
  const withRetry = tasks();
  withRetry[0].policy.calls.push(call("upstream", "gpt-6-luna", "max"));
  const report = pairedComparison(config, plan, withRetry, passingCandidateEvidence());
  assert.equal(report.cost.policy_call_count, 5);
  assert.ok(Math.abs((report.cost.policy as number) - 0.0011288) < 1e-12);
});

test("mismatched paired inputs fail the pairing gate and cannot support a savings claim", () => {
  const unpaired = tasks();
  unpaired[0].policy.intent_digest = "different-input";
  const report = pairedComparison(config, plan, unpaired, passingCandidateEvidence());
  assert.equal(report.pairing_gate, "FAIL");
  assert.match(report.pairing_errors[0], /does not match the frozen input/);
  assert.equal(report.gates.cost, "UNKNOWN");
  assert.equal(report.gates.savings_claim_eligible, false);
});

test("paired evaluation requires preregistration before both arms and enforces frozen arm order", () => {
  const beforeFreeze = tasks();
  beforeFreeze[0].baseline.started_at = plan.frozen_at;
  const early = pairedComparison(config, plan, beforeFreeze);
  assert.equal(early.pairing_gate, "FAIL");
  assert.match(early.pairing_errors[0], /did not start after the plan was frozen/);

  const wrongOrder = tasks();
  wrongOrder[0].policy.started_at = "2026-09-23T00:00:00.500Z";
  const reordered = pairedComparison(config, plan, wrongOrder);
  assert.equal(reordered.pairing_gate, "FAIL");
  assert.ok(reordered.pairing_errors.some(error => error.includes("do not follow the frozen arm order")));

  const noIndependentReview = tasks();
  noIndependentReview[0].policy.quality_evidence_refs = [];
  const unreviewed = pairedComparison(config, plan, noIndependentReview);
  assert.equal(unreviewed.pairing_gate, "FAIL");
  assert.ok(unreviewed.pairing_errors.some(error => error.includes("no independent quality evidence references")));
});

test("a lower policy quality score is a loss even when the measured policy is cheaper", () => {
  const worse = tasks();
  worse[1].policy.accepted = false;
  worse[1].policy.quality_score = 3;
  const report = pairedComparison(config, plan, worse, passingCandidateEvidence());
  assert.ok(typeof report.cost.policy === "number" && typeof report.cost.baseline === "number");
  assert.equal(report.gates.quality, "FAIL");
  assert.equal(report.gates.savings_claim_eligible, false);
});

test("candidate Active eligibility requires every exact gate to pass", () => {
  const blocked = passingCandidateEvidence();
  blocked[0].cancellation = "UNKNOWN";
  const decisions = decideActiveCandidates(config, plan, blocked);
  assert.equal(decisions[0].active_eligible, false);
  assert.deepEqual(decisions[0].blockers, ["cancellation:UNKNOWN"]);
  assert.deepEqual(decideActiveCandidates(config, plan, [])[0].blockers, [
    "transport:UNKNOWN", "cancellation:UNKNOWN", "shadow:UNKNOWN", "quality:UNKNOWN", "cost:UNKNOWN", "pairing:FAIL",
  ]);
  const wrongBinding = passingCandidateEvidence();
  wrongBinding[0].binding.callerEdgeId = "other-edge";
  const mismatched = decideActiveCandidates(config, plan, wrongBinding)[0];
  assert.equal(mismatched.active_eligible, false);
  assert.ok(mismatched.blockers.includes("pairing:FAIL"));
});

test("transport, cancellation and Shadow PASS require linked evidence references", () => {
  const missing = passingCandidateEvidence();
  missing[0].evidence_refs.cancellation = [];
  const decision = decideActiveCandidates(config, plan, missing)[0];
  assert.equal(decision.cancellation, "UNKNOWN");
  assert.equal(decision.active_eligible, false);

  const mismatchedKind = passingCandidateEvidence();
  mismatchedKind[0].evidence_refs.transport = [`cancellation:sha256:${"a".repeat(64)}`];
  const invalid = decideActiveCandidates(config, plan, mismatchedKind)[0];
  assert.equal(invalid.transport, "FAIL");
});

test("candidate Active eligibility requires complete per-candidate Shadow measurements", () => {
  const missing = passingCandidateEvidence();
  missing[0].shadow_tasks = [];
  const decision = decideActiveCandidates(config, plan, missing)[0];
  assert.equal(decision.active_eligible, false);
  assert.equal(decision.shadow, "UNKNOWN");
  assert.equal(decision.comparison.shadow.full_cost.shadow, UNKNOWN);
});

test("candidate evidence rejects a Jev version mismatch and Jev calls in the fixed baseline arm", () => {
  const wrongVersion = passingCandidateEvidence();
  wrongVersion[0].paired_tasks[0].policy.calls.find(item => item.kind === "jev")!.model = "jev-2.0.0";
  const versionDecision = decideActiveCandidates(config, plan, wrongVersion)[0];
  assert.equal(versionDecision.active_eligible, false);
  assert.match(versionDecision.reason ?? "", /Jev call did not use the pinned version/);

  const jevInBaseline = passingCandidateEvidence();
  jevInBaseline[0].paired_tasks[0].baseline.calls.push(call("jev", config.jevVersion, "UNKNOWN"));
  const baselineDecision = decideActiveCandidates(config, plan, jevInBaseline)[0];
  assert.equal(baselineDecision.active_eligible, false);
  assert.match(baselineDecision.reason ?? "", /fixed baseline arm contains a Jev call/);
});

test("invalid caller-edge costs are counted as unobserved", () => {
  const incomplete = tasks();
  incomplete[0].policy.caller_edge_cost = -0.01;
  const report = pairedComparison(config, plan, incomplete);
  assert.equal(report.cost.policy, UNKNOWN);
  assert.equal(report.cost.unobserved_caller_edge_costs, 1);
});
