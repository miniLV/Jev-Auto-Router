import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { BaselineUnavailableError, CallCancelledError, MemoryTelemetry, ResponsesProxy, type RouterConfig, type UpstreamResult } from "./proxy.js";
import { DEFAULT_JEV_POLICY, isValidJevPolicyParameters, JevTimeoutError, MAX_JEV_DEADLINE_MS, type JevPolicy, type JevTransport, type JevTransportRequest } from "./jev-adapter.js";
import { ModelDiscovery, parsePairProofManifest, type HostModelList } from "./discovery.js";
import type { ModelCatalog } from "./catalog.js";
import type { ResponsesRequest } from "./execution-contract.js";
import {
  currentlyProvedEfforts,
  currentEffortObservationGapCount,
  deriveCandidateCatalogId,
  lunaBindingDefect,
  resolveBaseline,
  type ModelEffortPair,
} from "./catalog.js";
import { validateActiveEvidence } from "./active-evidence.js";
import { looksSensitive, QUESTION_SCHEMA_VERSION } from "./route-plan.js";
import { AUTO_MODEL, parseStepType } from "./types.js";
import type { VerificationEvidence } from "./verification.js";
import { POLICY_VERSION } from "./receipt.js";

/** Entry configuration: startup, host model discovery and a small config surface. */
export interface EntryConfig extends RouterConfig {
  port: number;
  upstreamBaseUrl: string;
  jevEndpoint: string;
  releaseId: string;
  activeEvidenceFile?: string;
  pairProofsFile?: string;
  callerEdgeId: string;
  candidateCatalogIdExpected?: string;
}

/**
 * The Fallback Baseline is required configuration with no universal default
 * (spec §3): it must name one caller-edge-proved pair explicitly.
 */
export function parseBaseline(value: string | undefined): { model: string; effort: string } {
  if (!value) {
    throw new Error("JEV_BASELINE must name the proved Fallback Baseline pair as <model>/<effort>");
  }
  const [model, effort, ...rest] = value.split("/");
  if (!model || !effort || rest.length > 0) {
    throw new Error(`JEV_BASELINE must be <model>/<effort>, got: ${value}`);
  }
  return { model, effort };
}

export function parseActiveCandidates(value: string | undefined): ModelEffortPair[] {
  if (!value?.trim()) return [];
  const pairs = value.split(",").map(entry => {
    const [model, effort, ...rest] = entry.trim().split("/");
    if (!model || !effort || rest.length > 0) {
      throw new Error(`JEV_ACTIVE_CANDIDATES entries must be <model>/<effort>, got: ${entry}`);
    }
    return { model, effort };
  });
  const keys = pairs.map(pair => `${pair.model}/${pair.effort}`);
  if (new Set(keys).size !== keys.length) throw new Error("JEV_ACTIVE_CANDIDATES must not repeat a model/effort pair");
  return pairs;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EntryConfig {
  const baseline = parseBaseline(env.JEV_BASELINE);
  const mode = env.JEV_MODE ?? "shadow";
  if (mode !== "shadow" && mode !== "active") {
    throw new Error(`JEV_MODE must be "shadow" or "active", got: ${env.JEV_MODE}`);
  }
  const routerOff = env.JEV_ROUTER_OFF === "1";
  const activePolicyRequired = mode === "active" && !routerOff;
  const confidenceFloor = policyNumber("JEV_CONFIDENCE_FLOOR", env.JEV_CONFIDENCE_FLOOR, DEFAULT_JEV_POLICY.confidenceFloor, activePolicyRequired);
  const deadlineMs = policyNumber("JEV_DEADLINE_MS", env.JEV_DEADLINE_MS, DEFAULT_JEV_POLICY.deadlineMs, activePolicyRequired);
  const policyParameters = { confidenceFloor, deadlineMs };
  if (!isValidJevPolicyParameters(policyParameters)) {
    throw new Error(`JEV_CONFIDENCE_FLOOR must be within 0..1 and JEV_DEADLINE_MS must be an integer from 1 to ${MAX_JEV_DEADLINE_MS}`);
  }
  const policy: JevPolicy = {
    jevVersion: env.JEV_VERSION ?? DEFAULT_JEV_POLICY.jevVersion,
    ...policyParameters,
  };
  const activeCandidates = parseActiveCandidates(env.JEV_ACTIVE_CANDIDATES);
  const releaseId = env.JEV_RELEASE_ID ?? "UNKNOWN";
  const activeEvidenceFile = env.JEV_ACTIVE_EVIDENCE_FILE;
  const pairProofsFile = env.JEV_PAIR_PROOFS_FILE;
  const callerEdgeId = env.JEV_CALLER_EDGE_ID ?? "UNKNOWN";
  const candidateCatalogIdExpected = env.JEV_CANDIDATE_CATALOG_ID || undefined;
  if (mode === "active" && !routerOff && activeCandidates.length === 0) {
    throw new Error("JEV_ACTIVE_CANDIDATES must list exact approved <model>/<effort> pairs before Active routing");
  }
  if (mode === "active" && !routerOff) {
    if (!activeEvidenceFile) throw new Error("JEV_ACTIVE_EVIDENCE_FILE must point to the paired-evaluation report before Active routing");
    if (!releaseId || releaseId === "UNKNOWN") throw new Error("JEV_RELEASE_ID must match the evaluated runtime release before Active routing");
    if (!callerEdgeId || callerEdgeId === "UNKNOWN") {
      throw new Error("Active routing requires an explicit JEV_CALLER_EDGE_ID binding");
    }
  }
  const upstreamBaseUrl = env.JEV_UPSTREAM_BASE_URL;
  if (!upstreamBaseUrl) {
    throw new Error("JEV_UPSTREAM_BASE_URL must name the authenticated, non-recursive caller edge; no direct upstream default exists");
  }
  return {
    routerOff,
    mode,
    baseline,
    activeCandidates,
    policy,
    port: numberOrDefault(env.JEV_PORT, 8787),
    upstreamBaseUrl,
    jevEndpoint: env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone",
    releaseId,
    activeEvidenceFile,
    pairProofsFile,
    callerEdgeId,
    candidateCatalogIdExpected,
  };
}

/** Resolve the runtime identity; the environment value can only pin an expectation. */
export function currentCandidateCatalogId(config: EntryConfig, catalog: ModelCatalog, now = Date.now()): string {
  const candidateCatalogId = deriveCandidateCatalogId(catalog, config.callerEdgeId, now);
  if (config.candidateCatalogIdExpected !== undefined && config.candidateCatalogIdExpected !== candidateCatalogId) {
    throw new Error("JEV_CANDIDATE_CATALOG_ID does not match the current proved candidate catalog");
  }
  return candidateCatalogId;
}

function numberOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function policyNumber(name: string, value: string | undefined, fallback: number, required: boolean): number {
  if (value === undefined) {
    if (required) throw new Error(`${name} must be explicitly set before Active routing`);
    return fallback;
  }
  if (!value.trim()) throw new Error(`${name} must be a finite number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

export function fetchJevTransport(endpoint: string, apiKey: string | undefined): JevTransport {
  return async (request: JevTransportRequest, timeoutMs: number, signal?: AbortSignal) => {
    if (!apiKey) throw new Error("auth: JEV_API_KEY is not configured");
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error",
      });
    } catch (error) {
      // A deadline expiry is a Jev timeout (fallback with its reason); only a
      // client-signal abort is a cancellation and keeps propagating.
      if (error instanceof Error && error.name === "TimeoutError" && !signal?.aborted) {
        throw new JevTimeoutError();
      }
      throw error;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`auth: ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw new Error(`non_retryable: ${response.status}`);
      throw new Error(`http ${response.status}`);
    }
    const body = (await response.json()) as {
      model?: string;
      answers?: { route?: { type?: string; choice?: string; confidence?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      model: body.model,
      choice: body.answers?.route?.type === "choice" ? body.answers.route.choice : undefined,
      confidence: body.answers?.route?.confidence,
      usage: body.usage,
    };
  };
}

export async function fetchUpstream(baseUrl: string, request: ResponsesRequest, signal?: AbortSignal): Promise<UpstreamResult> {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.body) throw new Error("upstream returned no body");
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const bodyWasDecoded = contentEncoding !== undefined && FETCH_DECODED_ENCODINGS.has(contentEncoding);
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP.has(lowerName) || (bodyWasDecoded && DECODED_BODY_HEADERS.has(lowerName))) continue;
    if (bodyWasDecoded && lowerName === "vary") {
      const fields = value.split(",").map(field => field.trim()).filter(field => field.toLowerCase() !== "accept-encoding");
      if (fields.length > 0) headers[name] = fields.join(", ");
      continue;
    }
    headers[name] = value;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/json",
    headers,
    body: response.body,
  };
}

/** Build the proxy with the same caller-edge wiring used by the production entry point. */
export function createProductionProxy(
  config: EntryConfig,
  catalog: ModelCatalog,
  transport: JevTransport,
  telemetry: MemoryTelemetry = new MemoryTelemetry(),
): ResponsesProxy {
  return new ResponsesProxy(
    config,
    catalog,
    transport,
    (request, signal) => fetchUpstream(config.upstreamBaseUrl, request, signal),
    telemetry,
  );
}

/** Content encodings transparently decoded by standard fetch in the supported Node runtime. */
const FETCH_DECODED_ENCODINGS = new Set(["br", "deflate", "gzip", "x-gzip"]);

/** Headers that describe encoded representation bytes rather than decoded content. */
const DECODED_BODY_HEADERS = new Set([
  "accept-ranges",
  "content-digest",
  "content-encoding",
  "content-length",
  "content-md5",
  "content-range",
  "digest",
  "etag",
  "repr-digest",
]);

/** Hop-by-hop headers are never relayed. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function fetchModelList(baseUrl: string): Promise<HostModelList> {
  const response = await fetch(`${baseUrl}/models`);
  if (!response.ok) throw new Error(`model list failed: ${response.status}`);
  const payload = (await response.json()) as { data?: Array<{ id: string; supported_efforts?: string[] }> };
  return {
    source: "authenticated-caller-edge:/models",
    models: (payload.data ?? []).map(entry => ({ model: entry.id, supported_efforts: entry.supported_efforts })),
  };
}

/** Optional restrictions used by the separate frozen-plan evaluation entry. */
export interface RouterServerOptions {
  allowedTaskIds?: ReadonlySet<string>;
}

/** Local-only operational surfaces: health and the decision log. Never a control plane. */
export function createRouterServer(
  config: EntryConfig,
  catalog: ModelCatalog,
  proxy: ResponsesProxy,
  options: RouterServerOptions = {},
): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let responseStreamFailed = false;
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const healthNow = Date.now();
        const discoveredPairs = catalog.models.flatMap(model => model.supported_efforts.map(effort => `${model.model}/${effort}`));
        const provedPairs = catalog.models.flatMap(model => currentlyProvedEfforts(model, healthNow).map(effort => `${model.model}/${effort}`));
        writeJson(res, 200, {
          autoModel: AUTO_MODEL,
          routerOff: config.routerOff,
          mode: config.mode,
          jevVersion: config.policy.jevVersion,
          policyVersion: POLICY_VERSION,
          releaseId: config.releaseId,
          callerEdgeId: config.callerEdgeId,
          candidateCatalogId: deriveCandidateCatalogId(catalog, config.callerEdgeId, healthNow),
          baseline: config.baseline,
          activeCandidates: config.activeCandidates,
          baselineRequestable: resolveBaseline(catalog, config.baseline.model, config.baseline.effort, healthNow) !== undefined,
          discoveredPairs,
          provedPairs,
          candidatePairs: provedPairs,
          discoveryDigest: catalog.discoveryDigest,
          proofManifestId: catalog.proofManifestId,
          proofManifestDigest: catalog.proofManifestDigest,
          proofExclusionCount: catalog.proofExclusions.length,
          effortObservationGapCount: currentEffortObservationGapCount(catalog, healthNow),
          lunaBindingDefect: lunaBindingDefect(catalog, healthNow) ?? null,
          catalogSize: catalog.models.length,
          provedModelCount: catalog.models.filter(model => currentlyProvedEfforts(model, healthNow).length > 0).length,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/decisions") {
        writeJson(res, 200, { calls: proxy.telemetry.calls, tasks: proxy.telemetry.tasks });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        // Control signals travel as headers so the forwarded body stays native.
        const taskId = parseTaskIdHeader(req.headers["x-jev-task-id"]);
        if (taskId === undefined) {
          writeJson(res, 400, { error: "invalid_task_id" });
          return;
        }
        if (options.allowedTaskIds && !options.allowedTaskIds.has(taskId)) {
          writeJson(res, 403, { error: "task_not_in_frozen_plan" });
          return;
        }
        const body = (await readJson(req)) as ResponsesRequest;
        const step = parseStepType(header(req.headers["x-jev-step"]));
        // Client disconnect aborts whichever Jev wait or upstream request is
        // active; it never starts a fallback request (routing-policy §8).
        const cancellation = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded && !responseStreamFailed) cancellation.abort();
        });
        const userInput = step === "user_turn" && Array.isArray(body.input)
          ? JSON.stringify(body.input)
          : undefined;
        const result = await proxy.routeCall({
          task_id: taskId,
          step_type: step,
          request: body,
          current_model: header(req.headers["x-jev-current-model"]),
          // Shape-only user-turn fact: the native input is bucketed locally,
          // and only the bucket ever leaves for Jev.
          user_turn: userInput === undefined ? undefined : { request_text: userInput },
          // Inspect user input locally for secrets; only its length bucket can
          // enter Routing State, and the original body still passes to the edge.
          raw_hints: userInput === undefined ? undefined : [userInput],
          context_size_bucket: parseBucket(header(req.headers["x-jev-context-size-bucket"])),
          forced_model: header(req.headers["x-jev-forced-model"]),
          astra_mandate: parseBooleanHeader(header(req.headers["x-jev-astra-mandate"])),
          competing_authority: parseBooleanHeader(header(req.headers["x-jev-competing-authority"])),
          signal: cancellation.signal,
        });
        const headers: Record<string, string> = {
          ...result.upstream.headers,
          "content-type": result.upstream.contentType,
          "x-jev-route": `${result.record.applied_model}:${result.record.applied_effort}`,
          "x-jev-route-source": result.record.route_source,
        };
        delete headers["content-length"];
        res.writeHead(result.upstream.status, headers);
        await pipeline(Readable.fromWeb(result.upstream.body as never), res);
        return;
      }
      const verificationMatch = url.pathname.match(/^\/__jev\/task\/([^/]+)\/verification$/);
      if (req.method === "POST" && verificationMatch) {
        const evidence = (await readJson(req)) as VerificationEvidence;
        const record = proxy.verifyTask(decodeURIComponent(verificationMatch[1]), evidence);
        writeJson(res, 200, { record, task: proxy.taskState(decodeURIComponent(verificationMatch[1])) });
        return;
      }
      writeJson(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof BaselineUnavailableError) {
        writeJson(res, 502, { error: "baseline_unavailable", baseline: error.baseline });
        return;
      }
      if (res.headersSent) {
        responseStreamFailed = true;
        if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof CallCancelledError || isClientAbort(error)) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      writeJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  });
}

function isClientAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as Error & { code?: string }).code === "ECONNRESET");
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Local task associations accept only bounded, printable identifier characters. */
function parseTaskIdHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return "default";
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !looksSensitive(value)
    ? value
    : undefined;
}

function parseBucket(value: string | undefined): "small" | "medium" | "large" | undefined {
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
}

/** Only the documented wire values enable a boolean control. */
function parseBooleanHeader(value: string | undefined): boolean | undefined {
  return value === "1" ? true : value === "0" ? false : undefined;
}

function writeJson(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function pipeline(source: Readable, res: import("node:http").ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    source.on("error", reject);
    res.on("close", resolve);
    source.pipe(res);
    source.on("end", resolve);
  });
}

export async function main(): Promise<void> {
  const config = configFromEnv();
  const discovery = new ModelDiscovery();
  const proofManifest = config.pairProofsFile
    ? parsePairProofManifest(JSON.parse(await readFile(config.pairProofsFile, "utf8")) as unknown)
    : undefined;
  const catalogNow = Date.now();
  const catalog = await discovery.discover("entry", () => fetchModelList(config.upstreamBaseUrl), proofManifest, config.callerEdgeId, catalogNow);
  const candidateCatalogId = currentCandidateCatalogId(config, catalog, catalogNow);
  if (!resolveBaseline(catalog, config.baseline.model, config.baseline.effort, catalogNow)) {
    process.stdout.write(
      `warning: configured baseline ${config.baseline.model}/${config.baseline.effort} has no current caller-edge proof; jev/auto calls will fail closed\n`,
    );
  }
  const unavailableCandidates = config.activeCandidates.filter(pair => !resolveBaseline(catalog, pair.model, pair.effort, catalogNow));
  if (config.activeCandidates.length > 0 && !config.routerOff && unavailableCandidates.length) {
    throw new Error(`JEV_ACTIVE_CANDIDATES are not requestable through the current caller edge: ${unavailableCandidates.map(pair => `${pair.model}/${pair.effort}`).join(",")}`);
  }
  if (config.mode === "active" && !config.routerOff) {
    const report = JSON.parse(await readFile(config.activeEvidenceFile!, "utf8")) as unknown;
    await validateActiveEvidence(report, {
      releaseId: config.releaseId,
      baseline: config.baseline,
      activeCandidates: config.activeCandidates,
      callerEdgeId: config.callerEdgeId,
      candidateCatalogId,
      jevVersion: config.policy.jevVersion,
      runtimePolicy: config.policy,
      policyVersion: POLICY_VERSION,
      questionSchemaVersion: QUESTION_SCHEMA_VERSION,
    }, config.activeEvidenceFile!);
  }
  const transport = fetchJevTransport(config.jevEndpoint, process.env.JEV_API_KEY);
  const proxy = createProductionProxy(config, catalog, transport, new MemoryTelemetry());
  const server = createRouterServer(config, catalog, proxy);
  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`jev-auto-router listening on http://127.0.0.1:${config.port} (mode=${config.mode}, baseline=${config.baseline.model}/${config.baseline.effort})\n`);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}


// Entry guard (CJS-safe): run the server only when invoked directly.
declare const require: { main?: unknown } | undefined;
try {
  const req = typeof require !== "undefined" ? require : undefined;
  if (req && (req as { main?: unknown }).main === module) {
    void main();
  }
} catch {
  // Imported as a library: do nothing.
}
