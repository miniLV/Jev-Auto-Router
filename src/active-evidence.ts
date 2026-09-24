import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CandidateEvaluation, EvaluationArm, EvaluationPlan, PairedTask, ShadowTaskEvaluation } from "../bench/paired-evaluation.js";
import { pairedComparison } from "../bench/paired-evaluation.js";
import type { HarnessConfig } from "../bench/config.js";
import type { ModelEffortPair } from "./catalog.js";
import { digest } from "./canonical.js";
import { isValidJevPolicyParameters, type JevPolicyParameters } from "./jev-adapter.js";

export interface ActiveEvidenceBinding {
  releaseId: string;
  baseline: ModelEffortPair;
  activeCandidates: ModelEffortPair[];
  callerEdgeId: string;
  candidateCatalogId: string;
  jevVersion: string;
  runtimePolicy: JevPolicyParameters;
  policyVersion: string;
  questionSchemaVersion: string;
}

const REPORT_SCHEMA = "jev-paired-evaluation-report-v2";
const BUNDLE_SCHEMA = "jev-active-evaluation-bundle-v1";
const ASSET_SCHEMAS: Record<string, string> = {
  transport: "jev-transport-evidence-v2",
  cancellation: "jev-cancellation-evidence-v1",
  shadow: "jev-shadow-evidence-v1",
  diff: "jev-quality-evidence-v1",
  test: "jev-quality-evidence-v1",
  artifact: "jev-quality-evidence-v1",
};
const TRANSPORT_SOURCE_SCHEMA = "jev-transport-source-v1";
const TRANSPORT_SOURCE_KIND = "transport_source";
const MAX_TRANSPORT_SOURCE_BYTES = 256 * 1024;
const ELIGIBILITY_GATES = ["transport", "cancellation", "shadow", "quality", "cost"] as const;

/** Active accepts only an evaluator report reproduced from its saved, file-backed input bundle. */
export async function validateActiveEvidence(value: unknown, runtime: ActiveEvidenceBinding, reportFile: string): Promise<void> {
  const report = asRecord(value, "Active evidence must be a paired-evaluation report");
  if (report.classification === "EVALUATION_ONLY" || report.evaluation_only === "EVALUATION_ONLY") {
    throw new Error("EVALUATION_ONLY artifacts cannot approve production Active routing");
  }
  if (report.schema_version !== REPORT_SCHEMA) throw new Error("Active evidence report version is not supported");
  validateActiveReportBinding(report, runtime);

  const bundleRef = asRecord(report.active_evidence_bundle, "Active evidence has no evaluation bundle reference");
  if (bundleRef.schema_version !== BUNDLE_SCHEMA || !isDigest(bundleRef.sha256) || typeof bundleRef.path !== "string") {
    throw new Error("Active evidence evaluation bundle reference is invalid");
  }
  const reportRoot = await realpath(dirname(resolve(reportFile))).catch(() => {
    throw new Error("Active evidence report directory is unavailable");
  });
  const bundlePath = await resolveContainedFile(reportRoot, bundleRef.path, "evaluation bundle");
  const bundleBytes = await readContainedFile(bundlePath, "evaluation bundle");
  if (sha256(bundleBytes) !== bundleRef.sha256) throw new Error("Active evidence evaluation bundle digest does not match");

  let bundle: Record<string, unknown>;
  try {
    bundle = asRecord(JSON.parse(bundleBytes.toString("utf8")), "Active evidence evaluation bundle is invalid");
  } catch {
    throw new Error("Active evidence evaluation bundle is invalid");
  }
  if (bundle.schema_version !== BUNDLE_SCHEMA || !hasExactKeys(bundle, [
    "schema_version", "config", "plan", "tasks", "candidate_evaluations", "evidence_manifest",
  ])) {
    throw new Error("Active evidence evaluation bundle version or schema is invalid");
  }
  const config = asRecord(bundle.config, "Active evidence evaluation bundle is invalid") as unknown as HarnessConfig;
  const plan = asRecord(bundle.plan, "Active evidence evaluation bundle is invalid") as unknown as EvaluationPlan;
  const tasks = asRecordArray(bundle.tasks, "Active evidence evaluation bundle is invalid") as unknown as PairedTask[];
  const candidateEvaluations = asRecordArray(bundle.candidate_evaluations, "Active evidence evaluation bundle is invalid") as unknown as CandidateEvaluation[];
  await validateEvidenceManifest(bundle.evidence_manifest, config, plan, candidateEvaluations, bundlePath, runtime.activeCandidates);

  let recomputed: unknown;
  try {
    recomputed = pairedComparison(config, plan, tasks, candidateEvaluations);
  } catch {
    throw new Error("Active evidence evaluation bundle cannot be evaluated");
  }
  if (jsonDigest(reportWithoutBundle(report)) !== jsonDigest(recomputed)) {
    throw new Error("Active evidence report does not match the paired evaluation bundle");
  }
}

function validateActiveReportBinding(report: Record<string, unknown>, runtime: ActiveEvidenceBinding): void {
  const config = asRecord(report.configuration, "Active evidence has no configuration binding");
  const baseline = asRecord(config.baseline, "Active evidence has no Fallback Baseline");
  const expectedBindings: Array<[string, string, string]> = [
    ["release", runtime.releaseId, "release ID"],
    ["callerEdgeId", runtime.callerEdgeId, "caller-edge ID"],
    ["candidateCatalogId", runtime.candidateCatalogId, "candidate catalog ID"],
    ["jevVersion", runtime.jevVersion, "Jev version"],
    ["policyVersion", runtime.policyVersion, "policy version"],
    ["questionSchemaVersion", runtime.questionSchemaVersion, "question schema version"],
  ];
  for (const [field, expected, label] of expectedBindings) {
    if (!expected || expected === "UNKNOWN" || config[field] !== expected) {
      throw new Error(`Active evidence ${label} does not match the current runtime`);
    }
  }
  if (config.mode !== "active" || baseline.model !== runtime.baseline.model || baseline.effort !== runtime.baseline.effort) {
    throw new Error("Active evidence mode or Fallback Baseline does not match the current runtime");
  }
  const reportPolicy = config.runtimePolicy;
  if (!isValidJevPolicyParameters(runtime.runtimePolicy) || !isValidJevPolicyParameters(reportPolicy) ||
      reportPolicy.confidenceFloor !== runtime.runtimePolicy.confidenceFloor ||
      reportPolicy.deadlineMs !== runtime.runtimePolicy.deadlineMs) {
    throw new Error("Active evidence Jev runtime policy does not match the current runtime");
  }
  if (report.pairing_gate !== "PASS") throw new Error("Active evidence pairing gate is not PASS");
  if (!Number.isInteger(report.tasks) || (report.tasks as number) < 1 || !isDigest(report.evaluation_data_digest) ||
      !hasText(config.planFrozenAt) || !hasText(config.randomizationSeed) || !hasText(config.reviewMethod) ||
      !hasText(config.repositoryRevision) || !hasText(config.repositorySnapshotDigest) ||
      !isDigest(config.taskManifestDigest) || !isDigest(config.priceWeightsDigest)) {
    throw new Error("Active evidence is missing frozen evaluation metadata");
  }
  const taskCount = report.tasks as number;
  const approvedEntries = stringArray(report.active_candidate_allowlist, "Active evidence has no candidate allowlist");
  if (new Set(approvedEntries).size !== approvedEntries.length) throw new Error("Active evidence candidate allowlist contains duplicates");
  const approved = new Set(approvedEntries);
  const configuredEntries = pairArray(config.candidates, "Active evidence has no candidate configuration").map(pairKey);
  if (new Set(configuredEntries).size !== configuredEntries.length) throw new Error("Active evidence candidate configuration contains duplicates");
  const configuredPairs = new Set(configuredEntries);
  const decisions = asRecordArray(report.candidate_decisions, "Active evidence has no candidate decisions");
  for (const candidate of runtime.activeCandidates) {
    const key = pairKey(candidate);
    if (!configuredPairs.has(key) || !approved.has(key)) {
      throw new Error(`Active candidate ${key} is not present in the runtime allowlist approved by the report`);
    }
    const matching = decisions.filter(item => isPair(item.pair, candidate));
    const decision = matching.length === 1 ? matching[0] : undefined;
    if (!decision || decision.active_eligible !== true || !Array.isArray(decision.blockers) || decision.blockers.length !== 0 ||
        ELIGIBILITY_GATES.some(gate => decision[gate] !== "PASS")) {
      throw new Error(`Active candidate ${key} failed an eligibility gate in the evaluation report`);
    }
    validateDecisionEvidenceRefs(decision);
    validateDecisionMetrics(decision, taskCount);
  }
}

interface ExpectedAsset {
  ref: string;
  kind: string;
  candidateId: string | null;
  associationId: string;
  facts?: Record<string, unknown>;
}

async function validateEvidenceManifest(
  value: unknown,
  config: HarnessConfig,
  plan: EvaluationPlan,
  candidates: CandidateEvaluation[],
  bundleFile: string,
  activeCandidates: ModelEffortPair[],
): Promise<void> {
  const manifest = asRecordArray(value, "Active evidence manifest is invalid");
  const configurationDigest = digest(config);
  const expected = expectedEvidenceAssets(candidates, plan, activeCandidates);
  const refs = new Map(expected.map(item => [item.ref, item]));
  if (refs.size !== expected.length || manifest.length !== expected.length) {
    throw new Error("Active evidence manifest does not match the required evidence references");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const seenRefs = new Set<string>();
  const cancellationPhases = new Map<string, Set<string>>();
  const bundleRoot = await realpath(dirname(bundleFile)).catch(() => {
    throw new Error("Active evidence bundle directory is unavailable");
  });
  for (const rawEntry of manifest) {
    const entry = rawEntry;
    if (!hasExactKeys(entry, [
      "id", "ref", "path", "sha256", "kind", "schema_version", "release_id", "candidate_id", "configuration_digest", "association_id",
    ])) throw new Error("Active evidence manifest entry has an unsupported schema");
    const id = requiredText(entry.id);
    const ref = requiredText(entry.ref);
    const path = requiredText(entry.path);
    const kind = requiredText(entry.kind);
    const schema = requiredText(entry.schema_version);
    const expectedAsset = refs.get(ref);
    const expectedSchema = ASSET_SCHEMAS[kind];
    const embeddedDigest = digestFromRef(ref);
    if (!expectedAsset || !expectedSchema || expectedAsset.kind !== kind || schema !== expectedSchema ||
        entry.release_id !== config.release || entry.candidate_id !== expectedAsset.candidateId ||
        entry.configuration_digest !== configurationDigest || entry.association_id !== expectedAsset.associationId ||
        entry.sha256 !== embeddedDigest || !isDigest(entry.sha256) || ids.has(id) || paths.has(path) || seenRefs.has(ref)) {
      throw new Error("Active evidence manifest association or schema does not match the evaluation bundle");
    }
    ids.add(id);
    paths.add(path);
    seenRefs.add(ref);
    const assetFile = await resolveContainedFile(bundleRoot, path, "evidence asset");
    const bytes = await readContainedFile(assetFile, "evidence asset");
    if (sha256(bytes) !== entry.sha256) throw new Error("Active evidence asset digest does not match its manifest");
    let asset: Record<string, unknown>;
    try {
      asset = asRecord(JSON.parse(bytes.toString("utf8")), "Active evidence asset is invalid");
    } catch {
      throw new Error("Active evidence asset is invalid");
    }
    if (!hasExactKeys(asset, ["schema_version", "kind", "release_id", "candidate_id", "configuration_digest", "association_id", "facts"]) ||
        asset.schema_version !== schema || asset.kind !== kind || asset.release_id !== config.release ||
        asset.candidate_id !== expectedAsset.candidateId || asset.configuration_digest !== configurationDigest ||
        asset.association_id !== expectedAsset.associationId) {
      throw new Error("Active evidence asset association or schema does not match its manifest");
    }
    const phase = await validateAssetFacts(kind, asRecord(asset.facts, "Active evidence asset facts are invalid"), expectedAsset, config, bundleRoot);
    if (phase && expectedAsset.candidateId !== null) {
      const phases = cancellationPhases.get(expectedAsset.candidateId) ?? new Set<string>();
      phases.add(phase);
      cancellationPhases.set(expectedAsset.candidateId, phases);
    }
  }
  if (seenRefs.size !== refs.size) throw new Error("Active evidence manifest is missing required evidence assets");
  if ([...new Set(expected.filter(asset => asset.kind === "cancellation" && asset.candidateId !== null &&
      activeCandidates.some(pair => pairKey(pair) === asset.candidateId)).map(asset => asset.candidateId as string))]
    .some(candidateId => cancellationPhases.get(candidateId)?.size !== 2)) {
    throw new Error("Active cancellation evidence must cover Jev wait and upstream generation");
  }
}

function expectedEvidenceAssets(candidates: CandidateEvaluation[], plan: EvaluationPlan, activeCandidates: ModelEffortPair[]): ExpectedAsset[] {
  const expected: ExpectedAsset[] = [];
  const activePairs = new Set(activeCandidates.map(pairKey));
  const requireRefs = (value: unknown, requiredKind: string, candidateId: string, associationId: string, required: boolean): void => {
    const refs = value === undefined && !required ? [] : stringArray(value, "Active evidence candidate has invalid asset references");
    if (!refs.length && required) throw new Error("Active evidence candidate is missing a required evidence asset");
    for (const ref of refs) {
      const kind = evidenceKind(ref);
      if (kind !== requiredKind || ASSET_SCHEMAS[kind] === undefined) throw new Error("Active evidence candidate references an unsupported evidence kind");
      expected.push({ ref, kind, candidateId, associationId });
    }
  };
  for (const candidate of candidates) {
    const candidateId = pairKey(candidate.pair);
    const active = activePairs.has(candidateId);
    const gateRefs = candidate.evidence_refs === undefined ? {} : asRecord(candidate.evidence_refs, "Active evidence candidate references are invalid");
    requireRefs(gateRefs.transport, "transport", candidateId, `${candidateId}:gate:transport`, active);
    requireRefs(gateRefs.cancellation, "cancellation", candidateId, `${candidateId}:gate:cancellation`, active);
    requireRefs(gateRefs.shadow, "shadow", candidateId, `${candidateId}:gate:shadow`, active);
    const paired = candidate.paired_tasks;
    if (!Array.isArray(paired)) throw new Error("Active evidence paired tasks are invalid");
    for (const task of paired) {
      const taskId = requiredText(task.task_id);
      requireQualityRefs(task.baseline, "baseline", taskId, null, plan, expected, active);
      requireQualityRefs(task.policy, "policy", taskId, candidateId, plan, expected, active);
    }
    if (!Array.isArray(candidate.shadow_tasks)) throw new Error("Active evidence Shadow tasks are invalid");
    for (const task of candidate.shadow_tasks as ShadowTaskEvaluation[]) {
      requireQualityRefs(task.run, "shadow", requiredText(task.task_id), candidateId, plan, expected, active);
    }
  }
  const unique = new Map<string, ExpectedAsset>();
  for (const item of expected) {
    const previous = unique.get(item.ref);
    if (previous && (previous.kind !== item.kind || previous.candidateId !== item.candidateId ||
        previous.associationId !== item.associationId || digest(previous.facts ?? null) !== digest(item.facts ?? null))) {
      throw new Error("Active evidence reference is reused across different run associations");
    }
    unique.set(item.ref, item);
  }
  return [...unique.values()];
}

function requireQualityRefs(
  run: EvaluationArm,
  arm: "baseline" | "policy" | "shadow",
  taskId: string,
  candidateId: string | null,
  plan: EvaluationPlan,
  expected: ExpectedAsset[],
  required: boolean,
): void {
  const refs = run.quality_evidence_refs === undefined && !required
    ? []
    : stringArray(run.quality_evidence_refs, "Active evidence quality references are invalid");
  if (refs.length === 0 && required) throw new Error("Active evidence quality assets are missing for an approved candidate");
  const kinds = new Set(refs.map(evidenceKind));
  if (required && (!kinds.has("diff") || !kinds.has("test"))) throw new Error("Active evidence quality assets need a diff and test reference");
  const frozen = plan.tasks.find(task => task.task_id === taskId);
  if (!frozen) throw new Error("Active evidence quality asset is not bound to a frozen task");
  const associationId = `${candidateId === null ? "run" : candidateId}:task:${taskId}:${arm}`;
  for (const ref of refs) {
    const kind = evidenceKind(ref);
    if (kind !== "diff" && kind !== "test" && kind !== "artifact") {
      throw new Error("Active evidence candidate references an unsupported quality asset kind");
    }
    const facts = {
      task_id: taskId,
      arm,
      acceptance_id: frozen.acceptance_id,
      review_method: plan.independent_review_method,
      quality_score: run.quality_score,
      completed: run.completed,
      accepted: run.accepted,
      rework_cycles: run.rework_cycles,
      root_takeover: run.root_takeover,
    };
    expected.push({ ref, kind, candidateId, associationId, facts });
  }
}

async function validateTransportFacts(
  facts: Record<string, unknown>,
  expected: ExpectedAsset,
  config: HarnessConfig,
  bundleRoot: string,
): Promise<void> {
  try {
    if (expected.candidateId === null || !hasExactKeys(facts, [
      "release_id", "candidate_id", "configuration_digest", "association_id", "caller_edge", "aba", "sse", "json", "compaction", "sources",
    ])) throw new Error();
    const candidateId = expected.candidateId;
    const configurationDigest = digest(config);
    if (facts.release_id !== config.release || facts.candidate_id !== candidateId ||
        facts.configuration_digest !== configurationDigest || facts.association_id !== expected.associationId) throw new Error();

    const callerEdge = asRecord(facts.caller_edge, "Active transport evidence facts are invalid");
    if (!hasExactKeys(callerEdge, ["id", "authenticated", "recursive", "source_ref"]) ||
        callerEdge.id !== config.callerEdgeId || callerEdge.authenticated !== true || callerEdge.recursive !== false ||
        !isDigest(callerEdge.source_ref)) throw new Error();

    const aba = asRecord(facts.aba, "Active transport evidence facts are invalid");
    validateAbaFacts(aba, candidateId, config);
    const sse = asRecord(facts.sse, "Active transport evidence facts are invalid");
    validateSseFacts(sse, aba);
    const json = asRecord(facts.json, "Active transport evidence facts are invalid");
    validateJsonFacts(json);
    const compaction = asRecord(facts.compaction, "Active transport evidence facts are invalid");
    validateCompactionFacts(compaction, candidateId, aba, config);
    await validateTransportSources(facts.sources, candidateId, expected.associationId, config, { aba, sse, json, compaction, callerEdge }, bundleRoot);
  } catch {
    throw new Error("Active transport evidence facts are invalid");
  }
}

function validateAbaFacts(aba: Record<string, unknown>, candidateId: string, config: HarnessConfig): void {
  if (!hasExactKeys(aba, ["run_id", "session_id", "calls", "tool_continuations", "terminal_status"]) ||
      !isOpaqueId(aba.run_id) || !isSessionId(aba.session_id) || aba.terminal_status !== "completed") throw new Error();
  const calls = asRecordArray(aba.calls, "Active transport evidence facts are invalid");
  if (calls.length !== 3) throw new Error();
  const models: string[] = [];
  const choiceIds = new Set<string>();
  let previousCompletion: unknown;
  for (const [index, call] of calls.entries()) {
    if (!hasExactKeys(call, ["sequence", "response_mode", "guard_verdict", "proposed_pair", "requested_pair", "applied_pair", "observed_pair", "jev_request_version", "jev_resolved_version", "request_at", "completion_at", "http_status", "terminal_status", "physical_request_count", "choice_id_digest", "tool_call_id_digest", "tool_result_id_digest"]) ||
        call.sequence !== index + 1 || !isRealPair(call.proposed_pair) || !isRealPair(call.requested_pair) || !isRealPair(call.applied_pair) ||
        !isPairKey(call.applied_pair, pairKeyOrUndefined(call.requested_pair) as string) ||
        !isPairKey(call.proposed_pair, pairKeyOrUndefined(call.applied_pair) as string) ||
        (call.response_mode !== "sse" && call.response_mode !== "json") || call.guard_verdict !== "allow" || !isObservedPair(call.observed_pair) || !isHttpSuccess(call.http_status) ||
        call.jev_request_version !== config.jevVersion || call.jev_resolved_version !== config.jevVersion ||
        !isTimestamp(call.request_at) || !isTimestamp(call.completion_at) || !isBefore(call.request_at, call.completion_at) ||
        (previousCompletion !== undefined && !isBeforeOrEqual(previousCompletion, call.request_at)) ||
        call.terminal_status !== "completed" || call.physical_request_count !== 1 || !isDigestToken(call.choice_id_digest) ||
        (!isToolDigestToken(call.tool_call_id_digest)) || (index === 0 ? call.tool_result_id_digest !== null : !isToolDigestToken(call.tool_result_id_digest)) ||
        choiceIds.has(call.choice_id_digest as string)) throw new Error();
    const requested = call.requested_pair as Record<string, unknown>;
    const observed = call.observed_pair as Record<string, unknown>;
    if (observed.model !== requested.model || (observed.effort !== requested.effort && observed.effort !== "UNKNOWN")) throw new Error();
    models.push(requested.model as string);
    choiceIds.add(call.choice_id_digest as string);
    previousCompletion = call.completion_at;
  }
  const candidate = pairFromKey(candidateId);
  if (pairKeyOrUndefined(calls[0].requested_pair) !== pairKeyOrUndefined(calls[2].requested_pair) ||
      pairKeyOrUndefined(calls[0].applied_pair) !== pairKeyOrUndefined(calls[2].applied_pair) ||
      models[0] !== models[2] || models[0] === models[1] || models.some(model => model === "jev/auto") ||
      !calls.some(call => pairKeyOrUndefined(call.proposed_pair) === candidateId && pairKeyOrUndefined(call.requested_pair) === candidateId &&
        pairKeyOrUndefined(call.applied_pair) === candidateId && isObservedCandidate(call.observed_pair, candidate)) ||
      !calls.some(call => {
        const observed = call.observed_pair as Record<string, unknown>;
        return observed.model === candidate.model && (observed.effort === candidate.effort || observed.effort === "UNKNOWN");
      })) throw new Error();
  const continuations = asRecordArray(aba.tool_continuations, "Active transport evidence facts are invalid");
  if (continuations.length !== 2) throw new Error();
  for (const [index, continuation] of continuations.entries()) {
    if (!hasExactKeys(continuation, ["from_call", "to_call", "tool_call_id_digest", "tool_result_id_digest"]) ||
        continuation.from_call !== index + 1 || continuation.to_call !== index + 2 ||
        !isToolDigestToken(continuation.tool_call_id_digest) || !isToolDigestToken(continuation.tool_result_id_digest) ||
        continuation.tool_call_id_digest !== continuation.tool_result_id_digest) throw new Error();
    const from = calls[index];
    const to = calls[index + 1];
    if (continuation.tool_call_id_digest !== from.tool_call_id_digest || continuation.tool_result_id_digest !== to.tool_result_id_digest) throw new Error();
  }
}

function validateSseFacts(sse: Record<string, unknown>, aba: Record<string, unknown>): void {
  if (!hasExactKeys(sse, ["call_sequence", "status", "first_increment_at", "completion_at", "upstream_end_at", "event_order", "terminal_status", "first_increment_before_completion"]) ||
      sse.call_sequence !== 1 || !isHttpSuccess(sse.status) || sse.terminal_status !== "completed" || sse.first_increment_before_completion !== true ||
      !hasEventOrder(sse.event_order) || !isBefore(sse.first_increment_at, sse.completion_at) ||
      !isBeforeOrEqual(sse.completion_at, sse.upstream_end_at) ||
      (asRecordArray(aba.calls, "Active transport evidence facts are invalid")[0].response_mode !== "sse") ||
      asRecordArray(aba.calls, "Active transport evidence facts are invalid")[0].http_status !== sse.status ||
      !isBeforeOrEqual(asRecordArray(aba.calls, "Active transport evidence facts are invalid")[0].request_at, sse.first_increment_at) ||
      sse.completion_at !== asRecordArray(aba.calls, "Active transport evidence facts are invalid")[0].completion_at) throw new Error();
}

function validateJsonFacts(json: Record<string, unknown>): void {
  if (!hasExactKeys(json, ["probe_id_digest", "request_at", "completion_at", "status", "headers_digest", "body_digest", "terminal_status"]) ||
      !isDigestToken(json.probe_id_digest) || !isTimestamp(json.request_at) || !isTimestamp(json.completion_at) ||
      !isBefore(json.request_at, json.completion_at) || !isHttpSuccess(json.status) || !isDigestToken(json.headers_digest) ||
      !isDigestToken(json.body_digest) || json.terminal_status !== "completed") throw new Error();
}

function validateCompactionFacts(compaction: Record<string, unknown>, candidateId: string, aba: Record<string, unknown>, config: HarnessConfig): void {
  if (!hasExactKeys(compaction, [
    "run_id", "session_id", "event_id_digest", "occurred_at", "new_choice_id_digest", "jev_request_version", "jev_resolved_version", "new_choice_at", "request_at", "completion_at",
    "tool_continuation", "proposed_pair", "requested_pair", "applied_pair", "observed_pair", "guard_verdict", "http_status", "terminal_status", "physical_request_count",
    "new_choice",
  ]) || !isOpaqueId(compaction.run_id) || !isSessionId(compaction.session_id) || !isDigestToken(compaction.event_id_digest) ||
      !isDigestToken(compaction.new_choice_id_digest) || compaction.jev_request_version !== config.jevVersion || compaction.jev_resolved_version !== config.jevVersion ||
      !isTimestamp(compaction.occurred_at) || !isTimestamp(compaction.new_choice_at) ||
      !isTimestamp(compaction.request_at) || !isTimestamp(compaction.completion_at) || !isBefore(compaction.occurred_at, compaction.new_choice_at) ||
      !isBefore(compaction.new_choice_at, compaction.request_at) || !isBeforeOrEqual(compaction.request_at, compaction.completion_at) ||
      !isRealPair(compaction.proposed_pair) || !isPairKey(compaction.proposed_pair, candidateId) ||
      !isRealPair(compaction.requested_pair) || !isPairKey(compaction.requested_pair, candidateId) ||
      !isRealPair(compaction.applied_pair) || !isPairKey(compaction.applied_pair, candidateId) ||
      pairKeyOrUndefined(compaction.proposed_pair) !== pairKeyOrUndefined(compaction.applied_pair) ||
      !isObservedPair(compaction.observed_pair) ||
      compaction.guard_verdict !== "allow" ||
      !isHttpSuccess(compaction.http_status) || compaction.terminal_status !== "completed" || compaction.physical_request_count !== 1 ||
      compaction.new_choice !== true) throw new Error();
  const observed = compaction.observed_pair as Record<string, unknown>;
  const candidate = pairFromKey(candidateId);
  if (observed.model !== candidate.model || (observed.effort !== candidate.effort && observed.effort !== "UNKNOWN")) throw new Error();
  const continuation = asRecord(compaction.tool_continuation, "Active transport evidence facts are invalid");
  if (!hasExactKeys(continuation, ["tool_call_id_digest", "tool_result_id_digest", "before_session_id", "after_session_id"]) ||
      !isToolDigestToken(continuation.tool_call_id_digest) || !isToolDigestToken(continuation.tool_result_id_digest) ||
      continuation.tool_call_id_digest !== continuation.tool_result_id_digest ||
      !isSessionId(continuation.before_session_id) || !isSessionId(continuation.after_session_id) ||
      continuation.before_session_id !== compaction.session_id || continuation.after_session_id !== compaction.session_id) throw new Error();
  const calls = asRecordArray(aba.calls, "Active transport evidence facts are invalid");
  if (calls.some(call => call.choice_id_digest === compaction.new_choice_id_digest)) throw new Error();
}

async function validateTransportSources(
  value: unknown,
  candidateId: string,
  associationId: string,
  config: HarnessConfig,
  phaseFacts: {
    aba: Record<string, unknown>;
    sse: Record<string, unknown>;
    json: Record<string, unknown>;
    compaction: Record<string, unknown>;
    callerEdge: Record<string, unknown>;
  },
  bundleRoot: string,
): Promise<void> {
  const sources = asRecordArray(value, "Active transport evidence facts are invalid");
  if (sources.length !== 2 || new Set(sources.map(source => source.phase)).size !== 2 ||
      !sources.every(source => source.phase === "aba" || source.phase === "compaction")) throw new Error();
  const seenPaths = new Set<string>();
  for (const source of sources) {
    if (!hasExactKeys(source, [
      "phase", "path", "sha256", "release_id", "candidate_id", "configuration_digest", "association_id", "run_id", "session_id",
    ]) || source.release_id !== config.release || source.candidate_id !== candidateId || source.configuration_digest !== digest(config) ||
        source.association_id !== associationId || !isOpaqueId(source.run_id) || !isSessionId(source.session_id) ||
        !isDigest(source.sha256) || typeof source.path !== "string" || source.path.length > 256 || seenPaths.has(source.path)) throw new Error();
    seenPaths.add(source.path);
    const path = await resolveContainedFile(bundleRoot, source.path, "transport evidence source");
    const bytes = await readContainedFile(path, "transport evidence source");
    if (bytes.length > MAX_TRANSPORT_SOURCE_BYTES || sha256(bytes) !== source.sha256) throw new Error();
    let document: Record<string, unknown>;
    try {
      document = asRecord(JSON.parse(bytes.toString("utf8")), "Active transport evidence source is invalid");
    } catch {
      throw new Error();
    }
    if (!hasExactKeys(document, [
      "schema_version", "kind", "phase", "release_id", "candidate_id", "configuration_digest", "association_id", "run_id", "session_id", "facts",
    ]) || document.schema_version !== TRANSPORT_SOURCE_SCHEMA || document.kind !== TRANSPORT_SOURCE_KIND ||
        document.phase !== source.phase || document.release_id !== source.release_id || document.candidate_id !== source.candidate_id ||
        document.configuration_digest !== source.configuration_digest || document.association_id !== source.association_id ||
        document.run_id !== source.run_id || document.session_id !== source.session_id) throw new Error();
    const documentFacts = asRecord(document.facts, "Active transport evidence source is invalid");
    const expectedFacts = source.phase === "aba"
      ? {
          aba: phaseFacts.aba,
          sse: phaseFacts.sse,
          json: phaseFacts.json,
          caller_edge: {
            id: phaseFacts.callerEdge.id,
            authenticated: phaseFacts.callerEdge.authenticated,
            recursive: phaseFacts.callerEdge.recursive,
          },
        }
      : { compaction: phaseFacts.compaction };
    const phase = source.phase === "aba" ? phaseFacts.aba : phaseFacts.compaction;
    if (source.run_id !== phase.run_id || source.session_id !== phase.session_id) throw new Error();
    if (!hasExactKeys(documentFacts, Object.keys(expectedFacts)) || jsonDigest(documentFacts) !== jsonDigest(expectedFacts)) throw new Error();
    if (source.phase === "aba" && phaseFacts.callerEdge.source_ref !== source.sha256) throw new Error();
  }
}

async function validateAssetFacts(
  kind: string,
  facts: Record<string, unknown>,
  expected: ExpectedAsset,
  config: HarnessConfig,
  bundleRoot: string,
): Promise<string | undefined> {
  if (kind === "transport") {
    await validateTransportFacts(facts, expected, config, bundleRoot);
    return undefined;
  }
  if (kind === "cancellation") {
    if (!hasExactKeys(facts, ["phase", "cancelled", "replayed", "fallback_started"]) ||
        (facts.phase !== "jev_wait" && facts.phase !== "upstream_generation") || facts.cancelled !== true ||
        facts.replayed !== false || facts.fallback_started !== false) throw new Error("Active cancellation evidence facts are invalid");
    return facts.phase;
  }
  if (kind === "shadow") {
    if (expected.candidateId === null) throw new Error("Active Shadow evidence is not associated with a candidate");
    if (!hasExactKeys(facts, ["mode", "proposed_pair", "executed_pair"]) || facts.mode !== "shadow" ||
        !isPairKey(facts.proposed_pair, expected.candidateId) || !isPairKey(facts.executed_pair, pairKey(config.baseline))) {
      throw new Error("Active Shadow evidence facts are invalid");
    }
    return undefined;
  }
  if (!hasExactKeys(facts, ["task_id", "arm", "acceptance_id", "review_method", "quality_score", "completed", "accepted", "rework_cycles", "root_takeover"]) ||
      !expected.facts || digest(facts) !== digest(expected.facts)) {
    throw new Error("Active quality evidence does not match its frozen task association");
  }
  return undefined;
}

function validateDecisionEvidenceRefs(decision: Record<string, unknown>): void {
  const refs = asRecord(decision.evidence_refs, "Active evidence has no reviewable gate references");
  requireEvidenceRefs(refs.transport, "transport", "transport");
  requireEvidenceRefs(refs.cancellation, "cancellation", "cancellation");
  requireEvidenceRefs(refs.shadow, "Shadow", "shadow");
  requireEvidenceRefs(refs.policy_quality, "paired quality");
  requireEvidenceRefs(refs.shadow_quality, "Shadow quality");
}

function validateDecisionMetrics(decision: Record<string, unknown>, taskCount: number): void {
  const comparison = asRecord(decision.comparison, "Active evidence has no candidate comparison metrics");
  if (comparison.tasks !== taskCount || comparison.shadow_tasks !== taskCount) {
    throw new Error("Active evidence paired and Shadow measurements do not match the frozen task count");
  }
  requireStats(asRecord(comparison.completion_rate, "Active evidence has incomplete policy metrics"), ["baseline", "policy"], 0, 1);
  requireStats(asRecord(comparison.acceptance_rate, "Active evidence has incomplete policy metrics"), ["baseline", "policy"], 0, 1);
  requireStats(asRecord(comparison.quality_score, "Active evidence has incomplete policy metrics"), ["baseline", "policy"], 0);
  requireStats(asRecord(comparison.rework_cycles_per_task, "Active evidence has incomplete policy metrics"), ["baseline", "policy"], 0);
  requireStats(asRecord(comparison.latency_mean_ms, "Active evidence has incomplete policy metrics"), ["baseline", "policy"], 0);
  requireStats(asRecord(comparison.full_cost, "Active evidence has incomplete policy metrics"), ["baseline", "policy", "ratio"], 0);
  const shadow = asRecord(comparison.shadow, "Active evidence has no complete Shadow metrics");
  requireStats(asRecord(shadow.completion_rate, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow"], 0, 1);
  requireStats(asRecord(shadow.acceptance_rate, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow"], 0, 1);
  requireStats(asRecord(shadow.quality_score, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow"], 0);
  requireStats(asRecord(shadow.rework_cycles_per_task, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow"], 0);
  requireStats(asRecord(shadow.root_takeovers, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow"], 0);
  requireStats(asRecord(shadow.latency_mean_ms, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow"], 0);
  requireStats(asRecord(shadow.full_cost, "Active evidence has incomplete Shadow metrics"), ["baseline", "shadow", "ratio"], 0);
}

async function resolveContainedFile(root: string, relativePath: string, label: string): Promise<string> {
  if (!isSafeRelativePath(relativePath)) throw new Error(`Active evidence ${label} path must be a contained relative path`);
  const resolved = resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, resolved)) throw new Error(`Active evidence ${label} path must be a contained relative path`);
  const real = await realpath(resolved).catch(() => {
    throw new Error(`Active evidence ${label} is missing or unavailable`);
  });
  if (!isWithin(root, real)) throw new Error(`Active evidence ${label} path must be a contained relative path`);
  return real;
}

async function readContainedFile(path: string, label: string): Promise<Buffer> {
  return readFile(path).catch(() => {
    throw new Error(`Active evidence ${label} is missing or unavailable`);
  });
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes(":") &&
    !isAbsolute(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function reportWithoutBundle(report: Record<string, unknown>): Record<string, unknown> {
  const { active_evidence_bundle: _bundle, ...result } = report;
  return result;
}

function jsonDigest(value: unknown): string {
  return digest(JSON.parse(JSON.stringify(value)) as unknown);
}

function evidenceKind(ref: string): string {
  const match = /^([a-z][a-z0-9_-]*):sha256:[0-9a-f]{64}$/.exec(ref);
  if (!match) throw new Error("Active evidence reference is malformed");
  return match[1];
}

function digestFromRef(ref: string): string | undefined {
  return /^([a-z][a-z0-9_-]*):sha256:([0-9a-f]{64})$/.exec(ref)?.[2];
}

function hasExactKeys(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === fields.length && keys.every((key, index) => key === [...fields].sort()[index]);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown, message: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(message);
  return value.map(item => asRecord(item, message));
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(message);
  return value as string[];
}

function pairArray(value: unknown, message: string): ModelEffortPair[] {
  return asRecordArray(value, message).map(item => {
    if (typeof item.model !== "string" || typeof item.effort !== "string") throw new Error(message);
    return { model: item.model, effort: item.effort };
  });
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Active evidence manifest is invalid");
  return value;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "UNKNOWN";
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isDigestToken(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isToolDigestToken(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{24}$/.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isSessionId(value: unknown): value is string {
  return isDigestToken(value);
}

function isRealPair(value: unknown): value is Record<string, unknown> {
  if (!isPairKey(value, pairKeyOrUndefined(value) ?? "")) return false;
  const pair = value as Record<string, unknown>;
  return isRealModel(pair.model) && pair.effort !== "";
}

function isObservedPair(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ["model", "effort"])) return false;
  const pair = value as Record<string, unknown>;
  return typeof pair.model === "string" && isRealModel(pair.model) &&
    (typeof pair.effort === "string" && pair.effort.length > 0);
}

function isObservedCandidate(value: unknown, candidate: ModelEffortPair): boolean {
  if (!isObservedPair(value)) return false;
  const observed = value as Record<string, unknown>;
  return observed.model === candidate.model && (observed.effort === candidate.effort || observed.effort === "UNKNOWN");
}

function isRealModel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "UNKNOWN" && value !== "jev/auto" && !value.startsWith("jev/");
}

function isHttpSuccess(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 200 && (value as number) < 300;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isBefore(left: unknown, right: unknown): boolean {
  return isTimestamp(left) && isTimestamp(right) && Date.parse(left) < Date.parse(right);
}

function isBeforeOrEqual(left: unknown, right: unknown): boolean {
  return isTimestamp(left) && isTimestamp(right) && Date.parse(left) <= Date.parse(right);
}

function hasEventOrder(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value[0] === "first_increment" && value[1] === "completion" && value[2] === "upstream_end";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireEvidenceRefs(value: unknown, label: string, requiredKind?: string): void {
  const refs = stringArray(value, `Active evidence has no ${label} evidence references`);
  if (!refs.length || refs.some(ref => !isEvidenceRef(ref)) || (requiredKind && !refs.some(ref => ref.startsWith(`${requiredKind}:`)))) {
    throw new Error(`Active evidence has no valid ${label} evidence references`);
  }
}

function isEvidenceRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]*:sha256:[0-9a-f]{64}$/.test(value);
}

function requireStats(values: Record<string, unknown>, fields: string[], minimum: number, maximum = Number.POSITIVE_INFINITY): void {
  for (const field of fields) {
    const value = values[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error("Active evidence has incomplete Shadow or policy metrics");
    }
  }
}

function isPair(value: unknown, pair: ModelEffortPair): boolean {
  return pairKeyOrUndefined(value) === pairKey(pair);
}

function isPairKey(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    hasExactKeys(value as Record<string, unknown>, ["model", "effort"]) && pairKeyOrUndefined(value) === key;
}

function pairKeyOrUndefined(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.model === "string" && typeof candidate.effort === "string"
    ? `${candidate.model}/${candidate.effort}`
    : undefined;
}

function pairKey(pair: ModelEffortPair): string {
  return `${pair.model}/${pair.effort}`;
}

function pairFromKey(value: string): ModelEffortPair {
  const separator = value.lastIndexOf("/");
  return { model: value.slice(0, separator), effort: value.slice(separator + 1) };
}
