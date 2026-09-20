import { randomUUID } from "node:crypto";
import type { CandidateSet } from "./catalog.js";
import {
  buildQuestion,
  CHOICE_INSTRUCTION,
  type JevDecision,
  type JevFailureKind,
  type JevUsage,
  type RoutingState,
} from "./route-plan.js";

export type { JevDecision };

export interface JevTransportRequest {
  model: string;
  question: { type: "Choice"; instruction: string; options: string[]; context: unknown };
}

export interface JevTransportResponse {
  model?: string;
  choice?: string;
  confidence?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One POST to the Jev API. Implementations must not retry internally. */
export type JevTransport = (request: JevTransportRequest, timeoutMs: number) => Promise<JevTransportResponse>;

export interface JevPolicy {
  /** Pinned, validated version for active routing; jev-latest is shadow-only. */
  jevVersion: string;
  confidenceFloor: number;
  /** Short hot-path deadline derived from shadow latency data. */
  deadlineMs: number;
}

export const DEFAULT_JEV_POLICY: JevPolicy = {
  jevVersion: "jev-1.13.0",
  confidenceFloor: 0.55,
  deadlineMs: 2_000,
};

export class JevTimeoutError extends Error {
  constructor() {
    super("jev deadline exceeded");
  }
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
): JevDecision {
  return {
    decision_id: randomUUID(),
    candidate_set_digest: candidateSetDigest,
    jev_requested_version: policy.jevVersion,
    jev_resolved_version: "UNKNOWN",
    question_schema_version: "choice-pairs/1",
    valid: false,
    failure_reason: reason,
    failure_subreason: subreason,
    jev_latency_ms: latencyMs,
    jev_usage: usage,
  };
}

/**
 * The single seam to the Jev API. One request = one Choice over the pair
 * IDs. At most one fast retry for transport-level failures inside the
 * deadline; malformed, drift and non-retryable responses are terminal.
 * The adapter never invents a route and never emits a fallback itself.
 */
export async function choose(
  state: RoutingState,
  candidateSet: CandidateSet,
  policy: JevPolicy,
  transport: JevTransport,
): Promise<JevDecision> {
  const pairIds = candidateSet.pairs.map(pair => pair.pair_id);
  if (pairIds.length === 0) {
    return failure(candidateSet.digest, policy, "malformed", "empty_candidate_set", 0, usageOf({}));
  }
  const question = buildQuestion(state, pairIds);
  const request: JevTransportRequest = {
    model: policy.jevVersion,
    question: {
      type: "Choice",
      instruction: CHOICE_INSTRUCTION,
      options: pairIds,
      context: state,
    },
  };

  const started = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = policy.deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      return failure(candidateSet.digest, policy, "timeout", "deadline_exhausted", Date.now() - started, usageOf({}));
    }
    try {
      const response = await transport(request, remaining);
      const latency = Date.now() - started;
      if (response.model !== undefined && response.model !== policy.jevVersion) {
        return failure(candidateSet.digest, policy, "malformed", "version_drift", latency, usageOf(response));
      }
      if (response.choice === undefined || !pairIds.includes(response.choice)) {
        return failure(candidateSet.digest, policy, "malformed", "unknown_pair_id", latency, usageOf(response));
      }
      const confidence = response.confidence;
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return failure(candidateSet.digest, policy, "malformed", "invalid_confidence", latency, usageOf(response));
      }
      if (confidence < policy.confidenceFloor) {
        return {
          ...failure(candidateSet.digest, policy, "floor", "low_confidence", latency, usageOf(response)),
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
      lastError = error;
      if (error instanceof JevTimeoutError) {
        return failure(candidateSet.digest, policy, "timeout", "deadline_exhausted", Date.now() - started, usageOf({}));
      }
      const subreason = error instanceof Error ? errorSubreason(error) : "network";
      // Auth and other non-retryable failures are terminal; only transport-level
      // failures (network, rate limit) get the single fast retry.
      if (subreason === "auth" || subreason === "non_retryable") {
        return failure(candidateSet.digest, policy, "transport", subreason, Date.now() - started, usageOf({}));
      }
    }
  }
  const subreason = lastError instanceof Error ? errorSubreason(lastError) : "transport";
  return failure(candidateSet.digest, policy, "transport", subreason, Date.now() - started, usageOf({}));
}

function errorSubreason(error: Error): string {
  const message = error.message.toLowerCase();
  if (message.includes("401") || message.includes("403")) return "auth";
  if (message.includes("429")) return "rate_limited";
  if (message.includes("auth")) return "auth";
  return "network";
}
