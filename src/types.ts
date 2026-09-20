/** Unknown-value discipline: never converted to zero, never counted as verified attribution. */
export const UNKNOWN = "UNKNOWN";
export type Unknown = typeof UNKNOWN;
export type Usage = number | Unknown;

export type Tier = "luna_max" | "terra" | "sol" | "gpt6";

export type StepType =
  | "user_turn"
  | "tool_step"
  | "correction"
  | "verification"
  | "other"
  | "infrastructure";

export type Mode = "active" | "shadow" | "bypass";

export type RouteSource = "jev" | "fallback" | "bypass";

export type FallbackReason =
  | "low_confidence"
  | "timeout"
  | "malformed"
  | "transport"
  | "guard_deny"
  | "baseline_unavailable"
  | "privacy_refusal"
  | "router_off"
  | "infrastructure"
  | "verification_fixed"
  | "forced_model"
  | "jev_skipped_for_task";

export type BypassReason =
  | "router_off"
  | "infrastructure"
  | "verification_fixed"
  | "forced_model"
  | "privacy_refusal"
  | "jev_skipped_for_task"
  | "competing_authority";

export type CallStatus = "ok" | "error" | "cancelled";

/** One validated, host-requestable (model, reasoning_effort) combination. */
export interface Pair {
  model: string;
  effort: string;
}

export interface TokenUsage {
  input_tokens: Usage;
  cached_input_tokens: Usage;
  cache_write_input_tokens: Usage;
  output_tokens: Usage;
  reasoning_tokens: Usage;
}

export function unknownUsage(): TokenUsage {
  return {
    input_tokens: UNKNOWN,
    cached_input_tokens: UNKNOWN,
    cache_write_input_tokens: UNKNOWN,
    output_tokens: UNKNOWN,
    reasoning_tokens: UNKNOWN,
  };
}

/** Add usage conservatively: any UNKNOWN input makes the total UNKNOWN. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = (x: Usage, y: Usage): Usage =>
    x === UNKNOWN || y === UNKNOWN ? UNKNOWN : x + y;
  return {
    input_tokens: sum(a.input_tokens, b.input_tokens),
    cached_input_tokens: sum(a.cached_input_tokens, b.cached_input_tokens),
    cache_write_input_tokens: sum(a.cache_write_input_tokens, b.cache_write_input_tokens),
    output_tokens: sum(a.output_tokens, b.output_tokens),
    reasoning_tokens: sum(a.reasoning_tokens, b.reasoning_tokens),
  };
}
