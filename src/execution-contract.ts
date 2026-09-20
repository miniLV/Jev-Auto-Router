import { UNKNOWN, type Usage, type TokenUsage } from "./types.js";

/** A Codex Responses API request body (subset the router may touch). */
export interface ResponsesRequest {
  model: string;
  reasoning?: { effort?: string };
  [key: string]: unknown;
}

export interface AppliedRoute {
  original_model: string;
  routed_model: string;
  routed_effort: string;
}

/**
 * Apply a route by setting exactly model and reasoning effort. Everything
 * else — messages, tools, tool_call IDs, streaming flags — passes through
 * untouched, so native continuation and event fidelity are preserved.
 */
export function applyRoute(request: ResponsesRequest, pair: { model: string; effort: string }): {
  routed: ResponsesRequest;
  applied: AppliedRoute;
} {
  const routed: ResponsesRequest = {
    ...request,
    model: pair.model,
    reasoning: { ...request.reasoning, effort: pair.effort },
  };
  return {
    routed,
    applied: { original_model: request.model, routed_model: pair.model, routed_effort: pair.effort },
  };
}

export type RouteObservation = "requested_match" | "requested_mismatch" | "unobservable";

export interface ObservedExecution {
  actual_model: string | typeof UNKNOWN;
  actual_effort: string | typeof UNKNOWN;
  observation: RouteObservation;
  usage: TokenUsage;
}

/**
 * Observe the executed call from authoritative response metadata when the
 * host provides it. UNKNOWN is never MATCH: unobservable metadata stays
 * unobservable and is recorded as such.
 */
export function observeExecution(
  applied: AppliedRoute,
  response: { model?: string; reasoning?: { effort?: string }; usage?: Partial<Record<keyof TokenUsage, number>> },
): ObservedExecution {
  const actualModel = response.model ?? UNKNOWN;
  const actualEffort = response.reasoning?.effort ?? UNKNOWN;
  let observation: RouteObservation = "unobservable";
  if (actualModel !== UNKNOWN) {
    observation = actualModel === applied.routed_model ? "requested_match" : "requested_mismatch";
  }
  return {
    actual_model: actualModel,
    actual_effort: actualEffort,
    observation,
    usage: {
      input_tokens: response.usage?.input_tokens ?? UNKNOWN,
      cached_input_tokens: response.usage?.cached_input_tokens ?? UNKNOWN,
      cache_write_input_tokens: response.usage?.cache_write_input_tokens ?? UNKNOWN,
      output_tokens: response.usage?.output_tokens ?? UNKNOWN,
      reasoning_tokens: response.usage?.reasoning_tokens ?? UNKNOWN,
    },
  };
}

/** Extract usage and model from a streamed Responses `response.completed` event payload. */
export function observeFromCompletedEvent(
  applied: AppliedRoute,
  event: { response?: { model?: string; reasoning?: { effort?: string }; usage?: CompletedUsage } },
): ObservedExecution {
  const response = event.response ?? {};
  const usage = response.usage ?? {};
  return observeExecution(applied, {
    model: response.model,
    reasoning: response.reasoning,
    usage: {
      input_tokens: usage.input_tokens ?? usage.prompt_tokens,
      cached_input_tokens: usage.input_tokens_details?.cached_tokens,
      cache_write_input_tokens: usage.cache_write_input_tokens,
      output_tokens: usage.output_tokens ?? usage.completion_tokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
    },
  });
}

interface CompletedUsage {
  input_tokens?: number;
  prompt_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export type { Usage };
