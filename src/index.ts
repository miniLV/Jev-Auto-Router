import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { DEFAULT_ROUTER_CONFIG, MemoryTelemetry, ResponsesProxy, type RouterConfig, type UpstreamResult } from "./proxy.js";
import { DEFAULT_JEV_POLICY, type JevPolicy, type JevTransport, type JevTransportRequest } from "./jev-adapter.js";
import { ModelDiscovery, type HostModelList } from "./discovery.js";
import type { ModelCatalog } from "./catalog.js";
import type { ResponsesRequest } from "./execution-contract.js";
import { lunaBindingDefect, type ModelInfo } from "./catalog.js";
import type { StepType } from "./types.js";
import type { VerificationEvidence } from "./verification.js";

/** Entry configuration: startup, host model discovery and a small config surface. */
export interface EntryConfig extends RouterConfig {
  port: number;
  upstreamBaseUrl: string;
  jevEndpoint: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EntryConfig {
  const policy: JevPolicy = {
    jevVersion: env.JEV_VERSION ?? DEFAULT_JEV_POLICY.jevVersion,
    confidenceFloor: numberOrDefault(env.JEV_CONFIDENCE_FLOOR, DEFAULT_JEV_POLICY.confidenceFloor),
    deadlineMs: numberOrDefault(env.JEV_DEADLINE_MS, DEFAULT_JEV_POLICY.deadlineMs),
  };
  const [baselineModel, baselineEffort] = (env.JEV_BASELINE ?? "gpt-5.6-terra/medium").split("/");
  const [verificationModel, verificationEffort] = (env.JEV_VERIFICATION_TIER ?? "gpt-5.6-sol/medium").split("/");
  const [infraModel, infraEffort] = (env.JEV_INFRA_PROFILE ?? "gpt-5.6-terra/medium").split("/");
  return {
    ...DEFAULT_ROUTER_CONFIG,
    routerOff: env.JEV_ROUTER_OFF === "1",
    mode: env.JEV_MODE === "shadow" ? "shadow" : "active",
    baseline: { model: baselineModel, effort: baselineEffort },
    verificationTier: { model: verificationModel, effort: verificationEffort },
    infrastructureProfile: { model: infraModel, effort: infraEffort },
    policy,
    port: numberOrDefault(env.JEV_PORT, 8787),
    upstreamBaseUrl: env.JEV_UPSTREAM_BASE_URL ?? "https://api.openai.com",
    jevEndpoint: env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone",
  };
}

function numberOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function fetchJevTransport(endpoint: string, apiKey: string | undefined): JevTransport {
  return async (request: JevTransportRequest, timeoutMs: number) => {
    if (!apiKey) throw new Error("auth: JEV_API_KEY is not configured");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`auth: ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw new Error(`non_retryable: ${response.status}`);
      throw new Error(`http ${response.status}`);
    }
    return (await response.json()) as { model?: string; choice?: string; confidence?: number; usage?: { input_tokens?: number; output_tokens?: number } };
  };
}

async function fetchUpstream(baseUrl: string, request: ResponsesRequest): Promise<UpstreamResult> {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.body) throw new Error("upstream returned no body");
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/json",
    body: response.body,
  };
}

async function fetchModelList(baseUrl: string): Promise<HostModelList> {
  const response = await fetch(`${baseUrl}/models`);
  if (!response.ok) throw new Error(`model list failed: ${response.status}`);
  const payload = (await response.json()) as { data?: Array<{ id: string; supported_efforts?: string[] }> };
  return {
    source: `${baseUrl}/models`,
    models: (payload.data ?? []).map(entry => ({ model: entry.id, supported_efforts: entry.supported_efforts })),
  };
}

/** Local-only operational surfaces: health and the decision log. Never a control plane. */
export function createRouterServer(config: EntryConfig, catalog: ModelCatalog, proxy: ResponsesProxy): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, {
          routerOff: config.routerOff,
          mode: config.mode,
          jevVersion: config.policy.jevVersion,
          baseline: config.baseline,
          lunaBindingDefect: lunaBindingDefect(catalog) ?? null,
          catalogSize: catalog.models.filter((m: ModelInfo) => m.requestable).length,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/decisions") {
        writeJson(res, 200, { calls: proxy.telemetry.calls, tasks: proxy.telemetry.tasks });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const body = (await readJson(req)) as ResponsesRequest;
        // Control signals travel as headers so the forwarded body stays native.
        const taskId = req.headers["x-jev-task-id"] ?? "default";
        const step = (req.headers["x-jev-step"] as StepType | undefined) ?? "other";
        const result = await proxy.routeCall({
          task_id: typeof taskId === "string" ? taskId : "default",
          step_type: step,
          request: body,
          current_model: header(req.headers["x-jev-current-model"]),
          forced_model: header(req.headers["x-jev-forced-model"]),
          gpt6_mandate: req.headers["x-jev-gpt6-mandate"] === "1",
          competing_authority: req.headers["x-jev-competing-authority"] === "1",
        });
        res.writeHead(result.upstream.status, {
          "content-type": result.upstream.contentType,
          "x-jev-route": `${result.record.actual_model}:${result.record.actual_effort}`,
          "x-jev-route-source": result.record.route_source,
        });
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
      writeJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  });
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
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
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      source.on("error", reject);
      res.on("close", resolve);
      source.pipe(res);
      source.on("end", resolve);
    }),
  ]).catch(() => {
    if (!res.writableEnded) res.end();
  });
}

export async function main(): Promise<void> {  const config = configFromEnv();
  const discovery = new ModelDiscovery();
  const catalog = await discovery.discover("entry", () => fetchModelList(config.upstreamBaseUrl), Date.now());
  const transport = fetchJevTransport(config.jevEndpoint, process.env.JEV_API_KEY);
  const proxy = new ResponsesProxy(config, catalog, transport, request => fetchUpstream(config.upstreamBaseUrl, request), new MemoryTelemetry());
  const server = createRouterServer(config, catalog, proxy);
  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`jev-auto-router listening on http://127.0.0.1:${config.port}\n`);
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
