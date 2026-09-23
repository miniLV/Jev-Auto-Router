import { createHash } from "node:crypto";
import { UNKNOWN, type TokenUsage, type Usage } from "../src/types.js";
import { deriveCandidateCatalogId } from "../src/catalog.js";
import { isValidJevPolicyParameters, type JevPolicyParameters } from "../src/jev-adapter.js";
import { priceWeightsDigest, type CandidatePair, type HarnessConfig } from "./config.js";

export type Gate = "PASS" | "FAIL" | "UNKNOWN";

/** Frozen and committed before either arm runs. */
export interface EvaluationPlan {
  release: string;
  frozen_at: string;
  repository_revision: string;
  repository_snapshot_digest: string;
  randomization_seed: string;
  independent_review_method: string;
  gates: {
    minimum_quality_score: number;
    maximum_completion_regression: number;
    maximum_quality_regression: number;
    maximum_added_rework_per_task: number;
    maximum_added_takeover_rate: number;
    maximum_policy_cost_ratio: number;
  };
  tasks: Array<{
    task_id: string;
    intent_digest: string;
    snapshot_digest: string;
    acceptance_id: string;
    first_arm: "baseline" | "policy";
    cache_condition: "cold" | "warm";
  }>;
}

export interface EvaluationCall {
  kind: "upstream" | "jev";
  model: string;
  effort: string | typeof UNKNOWN;
  /** Actual policy values used by this Jev call; absent values block promotion. */
  runtimePolicy?: JevPolicyParameters;
  /** Every physical call, including retries, corrections and verification. */
  usage: TokenUsage;
}

export interface EvaluationArm {
  started_at: string;
  intent_digest: string;
  snapshot_digest: string;
  acceptance_id: string;
  cache_condition: "cold" | "warm";
  completed: boolean;
  accepted: boolean;
  /** Independent review score under the plan's frozen method. */
  quality_score: Usage;
  /** Opaque `kind:sha256:<hex>` references to independent review evidence. */
  quality_evidence_refs: string[];
  rework_cycles: number;
  root_takeover: boolean;
  /** Wall time for the whole Main Task, including correction and verification. */
  elapsed_ms: Usage;
  /** Explicitly measured edge charge; use 0 only when the source proves none. */
  caller_edge_cost: Usage;
  calls: EvaluationCall[];
}

export interface PairedTask {
  task_id: string;
  first_arm: "baseline" | "policy";
  baseline: EvaluationArm;
  policy: EvaluationArm;
}

export interface ShadowTaskEvaluation {
  task_id: string;
  /** Jev's Shadow proposal for this task; the actual call still uses baseline. */
  proposed_pair?: CandidatePair;
  run: EvaluationArm;
}

export interface CandidateEvaluation {
  pair: CandidatePair;
  binding: {
    release: string;
    callerEdgeId: string;
    candidateCatalogId: string;
    jevVersion: string;
    runtimePolicy: JevPolicyParameters;
    policyVersion: string;
    questionSchemaVersion: string;
    priceWeightsDigest: string;
  };
  transport: Gate;
  cancellation: Gate;
  shadow: Gate;
  /** References to sanitized, independently reviewable release evidence. */
  evidence_refs: {
    transport: string[];
    cancellation: string[];
    shadow: string[];
  };
  shadow_tasks: ShadowTaskEvaluation[];
  paired_tasks: PairedTask[];
}

export interface CandidateDecision {
  pair: CandidatePair;
  transport: Gate;
  cancellation: Gate;
  shadow: Gate;
  quality: Gate;
  cost: Gate;
  evidence_refs: {
    transport: string[];
    cancellation: string[];
    shadow: string[];
    policy_quality: string[];
    shadow_quality: string[];
  };
  comparison: {
    tasks: number;
    shadow_tasks: number;
    completion_rate: { baseline: Usage; policy: Usage };
    acceptance_rate: { baseline: Usage; policy: Usage };
    quality_score: { baseline: Usage; policy: Usage };
    rework_cycles_per_task: { baseline: Usage; policy: Usage };
    latency_mean_ms: { baseline: Usage; policy: Usage };
    full_cost: { baseline: Usage; policy: Usage; ratio: Usage };
    shadow: {
      completion_rate: { baseline: Usage; shadow: Usage };
      acceptance_rate: { baseline: Usage; shadow: Usage };
      quality_score: { baseline: Usage; shadow: Usage };
      rework_cycles_per_task: { baseline: Usage; shadow: Usage };
      root_takeovers: { baseline: number; shadow: number };
      latency_mean_ms: { baseline: Usage; shadow: Usage };
      full_cost: { baseline: Usage; shadow: Usage; ratio: Usage };
    };
  };
  active_eligible: boolean;
  blockers: string[];
  reason?: string;
}

interface RunSummary {
  taskCount: number;
  completionRate: Usage;
  acceptanceRate: Usage;
  qualityScore: Usage;
  reworkCyclesPerTask: Usage;
  rootTakeovers: number;
  latencyMeanMs: Usage;
  latencyP50Ms: Usage;
  fullCost: Usage;
  callerEdgeCost: Usage;
  jevCost: Usage;
  callCount: number;
  unobservedCalls: number;
  unobservedCallerEdgeCosts: number;
}

export function decideActiveCandidates(
  config: HarnessConfig,
  plan: EvaluationPlan,
  evaluations: CandidateEvaluation[],
  catalogNow = Date.now(),
): CandidateDecision[] {
  const byPair = new Map<string, CandidateEvaluation>();
  const duplicatePairs = new Set<string>();
  for (const item of evaluations) {
    const key = pairKey(item.pair);
    if (byPair.has(key)) duplicatePairs.add(key);
    byPair.set(key, item);
  }
  return config.candidates.map(pair => {
    const found = byPair.get(pairKey(pair));
    const matchesConfig = found !== undefined && found.binding.release === config.release &&
      found.binding.callerEdgeId === config.callerEdgeId && found.binding.candidateCatalogId === config.candidateCatalogId &&
      found.binding.jevVersion === config.jevVersion && found.binding.policyVersion === config.policyVersion &&
      found.binding.questionSchemaVersion === config.questionSchemaVersion && found.binding.priceWeightsDigest === priceWeightsDigest(config) &&
      sameRuntimePolicy(found.binding.runtimePolicy, config.runtimePolicy);
    const pairConfig = { ...config, candidates: [pair] };
    const pairErrors = duplicatePairs.has(pairKey(pair))
      ? ["duplicate candidate comparison evidence"]
      : found && matchesConfig
      ? validatePairs(pairConfig, plan, found.paired_tasks, pair, catalogNow)
      : [found ? "candidate evidence is bound to a different runtime configuration" : "candidate has no pair-locked comparison"];
    const shadowErrors = found && matchesConfig ? validateShadowTasks(config, plan, found.shadow_tasks, pair) : [];
    const baseRuns = found?.paired_tasks.map(task => task.baseline) ?? [];
    const policyRuns = found?.paired_tasks.map(task => task.policy) ?? [];
    const shadowRuns = found?.shadow_tasks.map(task => task.run) ?? [];
    const baseSummary = summarizeRuns(baseRuns, pairConfig);
    const policySummary = summarizeRuns(policyRuns, pairConfig);
    const shadowSummary = summarizeRuns(shadowRuns, config);
    const evidenceRefs = {
      transport: found?.evidence_refs?.transport ?? [],
      cancellation: found?.evidence_refs?.cancellation ?? [],
      shadow: found?.evidence_refs?.shadow ?? [],
      policy_quality: collectQualityEvidenceRefs(baseRuns.concat(policyRuns)),
      shadow_quality: collectQualityEvidenceRefs(shadowRuns),
    };
    const quality = compareQuality(plan, pairErrors.length ? "FAIL" : "PASS", {
      baseComplete: baseSummary.completionRate, policyComplete: policySummary.completionRate,
      baseAccepted: baseSummary.acceptanceRate, policyAccepted: policySummary.acceptanceRate,
      baseQuality: baseSummary.qualityScore, policyQuality: policySummary.qualityScore,
      baseRework: baseSummary.reworkCyclesPerTask, policyRework: policySummary.reworkCyclesPerTask,
      baseTakeovers: baseSummary.rootTakeovers, policyTakeovers: policySummary.rootTakeovers,
      taskCount: baseSummary.taskCount,
    });
    const baseCost = found && !pairErrors.length ? baseSummary.fullCost : UNKNOWN;
    const policyCost = found && !pairErrors.length ? policySummary.fullCost : UNKNOWN;
    const costComparison = compareCost(baseCost, policyCost, plan.gates.maximum_policy_cost_ratio);
    const costRatio = costComparison.ratio;
    const cost = costComparison.gate;
    const shadowCost = found && matchesConfig && shadowErrors.length === 0 ? shadowSummary.fullCost : UNKNOWN;
    const shadowCostRatio = compareCost(baseCost, shadowCost, plan.gates.maximum_policy_cost_ratio).ratio;
    const shadowMetrics = {
      completion_rate: { baseline: baseSummary.completionRate, shadow: shadowSummary.completionRate },
      acceptance_rate: { baseline: baseSummary.acceptanceRate, shadow: shadowSummary.acceptanceRate },
      quality_score: { baseline: baseSummary.qualityScore, shadow: shadowSummary.qualityScore },
      rework_cycles_per_task: { baseline: baseSummary.reworkCyclesPerTask, shadow: shadowSummary.reworkCyclesPerTask },
      root_takeovers: { baseline: baseSummary.rootTakeovers, shadow: shadowSummary.rootTakeovers },
      latency_mean_ms: { baseline: baseSummary.latencyMeanMs, shadow: shadowSummary.latencyMeanMs },
      full_cost: { baseline: baseCost, shadow: shadowCost, ratio: shadowCostRatio },
    };
    const missingShadowMetrics = [
      shadowMetrics.completion_rate.shadow,
      shadowMetrics.acceptance_rate.shadow,
      shadowMetrics.quality_score.shadow,
      shadowMetrics.rework_cycles_per_task.shadow,
      shadowMetrics.latency_mean_ms.shadow,
      shadowMetrics.full_cost.shadow,
    ].some(value => value === UNKNOWN);
    const shadowEvidenceGate = evidenceGate(found?.shadow, evidenceRefs.shadow, "shadow");
    const shadow: Gate = shadowEvidenceGate !== "PASS"
      ? shadowEvidenceGate
      : shadowErrors.length > 0
      ? shadowErrors.every(error => error.startsWith("missing shadow") || error.startsWith("Shadow run count does not match")) ? "UNKNOWN" : "FAIL"
      : missingShadowMetrics ? "UNKNOWN" : "PASS";
    const gates = {
      transport: evidenceGate(found?.transport, evidenceRefs.transport, "transport"),
      cancellation: evidenceGate(found?.cancellation, evidenceRefs.cancellation, "cancellation"),
      shadow,
      quality,
      cost,
    };
    const blockers = Object.entries(gates).filter(([, value]) => value !== "PASS").map(([name, value]) => `${name}:${value}`);
    if (pairErrors.length) blockers.push("pairing:FAIL");
    return {
      pair,
      ...gates,
      evidence_refs: evidenceRefs,
      comparison: {
        tasks: baseSummary.taskCount,
        shadow_tasks: shadowSummary.taskCount,
        completion_rate: { baseline: baseSummary.completionRate, policy: policySummary.completionRate },
        acceptance_rate: { baseline: baseSummary.acceptanceRate, policy: policySummary.acceptanceRate },
        quality_score: { baseline: baseSummary.qualityScore, policy: policySummary.qualityScore },
        rework_cycles_per_task: { baseline: baseSummary.reworkCyclesPerTask, policy: policySummary.reworkCyclesPerTask },
        latency_mean_ms: { baseline: baseSummary.latencyMeanMs, policy: policySummary.latencyMeanMs },
        full_cost: { baseline: baseCost, policy: policyCost, ratio: costRatio },
        shadow: shadowMetrics,
      },
      active_eligible: blockers.length === 0,
      blockers,
      reason: pairErrors[0] ?? shadowErrors[0],
    };
  });
}

export interface PairedReport {
  schema_version: "jev-paired-evaluation-report-v2";
  active_evidence_bundle?: { schema_version: "jev-active-evaluation-bundle-v1"; path: string; sha256: string };
  /** Binds the sanitized input bundle, including independent evidence references, to this report. */
  evaluation_data_digest: string;
  configuration: {
    release: string;
    mode: HarnessConfig["mode"];
    baseline: CandidatePair;
    candidates: CandidatePair[];
    callerEdgeId: string;
    candidateCatalogId: string;
    jevVersion: string;
    runtimePolicy: JevPolicyParameters;
    policyVersion: string;
    questionSchemaVersion: string;
    cacheConditions: HarnessConfig["cacheConditions"];
    currency: string;
    priceSourceRef: string;
    priceWeightsDigest: string;
    planFrozenAt: string;
    randomizationSeed: string;
    taskManifestDigest: string;
    frozenGates: EvaluationPlan["gates"];
    reviewMethod: string;
    repositoryRevision: string;
    repositorySnapshotDigest: string;
  };
  tasks: number;
  pairing_gate: Gate;
  pairing_errors: string[];
  completion_rate: { baseline: Usage; policy: Usage };
  acceptance_rate: { baseline: Usage; policy: Usage };
  quality_score: { baseline: Usage; policy: Usage };
  rework_cycles_per_task: { baseline: Usage; policy: Usage };
  root_takeovers: { baseline: number; policy: number };
  latency_ms: { baseline_mean: Usage; policy_mean: Usage; baseline_p50: Usage; policy_p50: Usage };
  candidate_decisions: CandidateDecision[];
  active_candidate_allowlist: string[];
  cost: {
    baseline: Usage;
    policy: Usage;
    policy_jev: Usage;
    baseline_caller_edge: Usage;
    policy_caller_edge: Usage;
    delta: Usage;
    ratio: Usage;
    unobserved_calls: number;
    unobserved_caller_edge_costs: number;
    baseline_call_count: number;
    policy_call_count: number;
  };
  gates: { quality: Gate; cost: Gate; savings_claim_eligible: boolean };
}

export function pairedComparison(
  config: HarnessConfig,
  plan: EvaluationPlan,
  tasks: PairedTask[],
  candidateEvaluations: CandidateEvaluation[] = [],
): PairedReport {
  const catalogNow = Date.now();
  const derivedCatalogId = currentCatalogId(config, catalogNow);
  const evaluationDataDigest = createHash("sha256").update(JSON.stringify({ config, plan, tasks, candidateEvaluations })).digest("hex");
  const pairingErrors = validatePairs(config, plan, tasks, undefined, catalogNow);
  const pairingGate: Gate = pairingErrors.length ? "FAIL" : tasks.length ? "PASS" : "UNKNOWN";
  const baselineRuns = tasks.map(task => task.baseline);
  const policyRuns = tasks.map(task => task.policy);
  const baselineSummary = summarizeRuns(baselineRuns, config);
  const policySummary = summarizeRuns(policyRuns, config);
  const qualityGate = compareQuality(plan, pairingGate, {
    baseComplete: baselineSummary.completionRate, policyComplete: policySummary.completionRate,
    baseAccepted: baselineSummary.acceptanceRate, policyAccepted: policySummary.acceptanceRate,
    baseQuality: baselineSummary.qualityScore, policyQuality: policySummary.qualityScore,
    baseRework: baselineSummary.reworkCyclesPerTask, policyRework: policySummary.reworkCyclesPerTask,
    baseTakeovers: baselineSummary.rootTakeovers, policyTakeovers: policySummary.rootTakeovers,
    taskCount: baselineSummary.taskCount,
  });

  const baselineCost = baselineSummary.fullCost;
  const policyCost = policySummary.fullCost;
  const edgeBase = baselineSummary.callerEdgeCost;
  const edgePolicy = policySummary.callerEdgeCost;
  const jevCost = policySummary.jevCost;
  const costComparison = compareCost(baselineCost, policyCost, plan.gates.maximum_policy_cost_ratio);
  const costRatio = costComparison.ratio;
  const costGate = costComparison.gate;
  const unobservedCalls = baselineSummary.unobservedCalls + policySummary.unobservedCalls;
  const candidateDecisions = decideActiveCandidates(config, plan, candidateEvaluations, catalogNow);
  const savingsClaimEligible = pairingGate === "PASS" && qualityGate === "PASS" && costGate === "PASS" &&
    candidateDecisions.length > 0 && candidateDecisions.every(candidate => candidate.active_eligible);

  return {
    schema_version: "jev-paired-evaluation-report-v2",
    evaluation_data_digest: evaluationDataDigest,
    configuration: {
      release: config.release,
      mode: config.mode,
      baseline: config.baseline,
      candidates: config.candidates,
      callerEdgeId: config.callerEdgeId,
      candidateCatalogId: derivedCatalogId ?? UNKNOWN,
      jevVersion: config.jevVersion,
      runtimePolicy: config.runtimePolicy,
      policyVersion: config.policyVersion,
      questionSchemaVersion: config.questionSchemaVersion,
      cacheConditions: config.cacheConditions,
      currency: config.currency,
      priceSourceRef: config.priceSourceRef,
      priceWeightsDigest: priceWeightsDigest(config),
      planFrozenAt: plan.frozen_at,
      randomizationSeed: plan.randomization_seed,
      taskManifestDigest: createHash("sha256").update(JSON.stringify(plan.tasks)).digest("hex"),
      frozenGates: plan.gates,
      reviewMethod: plan.independent_review_method,
      repositoryRevision: plan.repository_revision,
      repositorySnapshotDigest: plan.repository_snapshot_digest,
    },
    tasks: tasks.length,
    pairing_gate: pairingGate,
    pairing_errors: pairingErrors,
    completion_rate: { baseline: baselineSummary.completionRate, policy: policySummary.completionRate },
    acceptance_rate: { baseline: baselineSummary.acceptanceRate, policy: policySummary.acceptanceRate },
    quality_score: { baseline: baselineSummary.qualityScore, policy: policySummary.qualityScore },
    rework_cycles_per_task: { baseline: baselineSummary.reworkCyclesPerTask, policy: policySummary.reworkCyclesPerTask },
    root_takeovers: {
      baseline: baselineSummary.rootTakeovers,
      policy: policySummary.rootTakeovers,
    },
    latency_ms: {
      baseline_mean: baselineSummary.latencyMeanMs,
      policy_mean: policySummary.latencyMeanMs,
      baseline_p50: baselineSummary.latencyP50Ms,
      policy_p50: policySummary.latencyP50Ms,
    },
    candidate_decisions: candidateDecisions,
    active_candidate_allowlist: candidateDecisions
      .filter(candidate => candidate.active_eligible)
      .map(candidate => `${candidate.pair.model}/${candidate.pair.effort}`),
    cost: {
      baseline: baselineCost,
      policy: policyCost,
      policy_jev: jevCost,
      baseline_caller_edge: edgeBase,
      policy_caller_edge: edgePolicy,
      delta: baselineCost === UNKNOWN || policyCost === UNKNOWN ? UNKNOWN : baselineCost - policyCost,
      ratio: costRatio,
      unobserved_calls: unobservedCalls,
      unobserved_caller_edge_costs: baselineSummary.unobservedCallerEdgeCosts + policySummary.unobservedCallerEdgeCosts,
      baseline_call_count: baselineSummary.callCount,
      policy_call_count: policySummary.callCount,
    },
    gates: {
      quality: qualityGate,
      cost: pairingGate === "PASS" ? costGate : "UNKNOWN",
      savings_claim_eligible: savingsClaimEligible,
    },
  };
}

function validatePairs(
  config: HarnessConfig,
  plan: EvaluationPlan,
  tasks: PairedTask[],
  pairLockedTo?: CandidatePair,
  catalogNow = Date.now(),
): string[] {
  const errors: string[] = [];
  if (config.release !== plan.release) errors.push("release does not match the frozen plan");
  if (config.mode !== "active") errors.push("the policy arm must run in Active mode for a controlled comparison");
  if (!config.callerEdgeId || config.callerEdgeId === UNKNOWN || !config.candidateCatalogId || config.candidateCatalogId === UNKNOWN ||
      !config.jevVersion || config.jevVersion === UNKNOWN || !config.policyVersion || config.policyVersion === UNKNOWN ||
      !config.questionSchemaVersion || config.questionSchemaVersion === UNKNOWN || !config.currency || !config.priceSourceRef || config.candidates.length === 0) {
    errors.push("runtime versions, candidate catalog, caller edge, or candidate pairs are not pinned");
  }
  if (!isValidJevPolicyParameters(config.runtimePolicy)) {
    errors.push("frozen runtime Jev policy parameters are missing or invalid");
  }
  if (currentCatalogId(config, catalogNow) !== config.candidateCatalogId) {
    errors.push("candidate catalog ID does not match the current proved pair catalog");
  }
  if (new Set(config.candidates.map(pairKey)).size !== config.candidates.length) errors.push("candidate pairs are not unique");
  const frozenAt = Date.parse(plan.frozen_at);
  if (!plan.repository_revision || !plan.repository_snapshot_digest || !plan.randomization_seed || !plan.independent_review_method || !Number.isFinite(frozenAt)) {
    errors.push("the plan is missing a frozen revision, snapshot, review method, randomization seed, or timestamp");
  }
  if (!plan.tasks.length || Object.values(plan.gates).some(value => !Number.isFinite(value) || value < 0)) {
    errors.push("the plan has no task set or required frozen thresholds");
  }
  const expected = new Map(plan.tasks.map(task => [task.task_id, task]));
  if (expected.size !== plan.tasks.length) errors.push("the frozen plan contains duplicate task IDs");
  const observed = new Set<string>();
  for (const task of tasks) {
    if (observed.has(task.task_id)) errors.push(`duplicate paired task: ${task.task_id}`);
    observed.add(task.task_id);
    const frozen = expected.get(task.task_id);
    if (!frozen) {
      errors.push(`task is not in the frozen plan: ${task.task_id}`);
      continue;
    }
    if (task.first_arm !== frozen.first_arm) errors.push(`${task.task_id} does not follow its frozen arm order`);
    for (const [armName, arm] of [["baseline", task.baseline], ["policy", task.policy]] as const) {
      errors.push(...validateFrozenRun(config, frozen, arm, armName, frozenAt));
      for (const call of arm.calls) {
        if (call.kind === "jev") {
          if (armName === "baseline") errors.push(`${task.task_id} fixed baseline arm contains a Jev call`);
          if (!sameRuntimePolicy(call.runtimePolicy, config.runtimePolicy)) errors.push(`${task.task_id} Jev call did not record the frozen runtime policy`);
          if (call.model !== config.jevVersion) errors.push(`${task.task_id} Jev call did not use the pinned version ${config.jevVersion}`);
          if (call.effort !== UNKNOWN) errors.push(`${task.task_id} Jev call must not claim a model effort`);
          continue;
        }
        if (call.kind !== "upstream") {
          errors.push(`${task.task_id} ${armName} contains an unknown physical call kind`);
          continue;
        }
        const pairKeyValue = `${call.model}/${call.effort}`;
        const allowedPairs = armName === "baseline"
          ? [config.baseline]
          : [config.baseline, ...(pairLockedTo ? [pairLockedTo] : config.candidates)];
        if (!allowedPairs.some(pair => pairKey(pair) === pairKeyValue)) {
          errors.push(armName === "baseline"
            ? `${task.task_id} baseline did not use the configured fallback pair`
            : `${task.task_id} policy used an unconfigured pair ${pairKeyValue}`);
        }
      }
    }
    const firstRun = task.first_arm === "baseline" ? task.baseline : task.policy;
    const secondRun = task.first_arm === "baseline" ? task.policy : task.baseline;
    if (Date.parse(firstRun.started_at) >= Date.parse(secondRun.started_at)) errors.push(`${task.task_id} runs do not follow the frozen arm order`);
  }
  for (const taskId of expected.keys()) if (!observed.has(taskId)) errors.push(`frozen task has no paired run: ${taskId}`);
  if (pairLockedTo && !tasks.some(task => task.policy.calls.some(call => call.kind === "upstream" && pairKey(call) === pairKey(pairLockedTo)))) {
    errors.push(`candidate ${pairKey(pairLockedTo)} was not exercised`);
  }
  return errors;
}

function currentCatalogId(config: HarnessConfig, now: number): string | undefined {
  try {
    return deriveCandidateCatalogId(config.candidateCatalog, config.callerEdgeId, now);
  } catch {
    return undefined;
  }
}

function validateShadowTasks(config: HarnessConfig, plan: EvaluationPlan, tasks: ShadowTaskEvaluation[], candidate: CandidatePair): string[] {
  if (!tasks.length) return ["missing shadow task runs"];
  const errors: string[] = [];
  const expected = new Map(plan.tasks.map(task => [task.task_id, task]));
  const observed = new Set<string>();
  let candidateProposed = false;
  for (const task of tasks) {
    if (observed.has(task.task_id)) errors.push(`duplicate shadow task: ${task.task_id}`);
    observed.add(task.task_id);
    const frozen = expected.get(task.task_id);
    if (!frozen) {
      errors.push(`shadow task is not in the frozen plan: ${task.task_id}`);
      continue;
    }
    const run = task.run;
    errors.push(...validateFrozenRun(config, frozen, run, "shadow", Date.parse(plan.frozen_at)));
    if (task.proposed_pair) {
      if (!config.candidates.some(pair => pairKey(pair) === pairKey(task.proposed_pair!))) {
        errors.push(`${task.task_id} Shadow proposed an unconfigured pair ${pairKey(task.proposed_pair)}`);
      }
      if (pairKey(task.proposed_pair) === pairKey(candidate)) candidateProposed = true;
      if (!run.calls.some(call => call.kind === "jev")) errors.push(`${task.task_id} Shadow proposal has no recorded Jev call`);
    }
    for (const call of run.calls) {
      if (call.kind === "jev") {
        if (!sameRuntimePolicy(call.runtimePolicy, config.runtimePolicy)) errors.push(`${task.task_id} Shadow Jev call did not record the frozen runtime policy`);
        if (call.model !== config.jevVersion) errors.push(`${task.task_id} Shadow Jev call did not use the pinned version ${config.jevVersion}`);
        if (call.effort !== UNKNOWN) errors.push(`${task.task_id} Shadow Jev call must not claim a model effort`);
      } else if (call.kind === "upstream") {
        if (pairKey(call) !== pairKey(config.baseline)) errors.push(`${task.task_id} Shadow did not execute the configured Fallback Baseline`);
      } else {
        errors.push(`${task.task_id} Shadow run contains an unknown physical call kind`);
      }
    }
  }
  for (const taskId of expected.keys()) {
    if (!observed.has(taskId)) errors.push(`missing shadow run for frozen task ${taskId}`);
  }
  if (tasks.length !== expected.size) errors.push("Shadow run count does not match the frozen task count");
  if (!candidateProposed) errors.push(`candidate ${pairKey(candidate)} was not proposed in Shadow`);
  return errors;
}

function validateFrozenRun(
  config: HarnessConfig,
  frozen: EvaluationPlan["tasks"][number],
  run: EvaluationArm,
  armName: "baseline" | "policy" | "shadow",
  frozenAt: number,
): string[] {
  const label = `${frozen.task_id} ${armName === "shadow" ? "shadow run" : armName}`;
  const errors: string[] = [];
  if (run.cache_condition !== frozen.cache_condition ||
      (config.cacheConditions !== "declared-per-task" && run.cache_condition !== config.cacheConditions)) {
    errors.push(`${label} does not match the frozen cache condition`);
  }
  if (run.intent_digest !== frozen.intent_digest || run.snapshot_digest !== frozen.snapshot_digest || run.acceptance_id !== frozen.acceptance_id) {
    errors.push(`${label} does not match the frozen input, snapshot, and acceptance`);
  }
  if (!run.calls.length) errors.push(`${label} has no recorded model calls`);
  const startedAt = Date.parse(run.started_at);
  if (!Number.isFinite(frozenAt) || !Number.isFinite(startedAt) || startedAt <= frozenAt) {
    errors.push(`${label} did not start after the plan was frozen`);
  }
  if (!hasEvidenceRefs(run.quality_evidence_refs)) {
    errors.push(`${label} has no independent quality evidence references`);
  }
  if (run.accepted && !run.completed) errors.push(`${label} was accepted without being completed`);
  return errors;
}

function summarizeRuns(runs: EvaluationArm[], config: HarnessConfig): RunSummary {
  const calls = runs.flatMap(run => run.calls);
  return {
    taskCount: runs.length,
    completionRate: rate(runs.filter(run => run.completed).length, runs.length),
    acceptanceRate: rate(runs.filter(run => run.accepted).length, runs.length),
    qualityScore: mean(runs.map(run => run.quality_score)),
    reworkCyclesPerTask: mean(runs.map(run => run.rework_cycles)),
    rootTakeovers: runs.filter(run => run.root_takeover).length,
    latencyMeanMs: mean(runs.map(run => run.elapsed_ms)),
    latencyP50Ms: percentile(runs.map(run => run.elapsed_ms), 0.5),
    fullCost: costRuns(runs, config),
    callerEdgeCost: sumNumbers(runs.map(run => run.caller_edge_cost)),
    jevCost: sumNumbers(calls.filter(call => call.kind === "jev").map(call => callCost(call, config))),
    callCount: calls.length,
    unobservedCalls: calls.filter(call => callCost(call, config) === UNKNOWN).length,
    unobservedCallerEdgeCosts: runs.filter(run => money(run.caller_edge_cost) === UNKNOWN).length,
  };
}

function compareCost(baseline: Usage, policy: Usage, maximumRatio: number): { ratio: Usage; gate: Gate } {
  const ratio = baseline === UNKNOWN || policy === UNKNOWN || baseline === 0 ? UNKNOWN : policy / baseline;
  return { ratio, gate: ratio === UNKNOWN ? "UNKNOWN" : ratio <= maximumRatio ? "PASS" : "FAIL" };
}

function compareQuality(plan: EvaluationPlan, pairing: Gate, stats: {
  baseComplete: Usage; policyComplete: Usage; baseAccepted: Usage; policyAccepted: Usage;
  baseQuality: Usage; policyQuality: Usage; baseRework: Usage; policyRework: Usage;
  baseTakeovers: number; policyTakeovers: number; taskCount: number;
}): Gate {
  const numbers = [stats.baseComplete, stats.policyComplete, stats.baseAccepted, stats.policyAccepted, stats.baseQuality, stats.policyQuality, stats.baseRework];
  if (pairing !== "PASS" || stats.taskCount === 0 || numbers.some(value => value === UNKNOWN)) return "UNKNOWN";
  const g = plan.gates;
  const pass = (stats.policyComplete as number) >= (stats.baseComplete as number) - g.maximum_completion_regression &&
    (stats.policyAccepted as number) >= (stats.baseAccepted as number) - g.maximum_completion_regression &&
    (stats.policyQuality as number) >= g.minimum_quality_score &&
    (stats.policyQuality as number) >= (stats.baseQuality as number) - g.maximum_quality_regression &&
    (stats.policyRework as number) <= (stats.baseRework as number) + g.maximum_added_rework_per_task &&
    stats.policyTakeovers / stats.taskCount <= stats.baseTakeovers / stats.taskCount + g.maximum_added_takeover_rate;
  return pass ? "PASS" : "FAIL";
}

function costRuns(runs: EvaluationArm[], config: HarnessConfig): Usage {
  if (!runs.length || runs.some(run => run.calls.length === 0)) return UNKNOWN;
  return sumNumbers(runs.flatMap(run => [money(run.caller_edge_cost), ...run.calls.map(call => callCost(call, config))]));
}

function callCost(call: EvaluationCall, config: HarnessConfig): Usage {
  const price = config.prices[call.model];
  const usage = call.usage;
  const values = [usage.input_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens, usage.output_tokens, usage.reasoning_tokens];
  if (!price || Object.values(price).some(rate => !Number.isFinite(rate) || rate < 0) ||
      values.some(value => value === UNKNOWN || !Number.isFinite(value) || (value as number) < 0)) return UNKNOWN;
  const [input, cached, cacheWrite, output, reasoning] = values as number[];
  if (cached + cacheWrite > input || reasoning > output) return UNKNOWN;
  return ((input - cached - cacheWrite) * price.input + cached * price.cached_input + cacheWrite * price.cache_write_input + output * price.output) / 1e6;
}

function sumNumbers(values: Usage[]): Usage {
  return values.reduce<Usage>((total, value) => total === UNKNOWN || value === UNKNOWN ? UNKNOWN : total + value, 0);
}

function money(value: Usage): Usage {
  return value === UNKNOWN || !Number.isFinite(value) || value < 0 ? UNKNOWN : value;
}

function mean(values: Array<number | Usage>): Usage {
  if (!values.length || values.some(value => value === UNKNOWN)) return UNKNOWN;
  return (values as number[]).reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: Usage[], p: number): Usage {
  if (!values.length || values.some(value => value === UNKNOWN)) return UNKNOWN;
  const sorted = [...values as number[]].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function rate(numerator: number, denominator: number): Usage {
  return denominator === 0 ? UNKNOWN : numerator / denominator;
}

function pairKey(pair: CandidatePair): string {
  return `${pair.model}/${pair.effort}`;
}

function sameRuntimePolicy(left: unknown, right: unknown): boolean {
  return isValidJevPolicyParameters(left) && isValidJevPolicyParameters(right) &&
    left.confidenceFloor === right.confidenceFloor && left.deadlineMs === right.deadlineMs;
}

function evidenceGate(status: Gate | undefined, refs: unknown, requiredKind: string): Gate {
  if (status === "FAIL") return "FAIL";
  if (status !== "PASS" || !Array.isArray(refs) || refs.length === 0) return "UNKNOWN";
  if (!hasEvidenceRefs(refs) || !refs.some(ref => ref.startsWith(`${requiredKind}:`))) return "FAIL";
  return "PASS";
}

function hasEvidenceRefs(refs: unknown): refs is string[] {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => typeof ref === "string" && /^[a-z][a-z0-9_-]*:sha256:[0-9a-f]{64}$/.test(ref));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function collectQualityEvidenceRefs(runs: EvaluationArm[]): string[] {
  return unique(runs.flatMap(run => Array.isArray(run.quality_evidence_refs)
    ? run.quality_evidence_refs.filter((ref): ref is string => typeof ref === "string")
    : []));
}
