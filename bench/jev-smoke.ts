import { buildCandidateSet, type ModelCatalog } from "../src/catalog.js";
import { fetchJevTransport } from "../src/index.js";
import { choose, DEFAULT_JEV_POLICY } from "../src/jev-adapter.js";
import type { RoutingState } from "../src/route-plan.js";

const key = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("Set JEV_API_KEY or TYPESAFE_API_KEY");

// Synthetic catalog and allowlisted facts: this checks Jev integration, not Codex execution quality.
const catalog: ModelCatalog = {
  source: "synthetic-smoke",
  observed_at: 0,
  session_binding_digest: "synthetic-smoke",
  discoveryDigest: "synthetic-smoke",
  proofManifestId: "synthetic-smoke",
  proofManifestDigest: "synthetic-smoke",
  proofExclusions: [],
  effortObservationGapCount: 0,
  models: [
    { model: "gpt-6-luna", tier: "luna_max", supported_efforts: ["max"], proved_efforts: ["max"], proof_versions: { max: "synthetic-max-v1" }, proof_expires_at: { max: Number.MAX_SAFE_INTEGER }, effort_observation_unknown: [], requestable: true },
    { model: "gpt-6-sol", tier: "sol", supported_efforts: ["medium"], proved_efforts: ["medium"], proof_versions: { medium: "synthetic-medium-v1" }, proof_expires_at: { medium: Number.MAX_SAFE_INTEGER }, effort_observation_unknown: [], requestable: true },
    { model: "gpt-6-astra", tier: "astra", supported_efforts: ["medium"], proved_efforts: ["medium"], proof_versions: { medium: "synthetic-medium-v1" }, proof_expires_at: { medium: Number.MAX_SAFE_INTEGER }, effort_observation_unknown: [], requestable: true },
  ],
};
const candidates = buildCandidateSet(catalog, { astraAdmitted: true });
const cases: Array<{ id: string; state: RoutingState }> = [
  { id: "short_request", state: { step_type: "user_turn", current_model: "gpt-6-sol", user_turn_facts: { request_length_bucket: "short" } } },
  { id: "long_request", state: { step_type: "user_turn", current_model: "gpt-6-sol", user_turn_facts: { request_length_bucket: "long" } } },
  { id: "tool_followup", state: { step_type: "tool_step", current_model: "gpt-6-sol" } },
  { id: "correction", state: { step_type: "correction", current_model: "gpt-6-sol" } },
  { id: "large_context", state: { step_type: "tool_step", current_model: "gpt-6-luna", context_size_bucket: "large" } },
];

async function main(): Promise<void> {
  const transport = fetchJevTransport("https://api.typesafe.ai/v1/systemone", key);
  const records = [];
  for (const sample of cases) {
    const decision = await choose(sample.state, candidates, { ...DEFAULT_JEV_POLICY, deadlineMs: 10_000 }, transport);
    const pair = candidates.pairs.find(candidate => candidate.pair_id === decision.chosen_pair_id);
    records.push({
      id: sample.id,
      valid: decision.valid,
      pair: pair ? `${pair.model}/${pair.effort}` : null,
      confidence: decision.confidence ?? null,
      failure: decision.failure_reason ?? null,
      latency_ms: decision.jev_latency_ms,
      usage: decision.jev_usage,
    });
  }
  const latencies = records.map(record => record.latency_ms).sort((a, b) => a - b);
  process.stdout.write(JSON.stringify({
    label: "SYNTHETIC JEV INTEGRATION SMOKE; NO EXECUTOR TASKS",
    jev_version: DEFAULT_JEV_POLICY.jevVersion,
    valid: records.filter(record => record.valid).length,
    cases: records.length,
    median_latency_ms: (latencies[2] + latencies[3]) / 2,
    records,
  }, null, 2) + "\n");
}

void main();
