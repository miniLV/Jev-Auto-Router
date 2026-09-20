import { UNKNOWN, addUsage, type Mode, type RouteSource, type StepType, type TokenUsage, type Usage } from "./types.js";
import type { ObservedExecution } from "./execution-contract.js";
import type { JevDecision } from "./route-plan.js";
import type { TaskState, VerificationResult } from "./verification.js";

/**
 * Per-call and per-task records (Router Compass input). Records are
 * evidence, never routing authority. Raw prompts and tool-output text
 * never enter records; digests only.
 */
export interface CallRecord {
  task_id: string;
  call_index: number;
  step_type: StepType;
  mode: Mode;
  policy_version: string;
  question_schema_version: string;
  jev_requested_version: string | "UNKNOWN";
  jev_resolved_version: string | "UNKNOWN";
  eligible_pairs: string[];
  jev_choice?: string;
  confidence?: number;
  actual_model: string;
  actual_effort: string;
  route_source: RouteSource;
  fallback_reason?: string;
  gpt6_eligibility_reason?: string;
  jev_input_tokens: Usage;
  jev_output_tokens: Usage;
  jev_latency_ms: number;
  model_input_tokens: Usage;
  model_cached_tokens: Usage;
  model_cache_write_tokens: Usage;
  model_output_tokens: Usage;
  model_reasoning_tokens: Usage;
  model_latency_ms: number;
  call_status: "ok" | "error" | "cancelled";
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
  mode: Mode;
  decision?: JevDecision;
  eligiblePairs: string[];
  selectedPair: { model: string; effort: string };
  route_source: RouteSource;
  fallback_reason?: string;
  gpt6_eligibility_reason?: string;
  observed?: ObservedExecution;
  model_latency_ms: number;
  call_status: CallRecord["call_status"];
}

export function buildCallRecord(input: CallRecordInput): CallRecord {
  const decision = input.decision;
  return {
    task_id: input.task_id,
    call_index: input.call_index,
    step_type: input.step_type,
    mode: input.mode,
    policy_version: POLICY_VERSION,
    question_schema_version: decision?.question_schema_version ?? "UNKNOWN",
    jev_requested_version: decision?.jev_requested_version ?? "UNKNOWN",
    jev_resolved_version: decision?.jev_resolved_version ?? "UNKNOWN",
    eligible_pairs: input.eligiblePairs,
    jev_choice: decision?.chosen_pair_id,
    confidence: decision?.confidence,
    actual_model: input.observed?.actual_model ?? input.selectedPair.model,
    actual_effort: input.observed?.actual_effort ?? input.selectedPair.effort,
    route_source: input.route_source,
    fallback_reason: input.fallback_reason,
    gpt6_eligibility_reason: input.gpt6_eligibility_reason,
    jev_input_tokens: decision?.jev_usage.input_tokens ?? UNKNOWN,
    jev_output_tokens: decision?.jev_usage.output_tokens ?? UNKNOWN,
    jev_latency_ms: decision?.jev_latency_ms ?? 0,
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
  gpt6_usage_rate: number | "UNKNOWN";
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
 * attributed to Jev and no bypass is counted as a routing win.
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
    const price = prices[call.actual_model];
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

  const frontierCalls = callRecords.filter(c => c.actual_model.includes("sol") || c.actual_model.includes("gpt-6"));
  const frontierTokens = sum(frontierCalls.map(callFrontierTokens));

  let switches = 0;
  let byTask = new Map<string, string | undefined>();
  for (const call of [...callRecords].sort((a, b) => a.call_index - b.call_index)) {
    const previous = byTask.get(call.task_id);
    if (previous !== undefined && previous !== call.actual_model) switches += 1;
    byTask.set(call.task_id, call.actual_model);
  }

  const tierShare: Record<string, number> = {};
  for (const call of callRecords) {
    const tier = call.actual_model.includes("luna")
      ? "luna_max"
      : call.actual_model.includes("terra")
        ? "terra"
        : call.actual_model.includes("sol")
          ? "sol"
          : call.actual_model.includes("gpt-6")
            ? "gpt6"
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
      gpt6_usage_rate: rate(tierShare.gpt6 ?? 0, callRecords.length),
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
