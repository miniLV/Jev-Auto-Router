import type { JevAnswer, JevResult, ModelCandidate, RouterConfig } from "./types.js";

export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}

export interface JevResponse {
  model?: unknown;
  answers?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

export type JevTransport = (
  request: JevRequest,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<JevResponse>;

const SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

const MAX_SCORE = SCALE.length - 1;

const TIER_GUIDANCE: Record<string, string> = {
  fast: "Trivial, mechanical or purely factual work. Renames, formatting, one obvious command.",
  balanced: "Ordinary engineering with a clear, bounded shape. A specified function, a local fix, routine tests.",
  strong: "Hard reasoning, ambiguity or high blast radius. Unknown-cause debugging, cross-module design, security, concurrency.",
  long: "Very large or long-running work beyond a focused session. Whole-repo migration or multi-hour autonomy.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The exact wire request. Kept pure so tests can inspect what leaves the process. */
export function buildJevRequest(
  prompt: string,
  currentModel: string,
  contextTokens: number,
  candidates: readonly ModelCandidate[],
  config: Pick<RouterConfig, "jevModel">,
): JevRequest {
  const criteria = Object.fromEntries(
    candidates.map((candidate) => [
      candidate.id,
      [
        candidate.description || candidate.id,
        TIER_GUIDANCE[candidate.tier],
      ].filter(Boolean).join(" "),
    ]),
  );

  return {
    model: config.jevModel,
    state: {
      request: prompt,
      session: {
        current_model: currentModel,
        context_tokens: contextTokens,
      },
      environment: {
        available_models: candidates.map((candidate) => candidate.id),
      },
    },
    questions: {
      task_complexity: {
        type: "score",
        instructions: "How complex is the coding task overall, including ambiguity, scope and blast radius?",
        criteria: SCALE,
      },
      reasoning_required: {
        type: "score",
        instructions: "How much reasoning is required to complete the request correctly in one pass?",
        criteria: SCALE,
      },
      tool_complexity: {
        type: "score",
        instructions: "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
        criteria: SCALE,
      },
      route: {
        type: "choice",
        instructions: [
          "Pick the cheapest exact model that can fully complete this coding request in one pass without retrying on a stronger model.",
          "Treat different model versions as separate choices.",
          "Judge the required reasoning, not the requested reply length.",
        ].join(" "),
        criteria,
      },
    },
  };
}

interface ParsedAnswer {
  choice: string;
  confidence: number;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  scores?: JevAnswer["scores"];
}

export function parseJevResponse(
  response: JevResponse,
  candidates: readonly ModelCandidate[],
  contextTokens: number,
  contextWindowTokens: number,
): ParsedAnswer | undefined {
  if (!isRecord(response.answers)) return undefined;
  const answers = response.answers;
  if (!isRecord(answers.route)) return undefined;
  const route = answers.route;
  if (route.type !== "choice" || typeof route.choice !== "string") return undefined;
  if (!candidates.some((candidate) => candidate.id === route.choice)) return undefined;
  const confidence = finiteNumber(route.confidence);
  if (confidence === undefined || confidence < 0 || confidence > 1) return undefined;

  const score = (name: string): number | undefined => {
    const answer = answers[name];
    if (!isRecord(answer) || answer.type !== "score") return undefined;
    const value = finiteNumber(answer.score);
    if (value === undefined) return undefined;
    return Math.min(1, Math.max(0, value / MAX_SCORE));
  };
  const taskComplexity = score("task_complexity");
  const reasoningRequired = score("reasoning_required");
  const toolComplexity = score("tool_complexity");
  const scores = taskComplexity !== undefined && reasoningRequired !== undefined && toolComplexity !== undefined
    ? {
        taskComplexity,
        reasoningRequired,
        toolComplexity,
        contextSize: Math.min(contextTokens / contextWindowTokens, 1),
      }
    : undefined;

  const usageRecord = isRecord(response.usage) ? response.usage : undefined;
  const inputTokens = finiteNumber(usageRecord?.input_tokens);
  const outputTokens = finiteNumber(usageRecord?.output_tokens);
  const usage = inputTokens !== undefined && outputTokens !== undefined
    ? { input_tokens: inputTokens, output_tokens: outputTokens }
    : undefined;

  return {
    choice: route.choice,
    confidence,
    model: typeof response.model === "string" ? response.model : "UNKNOWN",
    usage,
    scores,
  };
}

function failure(reason: string, detail: string | undefined, latencyMs: number): JevResult {
  return { failure: { reason, detail, latencyMs } };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export function createJevTransport(endpoint: string, apiKey: string): JevTransport {
  return async (request, options) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: options.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return (await response.json()) as JevResponse;
  };
}

export interface AskJevOptions {
  config: RouterConfig;
  candidates: readonly ModelCandidate[];
  prompt: string;
  currentModel: string;
  contextTokens: number;
  signal?: AbortSignal;
  transport?: JevTransport;
}

export async function askJev(options: AskJevOptions): Promise<JevResult> {
  const { config, candidates, prompt, currentModel, contextTokens } = options;
  const apiKey = config.apiKey;
  if (!apiKey) return failure("no_api_key", undefined, 0);
  if (candidates.length === 0) return failure("no_candidates", undefined, 0);

  const transport = options.transport ?? createJevTransport(config.jevEndpoint, apiKey);
  const request = buildJevRequest(prompt, currentModel, contextTokens, candidates, config);
  const started = Date.now();
  const deadline = AbortSignal.timeout(config.jevDeadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let lastDetail = "unknown";

  for (let attempt = 0; attempt <= config.jevMaxRetries; attempt += 1) {
    try {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(config.jevTimeoutMs)]);
      const response = await transport(request, { timeoutMs: config.jevTimeoutMs, signal: attemptSignal });
      const parsed = parseJevResponse(response, candidates, contextTokens, config.contextWindowTokens);
      if (!parsed) return failure("malformed_response", undefined, Date.now() - started);
      return {
        answer: {
          ...parsed,
          latencyMs: Date.now() - started,
        },
      };
    } catch (error) {
      if (options.signal?.aborted) return failure("cancelled", undefined, Date.now() - started);
      if (deadline.aborted) return failure("timeout", undefined, Date.now() - started);
      lastDetail = error instanceof Error ? error.message : "unknown";
      if (attempt < config.jevMaxRetries) {
        try {
          await abortableSleep(150, signal);
        } catch {
          return failure("cancelled", undefined, Date.now() - started);
        }
      }
    }
  }
  return failure("transport", lastDetail, Date.now() - started);
}

export type { JevAnswer };
