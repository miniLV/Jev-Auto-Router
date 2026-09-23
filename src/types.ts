/** Unknown-value discipline: never converted to zero, never counted as verified attribution. */
export const UNKNOWN = "UNKNOWN";
export type Unknown = typeof UNKNOWN;
export type Usage = number | Unknown;

export type Tier = "luna_max" | "sol" | "astra";

/** The only virtual model that enters automatic routing (spec §2). */
export const AUTO_MODEL = "jev/auto";

export type StepType =
  | "user_turn"
  | "tool_step"
  | "correction"
  | "verification"
  | "other"
  | "infrastructure";

const STEP_TYPES: readonly StepType[] = [
  "user_turn",
  "tool_step",
  "correction",
  "verification",
  "other",
  "infrastructure",
];

export function parseStepType(value: unknown): StepType {
  return typeof value === "string" && STEP_TYPES.includes(value as StepType)
    ? value as StepType
    : "other";
}

export type Mode = "active" | "shadow" | "bypass";

export type RouteSource = "jev" | "fallback" | "bypass";

/** How the call entered the router (spec §2 entry boundary). */
export type EntryKind = "auto" | "manual" | "out_of_policy";

/**
 * Exact recorded reasons (routing-policy §3/§6). Every fallback and bypass
 * keeps a distinct reason; the Fallback Baseline executes all of them.
 */
export type RouteReason =
  // Pre-Jev fallback conditions
  | "router_off"
  | "shadow_mode"
  | "infrastructure"
  | "competing_authority"
  | "privacy_refusal"
  | "insufficient_routing_facts"
  | "jev_version_mismatch"
  // Jev answer conditions
  | "jev_timeout"
  | "jev_failure"
  | "invalid_choice"
  | "low_confidence"
  | "guard_deny"
  // Entry bypass (no routing at all)
  | "manual_model"
  | "out_of_policy_entry";

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
