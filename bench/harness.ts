import { UNKNOWN, type Usage } from "../src/types.js";
import type { HarnessConfig, PriceWeights } from "./config.js";
import { REPLAY_LABEL, replayFixtures, replayPolicy, type HypotheticalRoute, type ReplayCall } from "./fixtures.js";

/**
 * Historical replay only. Controlled paired evaluation lives in
 * paired-evaluation.ts. Never a runtime dependency; replay outputs are
 * labeled ESTIMATED/COUNTERFACTUAL.
 */

export type Cost = Usage;

function costOf(model: string, input: Usage, output: Usage, prices: PriceWeights): Cost {
  const price = prices[model];
  if (!price) return UNKNOWN;
  if (input === UNKNOWN || output === UNKNOWN) return UNKNOWN;
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function add(a: Cost, b: Cost): Cost {
  return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : (a as number) + (b as number);
}

export interface ReplayReport {
  label: typeof REPLAY_LABEL;
  config: { release: string; cacheConditions: HarnessConfig["cacheConditions"] };
  tasks: number;
  observed_cost: Cost;
  replay_cost: Cost;
  /** UNKNOWN if any unobserved usage entered either side. */
  delta: Cost;
  unobserved_calls: number;
}

/** Re-price real token traces under hypothetical routes. */
export function replay(config: HarnessConfig, calls: ReplayCall[] = replayFixtures().calls): ReplayReport {
  let observed: Cost = 0;
  let replayed: Cost = 0;
  let unobserved = 0;
  for (const call of calls) {
    if (call.input_tokens === UNKNOWN || call.output_tokens === UNKNOWN) unobserved += 1;
    observed = add(observed, costOf(call.actual_model, call.input_tokens, call.output_tokens, config.prices));
    const route: HypotheticalRoute = replayPolicy(call);
    let leg = costOf(route.model, call.input_tokens, call.output_tokens, config.prices);
    if (route.route_source === "jev" && (route.jev_input_tokens === UNKNOWN || route.jev_output_tokens === UNKNOWN)) unobserved += 1;
    leg = add(leg, costOf(config.jevVersion, route.jev_input_tokens, route.jev_output_tokens, config.prices));
    replayed = add(replayed, leg);
  }
  const taskIds = new Set(calls.map(c => c.task_id));
  return {
    label: REPLAY_LABEL,
    config: { release: config.release, cacheConditions: config.cacheConditions },
    tasks: taskIds.size,
    observed_cost: observed,
    replay_cost: replayed,
    delta: observed === UNKNOWN || replayed === UNKNOWN ? UNKNOWN : (observed as number) - (replayed as number),
    unobserved_calls: unobserved,
  };
}
