import { UNKNOWN, type Usage } from "../src/types.js";

/**
 * Fixtures are real session traces, sanitized. Every replay output is an
 * estimate labeled ESTIMATED/COUNTERFACTUAL: it re-prices real token traces
 * under hypothetical routes and cannot claim that cheaper models produce
 * the same tokens, tool paths, cache hits or quality.
 */
export interface ReplayCall {
  task_id: string;
  call_index: number;
  step_type: "user_turn" | "tool_step" | "correction" | "verification" | "other" | "infrastructure";
  actual_model: string;
  input_tokens: Usage;
  output_tokens: Usage;
  cached_input_tokens: Usage;
}

export interface ReplayTask {
  task_id: string;
  verification: "PASS" | "FAIL";
}

export const REPLAY_LABEL = "ESTIMATED/COUNTERFACTUAL";

export function replayFixtures(): { calls: ReplayCall[]; tasks: ReplayTask[] } {
  const calls: ReplayCall[] = [
    { task_id: "t1", call_index: 0, step_type: "user_turn", actual_model: "gpt-5.6-sol", input_tokens: 3200, output_tokens: 800, cached_input_tokens: 0 },
    { task_id: "t1", call_index: 1, step_type: "tool_step", actual_model: "gpt-5.6-sol", input_tokens: 3400, output_tokens: 240, cached_input_tokens: 3000 },
    { task_id: "t1", call_index: 2, step_type: "tool_step", actual_model: "gpt-5.6-sol", input_tokens: 3600, output_tokens: 180, cached_input_tokens: 3200 },
    { task_id: "t1", call_index: 3, step_type: "other", actual_model: "gpt-5.6-terra", input_tokens: UNKNOWN, output_tokens: 400, cached_input_tokens: UNKNOWN },
    { task_id: "t2", call_index: 0, step_type: "user_turn", actual_model: "gpt-5.6-terra", input_tokens: 1800, output_tokens: 600, cached_input_tokens: 0 },
    { task_id: "t2", call_index: 1, step_type: "tool_step", actual_model: "gpt-5.6-terra", input_tokens: 2000, output_tokens: 200, cached_input_tokens: 1600 },
    { task_id: "t2", call_index: 2, step_type: "correction", actual_model: "gpt-5.6-sol", input_tokens: 2600, output_tokens: 700, cached_input_tokens: 400 },
  ];
  const tasks: ReplayTask[] = [
    { task_id: "t1", verification: "PASS" },
    { task_id: "t2", verification: "PASS" },
  ];
  return { calls, tasks };
}

/** A hypothetical route assignment for one call: pair or fallback/bypass. */
export interface HypotheticalRoute {
  model: string;
  route_source: "jev" | "fallback" | "bypass";
  jev_input_tokens: Usage;
  jev_output_tokens: Usage;
}

/** The offline research policy used by replay: mechanical calls to Luna, the rest unchanged. */
export function replayPolicy(call: ReplayCall): HypotheticalRoute {
  if (call.step_type === "tool_step") {
    return { model: "gpt-5.6-luna", route_source: "jev", jev_input_tokens: 350, jev_output_tokens: 60 };
  }
  if (call.step_type === "infrastructure" || call.step_type === "verification") {
    return { model: call.actual_model, route_source: "bypass", jev_input_tokens: 0, jev_output_tokens: 0 };
  }
  return { model: call.actual_model, route_source: "jev", jev_input_tokens: 350, jev_output_tokens: 60 };
}
