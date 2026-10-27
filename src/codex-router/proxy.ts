import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import {
  availableTiers,
  candidatesFromCatalog,
  candidateForModel,
  mergeCatalogModels,
  modelForTier,
  rankOf,
  tierForModel,
} from "./config.js";
import { effectiveTurnLock, evaluateDowngrade, remainingTurns } from "./cache.js";
import {
  addOrReplaceUpdate,
  applyEffortUpdates,
  chooseEffort,
  dedupeAdjacentUpdates,
  effectiveEffort,
  validateUpdates,
} from "./effort.js";
import { askJev } from "./jev.js";
import { createDecisionLog, type DecisionLog } from "./log.js";
import { decide, detectOverride, shouldUseExactModel } from "./policy.js";
import {
  conversationKey,
  estimateContextTokens,
  freshTurnPrompt,
  hasCompaction,
  hashPrompt,
  promptChars,
  stripForeignReasoning,
  type ResponsesBody,
} from "./turn.js";
import { attachUsageObserver, UsageScanner } from "./usage.js";
import { NoopSessionStore, type SessionStore } from "./session-store.js";
import type { EffortUpdate, JevResult, ModelCandidate, RouteInput, RouterConfig, SessionState, Tier } from "./types.js";
import { AUTO_MODEL } from "./types.js";

export type RouteFn = (input: RouteInput) => Promise<JevResult>;

export interface ProxyOptions {
  config: RouterConfig;
  route?: RouteFn;
  log?: DecisionLog;
  store?: SessionStore;
  port?: number;
  now?: () => number;
}

export interface RunningProxy {
  port: number;
  server: Server;
  close(): Promise<void>;
}

/** Automatic switching stops once the session has used its stability budget. */
function switchGuard(
  turns: number,
  switches: number,
  turnsSinceSwitch: number,
  config: RouterConfig,
): string | undefined {
  const lock = effectiveTurnLock(config);
  if (lock > 0 && turns > lock) return "session-lock";
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
  effort?: string;
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
  const effort = summary.effort ? `, effort ${summary.effort}` : "";
  const text = summary.changed
    ? `[Jev] routed this turn to ${summary.model} (${summary.reason}${summary.confidence === null ? "" : `, confidence ${summary.confidence.toFixed(2)}`}${effort}).`
    : `[Jev] kept ${summary.model} for this turn (${summary.reason}${effort}).`;
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

function reasoningEffort(body: ResponsesBody): string | undefined {
  return isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
    ? body.reasoning.effort
    : undefined;
}

function withCatalogModel(
  body: ResponsesBody,
  model: string,
  candidate: ModelCandidate | undefined,
  preserveEffort = false,
): void {
  body.model = model;
  if (preserveEffort) return;
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
  const store = options.store ?? new NoopSessionStore();
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

  for (const [key, state] of Object.entries(await store.load())) {
    if (clock() - state.updatedAt <= config.sessionTtlMs) sessions.set(key, state);
  }

  function persist(): void {
    store.save(Object.fromEntries(sessions));
  }

  function remember(key: string, value: SessionState): void {
    sessions.set(key, value);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    persist();
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
                    description: "Jev picks model + effort once per turn; the model stays pinned through the tool loop.",
                    visibility: "list",
                    supported_in_api: true,
                    priority: 0,
                    upgrade: null,
                  }
                : {
                    slug: AUTO_MODEL,
                    display_name: config.autoModelDisplayName,
                    description: "Jev picks model + effort once per turn; the model stays pinned through the tool loop.",
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
    let sessionKey: string | undefined;
    let switchedModel = false;
    if (parsed.model === AUTO_MODEL) {
      const available = requestCandidates();
      const key = conversationKey(parsed);
      sessionKey = key;
      const state = sessions.get(key);
      const now = clock();
      const currentModel = state?.model ?? config.defaultModel;
      const currentTier = tierForModel(currentModel, config.tiers) ?? state?.tier ?? "strong";
      const prompt = freshTurnPrompt(parsed);
      const nativeEffort = reasoningEffort(parsed);
      let model = currentModel;
      let tier = currentTier;
      let effortBaseline = state?.effortBaseline ?? nativeEffort;
      let effortModel = state?.effortModel ?? currentModel;
      let effortUpdates = state?.effortUpdates ?? [];

      if (config.effortRouting === "off") {
        effortBaseline = nativeEffort;
        effortUpdates = [];
        effortModel = currentModel;
      } else if (!validateUpdates(parsed.input, effortUpdates)) {
        // Compaction/truncation or a repaired history invalidated the anchors.
        effortBaseline = nativeEffort;
        effortUpdates = [];
        effortModel = currentModel;
        if (state) {
          state.effortBaseline = effortBaseline;
          state.effortModel = effortModel;
          state.effortUpdates = effortUpdates;
          persist();
        }
      }

      if (state && hasCompaction(parsed.input)) {
        // A compaction replaces the prefix; the old cache evidence is no longer
        // valid and the cooldown should not block a fresh evaluation.
        state.cache = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, at: now, warm: false };
        state.turnsSinceSwitch = config.switchCooldownTurns;
        state.lastPromptHash = undefined;
        effortBaseline = nativeEffort;
        effortUpdates = [];
        effortModel = currentModel;
        state.effortBaseline = effortBaseline;
        state.effortModel = effortModel;
        state.effortUpdates = effortUpdates;
        persist();
      }

      if (prompt) {
        const contextTokens = estimateContextTokens(parsed.input);
        const promptHash = hashPrompt(prompt);
        const sameDecision = state?.lastPromptHash === promptHash && state.lastContextTokens === contextTokens;
        const idleMs = state ? now - state.updatedAt : 0;
        const expired = Boolean(state && idleMs > config.cacheTtlMs);
        const turns = (expired ? 0 : state?.turns ?? 0) + 1;
        const switches = expired ? 0 : state?.switches ?? 0;
        const turnsSinceSwitch = expired ? 0 : state?.turnsSinceSwitch ?? 0;
        const cacheWarm = state?.cache && now - state.cache.at <= config.cacheTtlMs
          ? state.cache.warm
          : undefined;
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
          remember(key, {
            tier,
            model,
            updatedAt: now,
            turns,
            switches,
            turnsSinceSwitch: turnsSinceSwitch + 1,
            lastPromptHash: promptHash,
            lastContextTokens: contextTokens,
            cache: state?.cache,
            lastFailureAt: state?.lastFailureAt,
            effortBaseline,
            effortModel,
            effortUpdates,
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
            cache_warm: cacheWarm ?? null,
            effort: effectiveEffort(effortBaseline, effortUpdates),
            effort_update: effortUpdates.length > 0,
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
          const failureRecent = state?.lastFailureAt !== undefined && now - state.lastFailureAt <= config.upgradeFailureTtlMs;
          const scores = result.answer?.scores;
          const highComplexity = Boolean(scores && (
            scores.reasoningRequired >= config.upgradeComplexityThreshold ||
            scores.taskComplexity >= config.upgradeComplexityThreshold
          ));
          const allowUpgrade = config.upgradeMode === "always" || failureRecent || highComplexity;
          const downgrade = chosen && choiceTier && rankOf(choiceTier) < rankOf(currentTier)
            ? evaluateDowngrade({
                prefixTokens: contextTokens,
                currentModel,
                targetModel: chosen.id,
                prices: config.prices,
                cacheWarm,
                remainingTurns: remainingTurns(config, turns),
                outputTokensPerTurn: config.outputTokensPerTurn,
              })
            : undefined;
          const decision = decide({
            prompt,
            jev: choiceTier && result.answer
              ? { choice: choiceTier, confidence: result.answer.confidence }
              : null,
            current: currentTier,
            available: availableTiers(available),
            contextTokens,
            allowUpgrade,
            downgrade,
            config,
          });
          tier = decision.tier;
          model = shouldUseExactModel(decision.reason, choiceTier ?? tier, tier) && chosen
            ? chosen.id
            : tier === currentTier
              ? currentModel
              : modelForTier(available, tier) ?? currentModel;
          switchedModel = model !== currentModel;
          const nextSwitches = switches + (switchedModel ? 1 : 0);
          const nextTurnsSinceSwitch = switchedModel ? 0 : turnsSinceSwitch + 1;
          const finalCandidate = candidateForModel(available, model);
          if (effortModel !== model || switchedModel) {
            effortBaseline = nativeEffort;
            effortUpdates = [];
            effortModel = model;
          }
          if (
            config.effortRouting === "turn" &&
            finalCandidate?.supportsEffortUpdates &&
            finalCandidate.supportedEfforts.length > 0
          ) {
            const choice = chooseEffort(scores, config.effortFallback, config.effortCap, finalCandidate.supportedEfforts);
            if (choice) {
              const currentEffort = effectiveEffort(effortBaseline, effortUpdates);
              if (choice.effort !== currentEffort) {
                effortUpdates = addOrReplaceUpdate(parsed.input, effortUpdates, choice.effort);
              }
              effortModel = model;
            }
          } else if (!finalCandidate?.supportsEffortUpdates) {
            effortBaseline = nativeEffort;
            effortUpdates = [];
            effortModel = model;
          }
          remember(key, {
            tier,
            model,
            updatedAt: now,
            turns,
            switches: nextSwitches,
            turnsSinceSwitch: nextTurnsSinceSwitch,
            lastPromptHash: promptHash,
            lastContextTokens: contextTokens,
            cache: state?.cache,
            lastFailureAt: state?.lastFailureAt,
            effortBaseline,
            effortModel,
            effortUpdates,
          });
          summary = {
            tier,
            model,
            confidence: result.answer?.confidence ?? null,
            reason: decision.reason,
            changed: decision.changed || switchedModel,
            effort: effectiveEffort(effortBaseline, effortUpdates),
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
            cache_warm: cacheWarm ?? null,
            downgrade_allowed: downgrade?.allowed ?? null,
            downgrade_reason: downgrade?.reason,
            break_even_turns: downgrade?.breakEvenTurns ?? null,
            upgrade_allowed: allowUpgrade,
            effort: effectiveEffort(effortBaseline, effortUpdates),
            effort_update: effortUpdates.length > 0,
          });
          if (config.debug) {
            process.stderr.write(
              `[jev] ${key} ${currentTier}/${currentModel} -> ${tier}/${model} (${decision.reason}) ctx~${contextTokens}\n`,
            );
          }
        }
      }

      const finalCandidate = candidateForModel(available, model);
      const effortCapable = config.effortRouting === "turn" &&
        Boolean(finalCandidate?.supportsEffortUpdates) &&
        Boolean(finalCandidate && finalCandidate.supportedEfforts.length > 0);
      withCatalogModel(parsed, model, finalCandidate, effortCapable);
      if (effortCapable && effortUpdates.length > 0) {
        parsed.input = dedupeAdjacentUpdates(applyEffortUpdates(parsed.input, effortUpdates));
      }
      if (config.stripEncryptedReasoning) stripForeignReasoning(parsed);
      const upstream = await requestUpstream(req, Buffer.from(JSON.stringify(parsed)), config);
      const status = upstream.statusCode ?? 500;
      const contentType = String(upstream.headers["content-type"] ?? "").toLowerCase();
      const encoded = Boolean(upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity");
      const maybeSse = contentType.includes("text/event-stream") || contentType === "";
      if (sessionKey) {
        const activeKey = sessionKey;
        attachUsageObserver(upstream, new UsageScanner((usage) => {
          const current = sessions.get(activeKey);
          if (!current) return;
          current.cache = usage;
          persist();
        }, clock));
      }
      if (sessionKey && status >= 400) {
        const failed = sessions.get(sessionKey);
        if (failed) {
          failed.lastFailureAt = clock();
          persist();
        }
      }
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
