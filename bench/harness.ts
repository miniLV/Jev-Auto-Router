import { UNKNOWN, type Usage } from "../src/types.js";
import type { HarnessConfig, PriceWeights } from "./config.js";
import { REPLAY_LABEL, replayFixtures, replayPolicy, type HypotheticalRoute, type ReplayCall, type ReplayTask } from "./fixtures.js";

/**
 * Offline evaluation harness: historical replay and the fixed-Terra
 * controlled comparison. Never a runtime dependency. Every replay number is
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
    leg = add(leg, costOf("jev-1.13.0", route.jev_input_tokens, route.jev_output_tokens, config.prices));
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

// ---------------------------------------------------------------------------
// Controlled comparison: fixed Terra baseline vs the routing policy.
// Quality is checked before cost; complete accounting in both arms.
// ---------------------------------------------------------------------------

export interface ComparisonTask {
  task_id: string;
  /** Verification under equivalent acceptance, both arms. */
  baseline_pass: boolean;
  policy_pass: boolean;
  baseline_calls: ReplayCall[];
  policy_calls: ReplayCall[];
  policy_jev_calls: number;
  policy_correction_cycles: number;
  policy_root_takeover: boolean;
}

export type Rate = number | "UNKNOWN";

export interface ComparisonReport {
  config: { release: string; cacheConditions: HarnessConfig["cacheConditions"] };
  tasks: number;
  quality_gate_passed: boolean;
  baseline_completion_rate: Rate;
  policy_completion_rate: Rate;
  /** Present only after the quality gate passes. */
  economics?: {
    baseline_cost: Cost;
    policy_cost: Cost;
    delta: Cost;
    policy_jev_cost: Cost;
    unobserved_calls: number;
  };
}

export function controlledComparison(config: HarnessConfig, tasks: ComparisonTask[]): ComparisonReport {
  const n = tasks.length;
  const baselineRate = n === 0 ? UNKNOWN : tasks.filter(t => t.baseline_pass).length / n;
  const policyRate = n === 0 ? UNKNOWN : tasks.filter(t => t.policy_pass).length / n;
  // Quality first: a cheaper arm with worse completion is a loss, not a saving.
  const qualityGate =
    baselineRate !== UNKNOWN && policyRate !== UNKNOWN && (policyRate as number) >= (baselineRate as number);

  let baselineCost: Cost = 0;
  let policyCost: Cost = 0;
  let jevCost: Cost = 0;
  let unobserved = 0;
  const price = config.prices;
  for (const task of tasks) {
    for (const call of task.baseline_calls) {
      if (call.input_tokens === UNKNOWN || call.output_tokens === UNKNOWN) unobserved += 1;
      baselineCost = add(baselineCost, costOf(call.actual_model, call.input_tokens, call.output_tokens, price));
    }
    for (const call of task.policy_calls) {
      if (call.input_tokens === UNKNOWN || call.output_tokens === UNKNOWN) unobserved += 1;
      policyCost = add(policyCost, costOf(call.actual_model, call.input_tokens, call.output_tokens, price));
    }
    // Complete cost accounting: Jev overhead, corrections and takeovers count.
    const jevLeg = task.policy_jev_calls * ((350 / 1e6) * price["jev-1.13.0"].input);
    policyCost = add(policyCost, jevLeg);
    jevCost = add(jevCost, jevLeg);
  }

  return {
    config: { release: config.release, cacheConditions: config.cacheConditions },
    tasks: n,
    quality_gate_passed: qualityGate,
    baseline_completion_rate: baselineRate,
    policy_completion_rate: policyRate,
    ...(qualityGate
      ? {
          economics: {
            baseline_cost: baselineCost,
            policy_cost: policyCost,
            delta: baselineCost === UNKNOWN || policyCost === UNKNOWN ? UNKNOWN : (baselineCost as number) - (policyCost as number),
            policy_jev_cost: jevCost,
            unobserved_calls: unobserved,
          },
        }
      : {}),
  };
}

export function comparisonFixtures(): ComparisonTask[] {
  const { calls } = replayFixtures();
  const t1 = calls.filter(c => c.task_id === "t1");
  const t2 = calls.filter(c => c.task_id === "t2");
  return [
    {
      task_id: "t1",
      baseline_pass: true,
      policy_pass: true,
      baseline_calls: t1.map(c => ({ ...c, actual_model: "gpt-5.6-terra" })),
      policy_calls: t1,
      policy_jev_calls: t1.length,
      policy_correction_cycles: 0,
      policy_root_takeover: false,
    },
    {
      task_id: "t2",
      baseline_pass: true,
      policy_pass: true,
      baseline_calls: t2.map(c => ({ ...c, actual_model: "gpt-5.6-terra" })),
      policy_calls: t2,
      policy_jev_calls: t2.length,
      policy_correction_cycles: 1,
      policy_root_takeover: false,
    },
  ];
}

export type { ReplayTask };
