import type { JevTransport, JevTransportRequest, JevTransportResponse } from "../src/jev-adapter.js";
import { buildCandidateSet, type ModelCatalog, type ModelInfo } from "../src/catalog.js";
import type { Upstream, UpstreamResult } from "../src/proxy.js";
import type { ResponsesRequest } from "../src/execution-contract.js";

export function testCatalog(overrides: Array<{ model: string } & Partial<ModelInfo>> = []): ModelCatalog {
  const base: ModelInfo[] = [
    { model: "gpt-5.6-luna", tier: "luna_max", supported_efforts: ["max", "medium"], requestable: true },
    { model: "gpt-5.6-terra", tier: "terra", supported_efforts: ["low", "medium", "high"], requestable: true },
    { model: "gpt-5.6-sol", tier: "sol", supported_efforts: ["medium", "high"], requestable: true },
    { model: "gpt-6-astra", tier: "gpt6", supported_efforts: ["medium", "high"], requestable: true },
  ];
  const models = base.map(m => ({ ...m, ...overrides.find(o => o.model === m.model) }));
  return { source: "fixture", models, session_binding_digest: "fixture-digest", observed_at: 0 };
}

export class RecordingTransport {
  readonly requests: JevTransportRequest[] = [];
  #responder: JevTransport;

  constructor(responder: JevTransport) {
    this.#responder = responder;
  }

  readonly transport: JevTransport = async (request, timeoutMs) => {
    this.requests.push(request);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeout");
    return this.#responder(request, timeoutMs);
  };
}

export function choosingTransport(choice: string, confidence = 0.9, model = "jev-1.13.0"): JevTransport {
  return async () => ({ model, choice, confidence, usage: { input_tokens: 350, output_tokens: 60 } });
}

export function sseBody(events: object[]): ReadableStream<Uint8Array> {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

export function completedEvent(model: string, usage: Record<string, number> = { input_tokens: 1000, output_tokens: 200 }): object {
  return { type: "response.completed", response: { model, reasoning: { effort: "medium" }, usage } };
}

export class RecordingUpstream {
  readonly requests: ResponsesRequest[] = [];
  #bodyFor: (request: ResponsesRequest) => ReadableStream<Uint8Array>;

  constructor(bodyFor: (request: ResponsesRequest) => ReadableStream<Uint8Array> = request => sseBody([completedEvent(request.model)])) {
    this.#bodyFor = bodyFor;
  }

  readonly upstream: Upstream = async request => {
    this.requests.push(structuredClone(request));
    const result: UpstreamResult = {
      status: 200,
      contentType: "text/event-stream",
      body: this.#bodyFor(request),
    };
    return result;
  };
}

export function sampleRequest(model = "gpt-5.6-sol"): ResponsesRequest {
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
export function tierChoice(tier: "luna_max" | "terra" | "sol" | "gpt6", confidence = 0.9): JevTransport {
  return async request => {
    const all = buildCandidateSet(testCatalog(), { gpt6Admitted: true }).pairs;
    const byId = new Map(all.map(p => [p.pair_id, p]));
    const offered = request.question.options.map(id => byId.get(id)).filter(Boolean);
    const pair = offered.find(p => p?.tier === tier) ?? offered[0];
    if (!pair) throw new Error("no options offered");
    return { model: "jev-1.13.0", choice: pair.pair_id, confidence, usage: { input_tokens: 350, output_tokens: 60 } };
  };
}

export function pairIdOf(model: string, effort: string): string {
  const found = buildCandidateSet(testCatalog(), { gpt6Admitted: true }).pairs
    .find(p => p.model === model && p.effort === effort);
  if (!found) throw new Error(`no fixture pair for ${model}/${effort}`);
  return found.pair_id;
}
