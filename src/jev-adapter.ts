import { randomUUID } from "node:crypto";
import type { CandidateSet } from "./catalog.js";
import {
  buildQuestion,
  CHOICE_INSTRUCTION,
  QUESTION_SCHEMA_VERSION,
  type JevDecision,
  type JevFailureKind,
  type JevUsage,
  type RoutingState,
} from "./route-plan.js";

export type { JevDecision };

export interface JevTransportRequest {
  model: string;
  state: RoutingState;
  questions: {
    route: { type: "choice"; instructions: string; criteria: Record<string, string> };
  };
}

export interface JevTransportResponse {
  model?: string;
  choice?: string;
  confidence?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One POST to the Jev API. Exactly one attempt per Choice; no internal retry. */
export type JevTransport = (
  request: JevTransportRequest,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<JevTransportResponse>;

export interface JevPolicy {
  /** Pinned, validated version for active routing; jev-latest is shadow-only. */
  jevVersion: string;
  confidenceFloor: number;
  /** Short hot-path deadline derived from shadow latency data. */
  deadlineMs: number;
}

export type JevPolicyParameters = Pick<JevPolicy, "confidenceFloor" | "deadlineMs">;

export const MAX_JEV_DEADLINE_MS = 2_147_483_647;

export function isValidJevPolicyParameters(value: unknown): value is JevPolicyParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const parameters = value as Record<string, unknown>;
  return typeof parameters.confidenceFloor === "number" && Number.isFinite(parameters.confidenceFloor) &&
    parameters.confidenceFloor >= 0 && parameters.confidenceFloor <= 1 &&
    typeof parameters.deadlineMs === "number" && Number.isSafeInteger(parameters.deadlineMs) &&
    parameters.deadlineMs >= 1 && parameters.deadlineMs <= MAX_JEV_DEADLINE_MS;
}

export const DEFAULT_JEV_POLICY: JevPolicy = {
  jevVersion: "jev-1.13.0",
  confidenceFloor: 0.55,
  deadlineMs: 2_000,
};

/** A pinned version names one concrete release; aliases are shadow-only (spec §5). */
export function isPinnedJevVersion(version: string): boolean {
  return version.length > 0 && version.trim() === version && version !== "UNKNOWN" && !version.endsWith("-latest");
}

/** A Choice is version-qualified only when a pinned request is confirmed exactly. */
export function hasPinnedJevVersion(requested: string, resolved: string | "UNKNOWN"): boolean {
  return isPinnedJevVersion(requested) && resolved !== "UNKNOWN" && resolved === requested;
}

export class JevTimeoutError extends Error {
  constructor() {
    super("jev deadline exceeded");
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function usageOf(response: JevTransportResponse): JevUsage {
  return {
    input_tokens: response.usage?.input_tokens ?? "UNKNOWN",
    output_tokens: response.usage?.output_tokens ?? "UNKNOWN",
  };
}

function failure(
  candidateSetDigest: string,
  policy: JevPolicy,
  reason: JevFailureKind,
  subreason: string,
  latencyMs: number,
  usage: JevUsage,
  resolvedVersion = "UNKNOWN",
): JevDecision {
  return {
    decision_id: randomUUID(),
    candidate_set_digest: candidateSetDigest,
    jev_requested_version: policy.jevVersion,
    jev_resolved_version: resolvedVersion,
    question_schema_version: QUESTION_SCHEMA_VERSION,
    valid: false,
    failure_reason: reason,
    failure_subreason: subreason,
    jev_latency_ms: latencyMs,
    jev_usage: usage,
  };
}

/**
 * The single seam to the Jev API. One eligible call makes exactly one
 * Choice request over the pair IDs inside the deadline; there is no retry,
 * so every failure is terminal and reported as-is. The adapter never
 * invents a route and never emits a fallback itself.
 */
export async function choose(
  state: RoutingState,
  candidateSet: CandidateSet,
  policy: JevPolicy,
  transport: JevTransport,
  signal?: AbortSignal,
): Promise<JevDecision> {
  const pairIds = candidateSet.pairs.map(pair => pair.pair_id);
  if (pairIds.length === 0) {
    return failure(candidateSet.digest, policy, "malformed", "empty_candidate_set", 0, usageOf({}));
  }
  const question = buildQuestion(state, pairIds);
  const request: JevTransportRequest = {
    model: policy.jevVersion,
    state,
    questions: {
      route: {
        type: "choice",
        instructions: CHOICE_INSTRUCTION,
        criteria: Object.fromEntries(candidateSet.pairs.map(pair => [
          pair.pair_id,
          `Model ${pair.model}; reasoning effort ${pair.effort}; tier ${pair.tier}.`,
        ])),
      },
    },
  };

  const started = Date.now();
  try {
    const response = await transport(request, policy.deadlineMs, signal);
    const latency = Date.now() - started;
    if (response.choice === undefined || !pairIds.includes(response.choice)) {
      return failure(candidateSet.digest, policy, "malformed", "unknown_pair_id", latency, usageOf(response), response.model ?? "UNKNOWN");
    }
    const confidence = response.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return failure(candidateSet.digest, policy, "malformed", "invalid_confidence", latency, usageOf(response), response.model ?? "UNKNOWN");
    }
    if (confidence < policy.confidenceFloor) {
      return {
        ...failure(candidateSet.digest, policy, "floor", "low_confidence", latency, usageOf(response), response.model ?? "UNKNOWN"),
        chosen_pair_id: response.choice,
        confidence,
        valid: false,
      };
    }
    return {
      decision_id: randomUUID(),
      candidate_set_digest: candidateSet.digest,
      jev_requested_version: policy.jevVersion,
      jev_resolved_version: response.model ?? "UNKNOWN",
      question_schema_version: question.schema_version,
      chosen_pair_id: response.choice,
      confidence,
      valid: true,
      jev_latency_ms: latency,
      jev_usage: usageOf(response),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof JevTimeoutError) {
      return failure(candidateSet.digest, policy, "timeout", "deadline_exhausted", Date.now() - started, usageOf({}));
    }
    const subreason = error instanceof Error ? errorSubreason(error) : "network";
    return failure(candidateSet.digest, policy, "transport", subreason, Date.now() - started, usageOf({}));
  }
}

function errorSubreason(error: Error): string {
  const message = error.message.toLowerCase();
  if (message.includes("401") || message.includes("403")) return "auth";
  if (message.includes("429")) return "rate_limited";
  if (message.includes("auth")) return "auth";
  if (message.includes("non_retryable")) return "non_retryable";
  return "network";
}
