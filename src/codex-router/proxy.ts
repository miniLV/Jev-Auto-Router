import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  availableTiers,
  candidatesFromCatalog,
  candidateForModel,
  mergeCatalogModels,
  modelForTier,
  tierForModel,
} from "./config.js";
import { askJev } from "./jev.js";
import { createDecisionLog, type DecisionLog } from "./log.js";
import { decide, detectOverride, shouldUseExactModel } from "./policy.js";
import { conversationKey, estimateContextTokens, freshTurnPrompt, hashPrompt, promptChars, type ResponsesBody } from "./turn.js";
import type { JevResult, ModelCandidate, RouteInput, RouterConfig, Tier } from "./types.js";
import { AUTO_MODEL } from "./types.js";

export type RouteFn = (input: RouteInput) => Promise<JevResult>;

export interface ProxyOptions {
  config: RouterConfig;
  route?: RouteFn;
  log?: DecisionLog;
  port?: number;
  now?: () => number;
}

export interface RunningProxy {
  port: number;
  server: Server;
  close(): Promise<void>;
}

interface SessionState {
  tier: Tier;
  model: string;
  updatedAt: number;
  turns: number;
  switches: number;
  turnsSinceSwitch: number;
  lastPromptHash?: string;
  lastContextTokens?: number;
}

/** Automatic switching stops once the session has used its stability budget. */
function switchGuard(
  turns: number,
  switches: number,
  turnsSinceSwitch: number,
  config: RouterConfig,
): string | undefined {
  if (config.lockAfterTurns > 0 && turns > config.lockAfterTurns) return "session-lock";
  if (config.maxSwitchesPerSession > 0 && switches >= config.maxSwitchesPerSession) return "switch-budget";
  if (config.switchCooldownTurns > 0 && switches > 0 && turnsSinceSwitch < config.switchCooldownTurns) {
    return "switch-cooldown";
  }
  return undefined;
}

interface RoutingSummary {
  tier: Tier;
  model: string;
  confidence: number | null;
  reason: string;
  changed: boolean;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function writeHeaders(res: ServerResponse, status: number, headers: IncomingHttpHeaders): void {
  res.writeHead(status, headers);
}

function upstreamBase(req: IncomingMessage, config: RouterConfig): string {
  const isModels = req.method === "GET" && /^\/models(?:\?|$)/.test(req.url ?? "");
  return isModels || Boolean(req.headers["chatgpt-account-id"])
    ? config.chatgptBaseUrl
    : config.apiBaseUrl;
}

function upstreamPath(base: string, requestUrl: string): string {
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/$/, "");
  const path = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return `${basePath}${path}`;
}

function upstreamHeaders(req: IncomingMessage, target: URL): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...req.headers, host: target.host };
  delete headers["content-length"];
  // /models is parsed and rewritten; ask the upstream not to compress it.
  if (/^\/models(?:\?|$)/.test(req.url ?? "")) headers["accept-encoding"] = "identity";
  return headers;
}

function requestUpstream(
  req: IncomingMessage,
  body: Buffer,
  config: RouterConfig,
): Promise<IncomingMessage> {
  const base = upstreamBase(req, config);
  const target = new URL(base);
  const transport = target.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const request = transport(
      {
        hostname: target.hostname,
        port: target.port || undefined,
        path: upstreamPath(base, req.url ?? "/"),
        method: req.method,
        headers: upstreamHeaders(req, target),
      },
      resolve,
    );
    request.on("error", reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

function pipeUpstream(upstream: IncomingMessage, res: ServerResponse): void {
  writeHeaders(res, upstream.statusCode ?? 502, upstream.headers);
  upstream.pipe(res);
}

function isSse(headers: IncomingHttpHeaders, first: string): boolean {
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) return true;
  return /^(?:event|data):/m.test(first);
}

function decisionEvents(summary: RoutingSummary): string {
  const text = summary.changed
    ? `[Jev] routed this turn to ${summary.model} (${summary.reason}${summary.confidence === null ? "" : `, confidence ${summary.confidence.toFixed(2)}`}).`
    : `[Jev] kept ${summary.model} for this turn (${summary.reason}).`;
  const id = `jev-${randomUUID()}`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  return [
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", item: { ...item, content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: id, delta: text })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
  ].join("");
}

function streamWithCommentary(
  upstream: IncomingMessage,
  res: ServerResponse,
  summary: RoutingSummary,
): void {
  const headers = { ...upstream.headers };
  delete headers["content-length"];
  writeHeaders(res, upstream.statusCode ?? 502, headers);
  let pending = "";
  let decided = false;
  upstream.on("data", (chunk: Buffer) => {
    if (decided) {
      res.write(chunk);
      return;
    }
    pending += chunk.toString();
    const boundary = pending.indexOf("\n\n");
    if (boundary < 0) return;
    const first = pending.slice(0, boundary + 2);
    res.write(first);
    if (isSse(headers, first)) res.write(decisionEvents(summary));
    res.write(pending.slice(boundary + 2));
    pending = "";
    decided = true;
  });
  upstream.on("end", () => {
    if (pending) res.write(pending);
    res.end();
  });
  upstream.on("error", () => res.destroy());
}

function withCatalogModel(body: ResponsesBody, model: string, candidate: ModelCandidate | undefined): void {
  body.model = model;
  if (!candidate || candidate.supportedEfforts.length === 0) return;
  const reasoning = isRecord(body.reasoning) ? { ...body.reasoning } : undefined;
  const effort = reasoning?.effort;
  if (reasoning && typeof effort === "string" && !candidate.supportedEfforts.includes(effort)) {
    reasoning.effort = candidate.defaultEffort ?? candidate.supportedEfforts[0];
    body.reasoning = reasoning;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export async function startCodexProxy(options: ProxyOptions): Promise<RunningProxy> {
  const { config } = options;
  const clock = options.now ?? Date.now;
  const log = options.log ?? createDecisionLog(config.logFile);
  const route: RouteFn = options.route ?? ((input) => askJev({
    config,
    candidates: input.candidates,
    prompt: input.prompt,
    currentModel: input.currentModel,
    contextTokens: input.contextTokens,
  }));
  const sessions = new Map<string, SessionState>();
  const catalog = new Map<string, ModelCandidate>();
  let candidates: ModelCandidate[] = candidatesFromCatalog(undefined, config.tiers, config.allowLong);

  function remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    if (map.size <= MAX_SESSIONS) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }

  function requestCandidates(): ModelCandidate[] {
    const merged = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const fallback of candidatesFromCatalog(undefined, config.tiers, config.allowLong)) {
      if (!merged.has(fallback.id)) merged.set(fallback.id, fallback);
    }
    return [...merged.values()];
  }

  async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstream = await requestUpstream(req, Buffer.alloc(0), config);
    const chunks: Buffer[] = [];
    let size = 0;
    upstream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_MODEL_BYTES) chunks.push(chunk);
    });
    upstream.on("end", () => {
      const headers = { ...upstream.headers };
      let payload: Buffer = Buffer.concat(chunks);
      if (!upstream.headers["content-encoding"] && payload.length > 0 && payload.length <= MAX_MODEL_BYTES) {
        try {
          const parsed = JSON.parse(payload.toString("utf8")) as unknown;
          const models = isRecord(parsed)
            ? Array.isArray(parsed.models)
              ? parsed.models
              : Array.isArray(parsed.data)
                ? parsed.data
                : undefined
            : undefined;
          if (Array.isArray(models)) {
            const existing = models.some((entry) => isRecord(entry) && entry.slug === AUTO_MODEL);
            if (!existing) {
              const template = models.find((entry) => isRecord(entry) && entry.slug === config.tiers.balanced)
                ?? models.find((entry) => isRecord(entry) && entry.visibility === "list")
                ?? models[0];
              const auto = isRecord(template)
                ? {
                    ...template,
                    slug: AUTO_MODEL,
                    display_name: config.autoModelDisplayName,
                    description: "Jev picks the cheapest model that can complete each turn.",
                    visibility: "list",
                    supported_in_api: true,
                    priority: 0,
                    upgrade: null,
                  }
                : {
                    slug: AUTO_MODEL,
                    display_name: config.autoModelDisplayName,
                    description: "Jev picks the cheapest model that can complete each turn.",
                    visibility: "list",
                    supported_in_api: true,
                    priority: 0,
                    upgrade: null,
                  };
              models.unshift(auto);
              if (isRecord(parsed)) {
                if (Array.isArray(parsed.models)) parsed.models = models;
                else if (Array.isArray(parsed.data)) parsed.data = models;
              }
              payload = Buffer.from(JSON.stringify(parsed));
              delete headers["content-length"];
              catalog.clear();
              candidates = mergeCatalogModels(catalog, parsed, config.tiers, config.allowLong);
            }
          }
        } catch {
          // Keep the original body if the catalog shape changes.
        }
      }
      writeHeaders(res, upstream.statusCode ?? 502, headers);
      res.end(payload);
    });
    upstream.on("error", () => sendJson(res, 502, { error: "upstream_model_list_failed" }));
  }

  async function handleResponses(req: IncomingMessage, body: Buffer, res: ServerResponse): Promise<void> {
    let parsed: ResponsesBody;
    try {
      const raw = JSON.parse(body.toString("utf8")) as unknown;
      if (!isRecord(raw)) throw new Error("not_an_object");
      parsed = raw as ResponsesBody;
    } catch {
      const upstream = await requestUpstream(req, body, config);
      pipeUpstream(upstream, res);
      return;
    }

    let summary: RoutingSummary | undefined;
    if (parsed.model === AUTO_MODEL) {
      const available = requestCandidates();
      const key = conversationKey(parsed);
      const state = sessions.get(key);
      const currentModel = state?.model ?? config.defaultModel;
      const currentTier = tierForModel(currentModel, config.tiers) ?? state?.tier ?? "strong";
      const prompt = freshTurnPrompt(parsed);
      let model = currentModel;
      let tier = currentTier;

      if (prompt) {
        const now = clock();
        const contextTokens = estimateContextTokens(parsed.input);
        const promptHash = hashPrompt(prompt);
        const sameDecision = state?.lastPromptHash === promptHash && state.lastContextTokens === contextTokens;
        const idleMs = state ? now - state.updatedAt : 0;
        const expired = Boolean(state && idleMs > config.cacheTtlMs);
        const turns = (expired ? 0 : state?.turns ?? 0) + 1;
        const switches = expired ? 0 : state?.switches ?? 0;
        const turnsSinceSwitch = expired ? 0 : state?.turnsSinceSwitch ?? 0;
        const override = detectOverride(prompt, config.tiers);
        const guard = override ? undefined : switchGuard(turns, switches, turnsSinceSwitch, config);

        if (sameDecision) {
          // Codex retries an identical request after a transport failure. Reuse
          // the turn's decision instead of asking Jev again or switching model.
          tier = state.tier;
          model = state.model;
        } else if (guard) {
          // A stable long session is often worth more than a late downgrade or
          // an oscillation. Explicit user overrides bypass this guard.
          tier = currentTier;
          model = currentModel;
          remember(sessions, key, {
            tier,
            model,
            updatedAt: now,
            turns,
            switches,
            turnsSinceSwitch: turnsSinceSwitch + 1,
            lastPromptHash: promptHash,
            lastContextTokens: contextTokens,
          });
          log.write({
            at: new Date(now).toISOString(),
            session: key,
            prompt_hash: promptHash,
            prompt_chars: promptChars(prompt),
            context_tokens: contextTokens,
            current_tier: currentTier,
            current_model: currentModel,
            chosen_tier: tier,
            chosen_model: model,
            confidence: null,
            reason: guard,
            changed: false,
            jev_latency_ms: 0,
            jev_model: "NONE",
            session_turns: turns,
            session_switches: switches,
            turns_since_switch: turnsSinceSwitch + 1,
          });
          if (config.debug) {
            process.stderr.write(
              `[jev] ${key} ${currentTier}/${currentModel} -> ${tier}/${model} (${guard}) ctx~${contextTokens}\n`,
            );
          }
        } else {
          const result = await route({
            prompt,
            currentModel,
            currentTier,
            contextTokens,
            candidates: available,
          });
          const chosen = result.answer
            ? available.find((candidate) => candidate.id === result.answer?.choice)
            : undefined;
          const choiceTier = chosen?.tier;
          const decision = decide({
            prompt,
            jev: choiceTier && result.answer
              ? { choice: choiceTier, confidence: result.answer.confidence }
              : null,
            current: currentTier,
            available: availableTiers(available),
            contextTokens,
            config,
          });
          tier = decision.tier;
          model = shouldUseExactModel(decision.reason, choiceTier ?? tier, tier) && chosen
            ? chosen.id
            : tier === currentTier
              ? currentModel
              : modelForTier(available, tier) ?? currentModel;
          const switched = model !== currentModel;
          const nextSwitches = switches + (switched ? 1 : 0);
          const nextTurnsSinceSwitch = switched ? 0 : turnsSinceSwitch + 1;
          remember(sessions, key, {
            tier,
            model,
            updatedAt: now,
            turns,
            switches: nextSwitches,
            turnsSinceSwitch: nextTurnsSinceSwitch,
            lastPromptHash: promptHash,
            lastContextTokens: contextTokens,
          });
          summary = {
            tier,
            model,
            confidence: result.answer?.confidence ?? null,
            reason: decision.reason,
            changed: decision.changed || switched,
          };
          log.write({
            at: new Date(now).toISOString(),
            session: key,
            prompt_hash: promptHash,
            prompt_chars: promptChars(prompt),
            context_tokens: contextTokens,
            current_tier: currentTier,
            current_model: currentModel,
            chosen_tier: tier,
            chosen_model: model,
            confidence: result.answer?.confidence ?? null,
            reason: decision.reason,
            changed: summary.changed,
            jev_latency_ms: result.answer?.latencyMs ?? result.failure?.latencyMs ?? 0,
            jev_model: result.answer?.model ?? "UNKNOWN",
            scores: result.answer?.scores,
            session_turns: turns,
            session_switches: nextSwitches,
            turns_since_switch: nextTurnsSinceSwitch,
          });
          if (config.debug) {
            process.stderr.write(
              `[jev] ${key} ${currentTier}/${currentModel} -> ${tier}/${model} (${decision.reason}) ctx~${contextTokens}\n`,
            );
          }
        }
      }

      withCatalogModel(parsed, model, candidateForModel(available, model));
      const upstream = await requestUpstream(req, Buffer.from(JSON.stringify(parsed)), config);
      const status = upstream.statusCode ?? 500;
      const contentType = String(upstream.headers["content-type"] ?? "").toLowerCase();
      const encoded = Boolean(upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity");
      const maybeSse = contentType.includes("text/event-stream") || contentType === "";
      if (summary && config.commentary && status >= 200 && status < 300 && maybeSse && !encoded) {
        streamWithCommentary(upstream, res, summary);
      } else {
        pipeUpstream(upstream, res);
      }
      return;
    }

    const upstream = await requestUpstream(req, body, config);
    pipeUpstream(upstream, res);
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && /^\/models(?:\?|$)/.test(req.url ?? "")) {
        await handleModels(req, res);
        return;
      }
      if (req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")) {
        const body = await readBody(req, MAX_BODY_BYTES);
        await handleResponses(req, body, res);
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req, MAX_BODY_BYTES);
      const upstream = await requestUpstream(req, body, config);
      pipeUpstream(upstream, res);
    } catch (error) {
      if (errorMessage(error) === "body_too_large") {
        sendJson(res, 413, { error: "body_too_large" });
        return;
      }
      if (!res.headersSent) sendJson(res, 502, { error: "proxy_failed", detail: errorMessage(error) });
      else res.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 0;
  return {
    port,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
