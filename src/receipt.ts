import { UNKNOWN, addUsage, type CallStatus, type EntryKind, type Mode, type RouteReason, type RouteSource, type StepType, type TokenUsage, type Usage } from "./types.js";
import { hasPinnedJevVersion, isPinnedJevVersion } from "./jev-adapter.js";
import type { ObservedExecution, RouteObservation } from "./execution-contract.js";
import type { JevDecision } from "./route-plan.js";
import type { GuardReason } from "./policy-guard.js";
import type { TaskState, VerificationResult } from "./verification.js";

/**
 * Per-call and per-task records (Router Compass input). Records are
 * evidence, never routing authority. The three pair columns — proposed,
 * applied, observed — are independent facts and are never backfilled from
 * one another (spec §8). Raw prompts and tool-output text never enter
 * records; digests only.
 */
export interface CallRecord {
  task_id: string;
  call_index: number;
  step_type: StepType;
  entry: EntryKind;
  mode: Mode;
  policy_version: string;
  question_schema_version: string;
  jev_requested_version: string | "UNKNOWN";
  jev_resolved_version: string | "UNKNOWN";
  jev_confidence_floor: number | "UNKNOWN";
  jev_deadline_ms: number | "UNKNOWN";
  eligible_pairs: string[];
  /** Jev's answer, if one existed. */
  proposed_pair_id?: string;
  proposed_model: string | "UNKNOWN";
  proposed_effort: string | "UNKNOWN";
  jev_confidence?: number;
  /** Jev's Choice result is separate from the route reason used for execution. */
  jev_choice_result?: JevChoiceResult;
  /** Only bounded adapter classifications are persisted; raw errors never are. */
  jev_failure_subreason?: JevFailureSubreason;
  guard_verdict?: "allow" | "deny";
  guard_reason?: GuardReason;
  original_model: string;
  /** The pair placed in the upstream request; UNKNOWN when none was sent. */
  applied_model: string | "UNKNOWN";
  applied_effort: string | "UNKNOWN";
  /** What the upstream response authoritatively reports; UNKNOWN until then. */
  observed_model: string | "UNKNOWN";
  observed_effort: string | "UNKNOWN";
  observation: RouteObservation | "pending";
  route_source: RouteSource;
  reason?: RouteReason;
  astra_eligibility_reason?: string;
  jev_input_tokens: Usage;
  jev_output_tokens: Usage;
  jev_latency_ms: number;
  /** HTTP and first-output evidence from the caller-edge response. */
  upstream_http_status: number | "UNKNOWN";
  upstream_started_at: string | "UNKNOWN";
  first_output_delta_at: string | "UNKNOWN";
  time_to_first_output_delta_ms: Usage;
  response_completed_at: string | "UNKNOWN";
  upstream_completion_ms: Usage;
  /** Stable digests link tool calls to later results without storing raw IDs. */
  response_tool_call_refs: string[];
  request_tool_result_refs: string[];
  model_input_tokens: Usage;
  model_cached_tokens: Usage;
  model_cache_write_tokens: Usage;
  model_output_tokens: Usage;
  model_reasoning_tokens: Usage;
  model_latency_ms: number;
  call_status: CallStatus;
}

export interface TaskRecord {
  task_id: string;
  verification: "PASS" | "FAIL";
  evidence_refs: string[];
  first_pass: boolean;
  correction_cycles: number;
  root_takeover: boolean;
  critical_failure: boolean;
}

export const POLICY_VERSION = "per-call/1";

export interface CallRecordInput {
  task_id: string;
  call_index: number;
  step_type: StepType;
  entry: EntryKind;
  mode: Mode;
  jevConfidenceFloor?: number;
  jevDeadlineMs?: number;
  decision?: JevDecision;
  eligiblePairs: string[];
  /** Resolved proposed pair; the raw pair_id is always kept separately. */
  proposedPair?: { model: string; effort: string };
  guardVerdict?: "allow" | "deny";
  guardReason?: GuardReason;
  appliedPair?: { model: string; effort: string };
  originalModel: string;
  route_source: RouteSource;
  reason?: RouteReason;
  astra_eligibility_reason?: string;
  /** Present when the response has already been scanned (tests, harnesses). */
  observed?: ObservedExecution;
  upstream_http_status?: number;
  upstream_started_at?: string;
  first_output_delta_at?: string;
  time_to_first_output_delta_ms?: Usage;
  response_completed_at?: string;
  upstream_completion_ms?: Usage;
  response_tool_call_refs?: string[];
  request_tool_result_refs?: string[];
  model_latency_ms: number;
  call_status: CallStatus;
}

export type JevChoiceResult =
  | "choice_accepted"
  | "jev_timeout"
  | "jev_failure"
  | "invalid_choice"
  | "low_confidence"
  | "jev_version_mismatch";

const JEV_FAILURE_SUBREASONS = [
  "deadline_exhausted",
  "auth",
  "rate_limited",
  "non_retryable",
  "network",
  "empty_candidate_set",
  "version_drift",
  "version_missing",
  "version_unpinned",
  "unknown_pair_id",
  "invalid_confidence",
  "low_confidence",
  "other",
] as const;

export type JevFailureSubreason = typeof JEV_FAILURE_SUBREASONS[number];

function jevVersionFailureSubreason(decision: JevDecision): "version_drift" | "version_missing" | "version_unpinned" {
  if (decision.jev_resolved_version === UNKNOWN) return "version_missing";
  if (!isPinnedJevVersion(decision.jev_requested_version)) return "version_unpinned";
  return "version_drift";
}

function jevChoiceResultOf(decision: JevDecision | undefined, guardReason?: GuardReason): JevChoiceResult | undefined {
  if (!decision) return undefined;
  if (guardReason === "VERSION_DRIFT" || (decision.valid && !hasPinnedJevVersion(decision.jev_requested_version, decision.jev_resolved_version))) {
    return "jev_version_mismatch";
  }
  if (decision.valid) return "choice_accepted";
  switch (decision.failure_reason) {
    case "timeout": return "jev_timeout";
    case "transport": return "jev_failure";
    case "floor": return "low_confidence";
    case "malformed":
      return decision.failure_subreason === "version_drift" ? "jev_version_mismatch" : "invalid_choice";
    default: return undefined;
  }
}

function jevFailureSubreasonOf(decision: JevDecision | undefined, guardReason?: GuardReason): JevFailureSubreason | undefined {
  if (decision && (guardReason === "VERSION_DRIFT" || (decision.valid && !hasPinnedJevVersion(decision.jev_requested_version, decision.jev_resolved_version)))) {
    return jevVersionFailureSubreason(decision);
  }
  const subreason = decision?.failure_subreason;
  if (subreason === undefined) return undefined;
  return JEV_FAILURE_SUBREASONS.includes(subreason as JevFailureSubreason)
    ? subreason as JevFailureSubreason
    : "other";
}

export function buildCallRecord(input: CallRecordInput): CallRecord {
  const decision = input.decision;
  return {
    task_id: input.task_id,
    call_index: input.call_index,
    step_type: input.step_type,
    entry: input.entry,
    mode: input.mode,
    policy_version: POLICY_VERSION,
    question_schema_version: decision?.question_schema_version ?? "UNKNOWN",
    jev_requested_version: decision?.jev_requested_version ?? "UNKNOWN",
    jev_resolved_version: decision?.jev_resolved_version ?? "UNKNOWN",
    jev_confidence_floor: input.jevConfidenceFloor ?? UNKNOWN,
    jev_deadline_ms: input.jevDeadlineMs ?? UNKNOWN,
    eligible_pairs: input.eligiblePairs,
    proposed_pair_id: decision?.chosen_pair_id,
    proposed_model: input.proposedPair?.model ?? UNKNOWN,
    proposed_effort: input.proposedPair?.effort ?? UNKNOWN,
    jev_confidence: decision?.confidence,
    jev_choice_result: jevChoiceResultOf(decision, input.guardReason),
    jev_failure_subreason: jevFailureSubreasonOf(decision, input.guardReason),
    guard_verdict: input.guardVerdict,
    guard_reason: input.guardReason,
    original_model: input.originalModel,
    applied_model: input.appliedPair?.model ?? UNKNOWN,
    applied_effort: input.appliedPair?.effort ?? UNKNOWN,
    observed_model: input.observed?.actual_model ?? UNKNOWN,
    observed_effort: input.observed?.actual_effort ?? UNKNOWN,
    observation: input.observed?.observation ?? "pending",
    route_source: input.route_source,
    reason: input.reason,
    astra_eligibility_reason: input.astra_eligibility_reason,
    jev_input_tokens: decision?.jev_usage.input_tokens ?? UNKNOWN,
    jev_output_tokens: decision?.jev_usage.output_tokens ?? UNKNOWN,
    jev_latency_ms: decision?.jev_latency_ms ?? 0,
    upstream_http_status: input.upstream_http_status ?? UNKNOWN,
    upstream_started_at: input.upstream_started_at ?? UNKNOWN,
    first_output_delta_at: input.first_output_delta_at ?? UNKNOWN,
    time_to_first_output_delta_ms: input.time_to_first_output_delta_ms ?? UNKNOWN,
    response_completed_at: input.response_completed_at ?? UNKNOWN,
    upstream_completion_ms: input.upstream_completion_ms ?? UNKNOWN,
    response_tool_call_refs: input.response_tool_call_refs ?? [],
    request_tool_result_refs: input.request_tool_result_refs ?? [],
    model_input_tokens: input.observed?.usage.input_tokens ?? UNKNOWN,
    model_cached_tokens: input.observed?.usage.cached_input_tokens ?? UNKNOWN,
    model_cache_write_tokens: input.observed?.usage.cache_write_input_tokens ?? UNKNOWN,
    model_output_tokens: input.observed?.usage.output_tokens ?? UNKNOWN,
    model_reasoning_tokens: input.observed?.usage.reasoning_tokens ?? UNKNOWN,
    model_latency_ms: input.model_latency_ms,
    call_status: input.call_status,
  };
}

export function buildTaskRecord(task: TaskState, result: VerificationResult, firstPass: boolean): TaskRecord {
  return {
    task_id: task.task_id,
    verification: result.verification,
    evidence_refs: result.evidence_refs,
    first_pass: firstPass,
    correction_cycles: task.correction_cycles,
    root_takeover: task.status === "taken_over",
    critical_failure: task.status === "taken_over",
  };
}

// ---------------------------------------------------------------------------
// Compass aggregation: computed from records, never re-persisted, never fed
// back into online routing.
// ---------------------------------------------------------------------------

export interface CompassMetrics {
  /** Top-level product metrics, capped at eight. */
  final_completion_rate: number | "UNKNOWN";
  first_pass_rate: number | "UNKNOWN";
  critical_failure_rate: number | "UNKNOWN";
  root_takeover_rate: number | "UNKNOWN";
  actual_weighted_cost_per_task: Usage;
  frontier_tokens_per_task: Usage;
  jev_cost_share: number | "UNKNOWN";
  actual_model_switches_per_task: number | "UNKNOWN";
}

export interface CompassDiagnostics {
  correction_cycles: number[];
  latency_ms: number[];
  tier_call_share: Record<string, number>;
  cache_hit_ratio: number | "UNKNOWN";
  astra_usage_rate: number | "UNKNOWN";
}

export interface PriceTable {
  /** Price per million tokens by model: input and output. */
  [model: string]: { input: number; output: number };
}

function sum(values: Usage[]): Usage {
  return values.reduce<Usage>((acc, v) => (acc === UNKNOWN || v === UNKNOWN ? UNKNOWN : acc + v), 0);
}

function rate(numerator: number, denominator: number): number | "UNKNOWN" {
  return denominator === 0 ? "UNKNOWN" : numerator / denominator;
}

/**
 * Aggregates records. Any UNKNOWN usage in an aggregate makes that aggregate
 * UNKNOWN — never zero. Route sources are kept separate so no fallback is
 * attributed to Jev and no bypass is counted as a routing win. Aggregates
 * read the observed column only; unobserved calls stay UNKNOWN.
 */
export function compass(callRecords: CallRecord[], taskRecords: TaskRecord[], prices: PriceTable): {
  metrics: CompassMetrics;
  diagnostics: CompassDiagnostics;
} {
  const tasks = taskRecords.length;
  const completed = taskRecords.filter(t => t.verification === "PASS").length;
  const firstPass = taskRecords.filter(t => t.first_pass).length;
  const critical = taskRecords.filter(t => t.critical_failure).length;
  const takeovers = taskRecords.filter(t => t.root_takeover).length;

  let totalCost: Usage = 0;
  let jevCost: Usage = 0;
  for (const call of callRecords) {
    const price = call.observed_model === UNKNOWN ? undefined : prices[call.observed_model];
    if (price && call.model_input_tokens !== UNKNOWN && call.model_output_tokens !== UNKNOWN) {
      const cost =
        (call.model_input_tokens / 1e6) * price.input +
        (call.model_output_tokens / 1e6) * price.output;
      totalCost = totalCost === UNKNOWN ? UNKNOWN : (totalCost as number) + cost;
    } else {
      totalCost = UNKNOWN;
    }
    if (call.jev_input_tokens !== UNKNOWN && call.jev_output_tokens !== UNKNOWN) {
      const cost = (call.jev_input_tokens as number) + (call.jev_output_tokens as number);
      jevCost = jevCost === UNKNOWN ? UNKNOWN : (jevCost as number) + cost;
    } else {
      jevCost = UNKNOWN;
    }
  }

  const frontierCalls = callRecords.filter(c =>
    c.observed_model !== UNKNOWN && (c.observed_model.includes("sol") || c.observed_model.includes("gpt-6")));
  const frontierTokens = sum(frontierCalls.map(callFrontierTokens));

  let switches = 0;
  const byTask = new Map<string, string | undefined>();
  for (const call of [...callRecords].sort((a, b) => a.call_index - b.call_index)) {
    const previous = byTask.get(call.task_id);
    // UNKNOWN observations never assert a switch or a stay.
    if (call.observed_model === UNKNOWN) continue;
    if (previous !== undefined && previous !== call.observed_model) switches += 1;
    byTask.set(call.task_id, call.observed_model);
  }

  const tierShare: Record<string, number> = {};
  for (const call of callRecords) {
    const model = call.observed_model;
    const tier = model === UNKNOWN
      ? "unknown"
      : model.includes("luna")
        ? "luna_max"
        : model.includes("sol")
          ? "sol"
          : model.includes("gpt-6")
            ? "astra"
            : "other";
    tierShare[tier] = (tierShare[tier] ?? 0) + 1;
  }

  const inputTotal = sum(callRecords.map(c => c.model_input_tokens));
  const cachedTotal = sum(callRecords.map(c => c.model_cached_tokens));
  const jevShareDenominator = totalCost;
  const jevShare =
    jevCost === UNKNOWN || jevShareDenominator === UNKNOWN || (jevShareDenominator as number) === 0
      ? "UNKNOWN"
      : (jevCost as number) / (jevShareDenominator as number);

  return {
    metrics: {
      final_completion_rate: rate(completed, tasks),
      first_pass_rate: rate(firstPass, tasks),
      critical_failure_rate: rate(critical, tasks),
      root_takeover_rate: rate(takeovers, tasks),
      actual_weighted_cost_per_task: tasks === 0 ? "UNKNOWN" : totalCost === UNKNOWN ? UNKNOWN : (totalCost as number) / tasks,
      frontier_tokens_per_task: tasks === 0 ? "UNKNOWN" : frontierTokens === UNKNOWN ? UNKNOWN : (frontierTokens as number) / tasks,
      jev_cost_share: jevShare,
      actual_model_switches_per_task: rate(switches, tasks),
    },
    diagnostics: {
      correction_cycles: taskRecords.map(t => t.correction_cycles),
      latency_ms: callRecords.map(c => c.model_latency_ms),
      tier_call_share: tierShare,
      cache_hit_ratio:
        inputTotal === UNKNOWN || cachedTotal === UNKNOWN || (inputTotal as number) === 0
          ? "UNKNOWN"
          : (cachedTotal as number) / (inputTotal as number),
      astra_usage_rate: rate(tierShare.astra ?? 0, callRecords.length),
    },
  };
}

function callFrontierTokens(call: CallRecord): Usage {
  return sum([call.model_input_tokens, call.model_output_tokens, call.model_reasoning_tokens]);
}

export function usageOf(call: CallRecord): Usage {
  return sum([call.model_input_tokens, call.model_output_tokens]);
}

export { addUsage };
