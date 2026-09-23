import { inferTier, type ModelCatalog, type ModelInfo } from "./catalog.js";
import { digest } from "./canonical.js";

export type { ModelCatalog };

/** The trusted host surface's model listing (e.g. Codex App Server model/list). */
export interface HostModelList {
  source: string;
  models: Array<{ model: string; supported_efforts?: string[]; tier?: ModelInfo["tier"] }>;
}

export type PairProofSummary =
  | "response_completed_effort_confirmed"
  | "response_completed_effort_unreported"
  | "response_failed"
  | "response_incomplete"
  | "response_status_unknown";

/** A bounded, redacted record of one manually captured caller-edge request. */
export interface PairProof {
  model: string;
  effort: string;
  caller_edge_id: string;
  requested_at: string;
  expires_at: string;
  http_status: number;
  response_status: "completed" | "failed" | "incomplete" | "UNKNOWN";
  observed_model: string;
  observed_effort: string;
  evidence_artifact_id: string;
  evidence_sha256: string;
  evidence_summary: PairProofSummary;
}

/** Auditable evidence manifest. It contains no request body, prompt or credentials. */
export interface PairProofManifest {
  version: 1;
  id: string;
  caller_edge_id: string;
  proofs: PairProof[];
}

const MANIFEST_KEYS = ["caller_edge_id", "id", "proofs", "version"];
const PROOF_KEYS = [
  "caller_edge_id",
  "effort",
  "evidence_artifact_id",
  "evidence_sha256",
  "evidence_summary",
  "expires_at",
  "http_status",
  "model",
  "observed_effort",
  "observed_model",
  "requested_at",
  "response_status",
];
const PROOF_SUMMARIES = new Set<PairProofSummary>([
  "response_completed_effort_confirmed",
  "response_completed_effort_unreported",
  "response_failed",
  "response_incomplete",
  "response_status_unknown",
]);

/** Parse only the redacted manifest shape; arbitrary evidence text is rejected. */
export function parsePairProofManifest(value: unknown): PairProofManifest {
  const record = plainRecord(value, "pair proof manifest");
  exactKeys(record, MANIFEST_KEYS, "pair proof manifest");
  if (record.version !== 1 || !safeId(record.id) || !safeId(record.caller_edge_id) || !Array.isArray(record.proofs)) {
    throw new Error("invalid pair proof manifest header");
  }
  return {
    version: 1,
    id: record.id,
    caller_edge_id: record.caller_edge_id,
    proofs: record.proofs.map((item, index) => parseProof(item, index)),
  };
}

/**
 * Discovery supplies possible names and efforts. Only exact, fresh, successful
 * proofs bound to the configured edge create requestable pairs.
 */
export class ModelDiscovery {
  #cached?: { key: string; refreshAt: number; catalog: ModelCatalog };

  async discover(
    sessionId: string,
    fetchList: () => Promise<HostModelList>,
    proofManifest: PairProofManifest | undefined,
    callerEdgeId: string,
    now: number,
  ): Promise<ModelCatalog> {
    const list = await fetchList();
    const discovered = new Map<string, { tier: ModelInfo["tier"]; efforts: string[] }>();
    for (const entry of list.models) {
      const tier = entry.tier ?? inferTier(entry.model);
      if (!tier) continue;
      const current = discovered.get(entry.model);
      const efforts = new Set([...(current?.efforts ?? []), ...(entry.supported_efforts ?? [])]);
      discovered.set(entry.model, { tier, efforts: [...efforts] });
    }

    const discoveryDigest = digest({
      models: [...discovered].map(([model, item]) => [model, item.tier, item.efforts]),
    });
    const proofManifestId = proofManifest?.id ?? "UNKNOWN";
    const proofManifestDigest = proofManifest ? digest(proofManifest) : digest({ version: 0, state: "missing" });
    const sessionBindingDigest = digest({
      session: sessionId,
      discoveryDigest,
      callerEdgeId,
      proofManifestDigest,
    });
    const cacheKey = `${sessionId}:${sessionBindingDigest}`;
    if (this.#cached?.key === cacheKey && now < this.#cached.refreshAt) {
      return structuredClone(this.#cached.catalog);
    }

    const proofs = proofManifest?.proofs ?? [];
    const refreshAt = nextProofBoundary(proofs, now);
    const proofExclusions: ModelCatalog["proofExclusions"] = [];
    const proved = new Map<string, Set<string>>();
    const proofExpirations = new Map<string, Record<string, number>>();
    const proofVersions = new Map<string, Record<string, string>>();
    const unobservedEfforts = new Map<string, Set<string>>();
    let effortObservationGapCount = 0;
    const occurrences = new Map<string, number>();
    for (const proof of proofs) {
      const key = `${proof.model}/${proof.effort}`;
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }

    for (const proof of proofs) {
      const key = `${proof.model}/${proof.effort}`;
      const exclude = (reason: string): void => {
        proofExclusions.push({ model: proof.model, effort: proof.effort, reason });
      };
      if (
        callerEdgeId === "UNKNOWN" ||
        proofManifest?.caller_edge_id !== callerEdgeId ||
        proof.caller_edge_id !== callerEdgeId
      ) {
        exclude("caller_edge_mismatch");
      } else if ((occurrences.get(key) ?? 0) > 1) {
        exclude("duplicate_pair");
      } else if (!withinWindow(proof, now)) {
        exclude(proof.expires_at && Date.parse(proof.expires_at) <= now ? "expired" : "invalid_time_window");
      } else if (proof.http_status < 200 || proof.http_status >= 300 || proof.response_status !== "completed") {
        exclude("request_failed");
      } else if (proof.observed_model !== proof.model) {
        exclude("model_mismatch");
      } else if (proof.observed_effort !== "UNKNOWN" && proof.observed_effort !== proof.effort) {
        exclude("effort_mismatch");
      } else if (!discovered.get(proof.model)?.efforts.includes(proof.effort)) {
        exclude("pair_not_discovered");
      } else {
        const efforts = proved.get(proof.model) ?? new Set<string>();
        efforts.add(proof.effort);
        proved.set(proof.model, efforts);
        const expirations = proofExpirations.get(proof.model) ?? {};
        expirations[proof.effort] = Date.parse(proof.expires_at);
        proofExpirations.set(proof.model, expirations);
        const versions = proofVersions.get(proof.model) ?? {};
        versions[proof.effort] = digest({
          manifestVersion: proofManifest?.version ?? 0,
          proof: {
            model: proof.model,
            effort: proof.effort,
            caller_edge_id: proof.caller_edge_id,
            requested_at: proof.requested_at,
            expires_at: proof.expires_at,
            http_status: proof.http_status,
            response_status: proof.response_status,
            observed_model: proof.observed_model,
            observed_effort: proof.observed_effort,
            evidence_artifact_id: proof.evidence_artifact_id,
            evidence_sha256: proof.evidence_sha256,
            evidence_summary: proof.evidence_summary,
          },
        });
        proofVersions.set(proof.model, versions);
        if (proof.observed_effort === "UNKNOWN") {
          effortObservationGapCount += 1;
          const unobserved = unobservedEfforts.get(proof.model) ?? new Set<string>();
          unobserved.add(proof.effort);
          unobservedEfforts.set(proof.model, unobserved);
        }
      }
    }

    const models: ModelInfo[] = [...discovered].map(([model, item]) => {
      const provedEfforts = [...(proved.get(model) ?? [])];
      return {
        model,
        tier: item.tier,
        supported_efforts: item.efforts,
        proved_efforts: provedEfforts,
        proof_versions: proofVersions.get(model) ?? {},
        proof_expires_at: proofExpirations.get(model) ?? {},
        effort_observation_unknown: [...(unobservedEfforts.get(model) ?? [])],
        requestable: provedEfforts.length > 0,
      };
    });
    const catalog: ModelCatalog = {
      source: list.source,
      models,
      session_binding_digest: sessionBindingDigest,
      observed_at: now,
      discoveryDigest,
      proofManifestId,
      proofManifestDigest,
      proofExclusions,
      effortObservationGapCount,
    };
    this.#cached = { key: cacheKey, refreshAt, catalog: structuredClone(catalog) };
    return catalog;
  }
}

function parseProof(value: unknown, index: number): PairProof {
  const record = plainRecord(value, `pair proof ${index + 1}`);
  exactKeys(record, PROOF_KEYS, `pair proof ${index + 1}`);
  const responseStatuses = ["completed", "failed", "incomplete", "UNKNOWN"];
  if (
    !safeId(record.model) ||
    !safeId(record.effort) ||
    !safeId(record.caller_edge_id) ||
    !isIsoTimestamp(record.requested_at) ||
    !isIsoTimestamp(record.expires_at) ||
    !Number.isInteger(record.http_status) ||
    (record.http_status as number) < 100 ||
    (record.http_status as number) > 599 ||
    typeof record.response_status !== "string" ||
    !responseStatuses.includes(record.response_status) ||
    typeof record.observed_model !== "string" ||
    (record.observed_model !== "UNKNOWN" && !safeId(record.observed_model)) ||
    typeof record.observed_effort !== "string" ||
    (record.observed_effort !== "UNKNOWN" && !safeId(record.observed_effort)) ||
    typeof record.evidence_artifact_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.evidence_artifact_id) ||
    typeof record.evidence_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.evidence_sha256) ||
    typeof record.evidence_summary !== "string" ||
    !PROOF_SUMMARIES.has(record.evidence_summary as PairProofSummary)
  ) {
    throw new Error(`invalid pair proof ${index + 1}`);
  }
  const responseStatus = record.response_status as PairProof["response_status"];
  const summary = record.evidence_summary as PairProofSummary;
  if (!summaryMatches(responseStatus, record.observed_effort as string, summary)) {
    throw new Error(`invalid redacted evidence summary in pair proof ${index + 1}`);
  }
  return record as unknown as PairProof;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} has missing or unsupported proof fields`);
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function summaryMatches(status: PairProof["response_status"], effort: string, summary: PairProofSummary): boolean {
  if (status === "completed") {
    return summary === (effort === "UNKNOWN"
      ? "response_completed_effort_unreported"
      : "response_completed_effort_confirmed");
  }
  if (status === "failed") return summary === "response_failed";
  if (status === "incomplete") return summary === "response_incomplete";
  return summary === "response_status_unknown";
}

function withinWindow(proof: PairProof, now: number): boolean {
  const requestedAt = Date.parse(proof.requested_at);
  const expiresAt = Date.parse(proof.expires_at);
  return requestedAt <= now && expiresAt > requestedAt && now < expiresAt;
}

function nextProofBoundary(proofs: PairProof[], now: number): number {
  let next = Number.POSITIVE_INFINITY;
  for (const proof of proofs) {
    for (const value of [proof.requested_at, proof.expires_at]) {
      const time = Date.parse(value);
      if (Number.isFinite(time) && time > now && time < next) next = time;
    }
  }
  return next;
}
