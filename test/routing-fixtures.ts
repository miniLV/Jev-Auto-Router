import type { JevTransport, JevTransportRequest, JevTransportResponse } from "../src/jev-adapter.js";
import { DEFAULT_JEV_POLICY } from "../src/jev-adapter.js";
import { buildCandidateSet, type ModelCatalog, type ModelInfo } from "../src/catalog.js";
import type { RouterConfig, Upstream, UpstreamResult } from "../src/proxy.js";
import { AUTO_MODEL, UNKNOWN } from "../src/types.js";
import type { ResponsesRequest } from "../src/execution-contract.js";

export function testCatalog(overrides: Array<{ model: string } & Partial<ModelInfo>> = []): ModelCatalog {
  const base: ModelInfo[] = [
    { model: "gpt-6-luna", tier: "luna_max", supported_efforts: ["max", "medium"], proved_efforts: ["max", "medium"], proof_versions: { max: "fixture-max-v1", medium: "fixture-medium-v1" }, proof_expires_at: { max: Number.MAX_SAFE_INTEGER, medium: Number.MAX_SAFE_INTEGER }, effort_observation_unknown: [], requestable: true },
    { model: "gpt-6-sol", tier: "sol", supported_efforts: ["low", "medium", "high"], proved_efforts: ["low", "medium", "high"], proof_versions: { low: "fixture-low-v1", medium: "fixture-medium-v1", high: "fixture-high-v1" }, proof_expires_at: { low: Number.MAX_SAFE_INTEGER, medium: Number.MAX_SAFE_INTEGER, high: Number.MAX_SAFE_INTEGER }, effort_observation_unknown: [], requestable: true },
    { model: "gpt-6-astra", tier: "astra", supported_efforts: ["medium", "high"], proved_efforts: ["medium", "high"], proof_versions: { medium: "fixture-medium-v1", high: "fixture-high-v1" }, proof_expires_at: { medium: Number.MAX_SAFE_INTEGER, high: Number.MAX_SAFE_INTEGER }, effort_observation_unknown: [], requestable: true },
  ];
  const models = base.map(model => {
    const override = overrides.find(item => item.model === model.model);
    const merged = { ...model, ...override };
    const provedEfforts = override?.proved_efforts ?? model.proved_efforts.filter(effort => merged.supported_efforts.includes(effort));
    return {
      ...merged,
      proved_efforts: override?.requestable === false ? [] : provedEfforts,
      proof_versions: override?.proof_versions ?? Object.fromEntries(
        (override?.requestable === false ? [] : provedEfforts).map(effort => [effort, `fixture-${model.model}-${effort}-v1`]),
      ),
      proof_expires_at: override?.proof_expires_at ?? merged.proof_expires_at,
      effort_observation_unknown: override?.effort_observation_unknown ?? merged.effort_observation_unknown,
      requestable: override?.requestable === false ? false : provedEfforts.length > 0,
    };
  });
  return {
    source: "fixture",
    models,
    session_binding_digest: "fixture-digest",
    observed_at: 0,
    discoveryDigest: "fixture-discovery",
    proofManifestId: "fixture-only",
    proofManifestDigest: "fixture-only",
    proofExclusions: [],
    effortObservationGapCount: 0,
  };
}

/** Explicit test configuration: the baseline is always stated, never defaulted. */
export function routerConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    routerOff: false,
    mode: "shadow",
    baseline: { model: "gpt-6-sol", effort: "medium" },
    activeCandidates: testCatalog().models.flatMap(model => model.supported_efforts.map(effort => ({ model: model.model, effort }))),
    policy: { ...DEFAULT_JEV_POLICY },
    ...overrides,
  };
}

export class RecordingTransport {
  readonly requests: JevTransportRequest[] = [];
  #responder: JevTransport;

  constructor(responder: JevTransport) {
    this.#responder = responder;
  }

  readonly transport: JevTransport = async (request, timeoutMs, signal) => {
    this.requests.push(request);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeout");
    return this.#responder(request, timeoutMs, signal);
  };
}

export function choosingTransport(choice: string, confidence = 0.9, model = "jev-1.13.0"): JevTransport {
  return async () => ({ model, choice, confidence, usage: { input_tokens: 350, output_tokens: 60 } });
}

export class NeverTransport {
  readonly requests: JevTransportRequest[] = [];
  readonly transport: JevTransport = async () => {
    throw new Error("Jev must not be called for this call");
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** SSE body with optional abort wiring; errors (not ends) when the signal fires. */
export function sseBody(
  events: object[],
  opts: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      if (opts.signal) {
        if (opts.signal.aborted) {
          controller.error(abortError());
          return;
        }
        opts.signal.addEventListener("abort", () => controller.error(abortError()), { once: true });
      }
      controller.close();
    },
  });
}

/** Two-phase SSE: prefix events flow immediately, the tail arrives after a delay. */
export function delayedSseBody(
  prefix: object[],
  tail: object[],
  delayMs: number,
  opts: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of prefix) controller.enqueue(frame(event));
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (opts.signal?.aborted) {
        controller.error(abortError());
        return;
      }
      for (const event of tail) controller.enqueue(frame(event));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

export function completedEvent(model: string, usage: Record<string, number> = { input_tokens: 1000, output_tokens: 200 }): object {
  return { type: "response.completed", response: { model, reasoning: { effort: "medium" }, usage } };
}

export class RecordingUpstream {
  readonly requests: ResponsesRequest[] = [];
  readonly aborts: number[] = [];
  #bodyFor: (request: ResponsesRequest, signal?: AbortSignal) => ReadableStream<Uint8Array>;

  constructor(
    bodyFor: (request: ResponsesRequest, signal?: AbortSignal) => ReadableStream<Uint8Array> =
      (request, signal) => sseBody([completedEvent(request.model)], { signal }),
  ) {
    this.#bodyFor = bodyFor;
  }

  readonly upstream: Upstream = async (request, signal) => {
    this.requests.push(structuredClone(request));
    if (signal) {
      const index = this.requests.length - 1;
      signal.addEventListener("abort", () => this.aborts.push(index), { once: true });
    }
    const result: UpstreamResult = {
      status: 200,
      contentType: "text/event-stream",
      headers: { "x-upstream": "fixture" },
      body: this.#bodyFor(request, signal),
    };
    return result;
  };
}

export function sampleRequest(model = AUTO_MODEL): ResponsesRequest {
  return { model, input: [], tools: [], stream: true };
}

export async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** Jev transport that selects the first pair of a given tier from the offered options. */
export function tierChoice(tier: "luna_max" | "sol" | "astra", confidence = 0.9): JevTransport {
  return async request => {
    const all = buildCandidateSet(testCatalog(), { astraAdmitted: true }).pairs;
    const byId = new Map(all.map(p => [p.pair_id, p]));
    const offered = Object.keys(request.questions.route.criteria).map(id => byId.get(id)).filter(Boolean);
    const pair = offered.find(p => p?.tier === tier) ?? offered[0];
    if (!pair) throw new Error("no options offered");
    return { model: "jev-1.13.0", choice: pair.pair_id, confidence, usage: { input_tokens: 350, output_tokens: 60 } };
  };
}

export function pairIdOf(model: string, effort: string): string {
  const found = buildCandidateSet(testCatalog(), { astraAdmitted: true }).pairs
    .find(p => p.model === model && p.effort === effort);
  if (!found) throw new Error(`no fixture pair for ${model}/${effort}`);
  return found.pair_id;
}

export { UNKNOWN };
