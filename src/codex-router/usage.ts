import type { Readable } from "node:stream";
import type { CacheObservation } from "./types.js";

interface UsageRecord {
  input_tokens?: unknown;
  prompt_tokens?: unknown;
  output_tokens?: unknown;
  completion_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  input_tokens_details?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse the provider's response usage without inventing missing fields. */
export function parseUsage(value: unknown, at: number): CacheObservation | undefined {
  const usage = record(value) as UsageRecord | undefined;
  if (!usage) return undefined;
  const details = record(usage.input_tokens_details);
  const inputTokens = number(usage.input_tokens) ?? number(usage.prompt_tokens);
  const outputTokens = number(usage.output_tokens) ?? number(usage.completion_tokens);
  const cachedTokens = number(details?.cached_tokens) ?? number(usage.cached_input_tokens);
  const cacheWriteTokens = number(usage.cache_write_input_tokens) ?? number(details?.cache_write_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined && cacheWriteTokens === undefined) {
    return undefined;
  }
  const cached = cachedTokens ?? 0;
  return {
    inputTokens: inputTokens ?? 0,
    cachedTokens: cached,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    at,
    warm: cached > 0,
  };
}

const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * Passive SSE scanner. It reads terminal `response.completed` usage events and
 * never mutates the stream that Codex receives.
 */
export class UsageScanner {
  #buffer = "";
  #seen = false;
  readonly #onUsage: (usage: CacheObservation) => void;
  readonly #now: () => number;

  constructor(onUsage: (usage: CacheObservation) => void, now: () => number = Date.now) {
    this.#onUsage = onUsage;
    this.#now = now;
  }

  push(chunk: Buffer | string): void {
    if (this.#seen) return;
    this.#buffer += chunk.toString();
    if (this.#buffer.length > MAX_SCAN_BYTES) {
      this.#buffer = this.#buffer.slice(-MAX_SCAN_BYTES);
    }
    let boundary = this.#buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      this.#consume(block);
      if (this.#seen) return;
      boundary = this.#buffer.indexOf("\n\n");
    }
  }

  end(): void {
    if (this.#seen || !this.#buffer.trim()) return;
    this.#consume(this.#buffer);
    this.#buffer = "";
  }

  #consume(block: string): void {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const recordEvent = record(event);
    if (!recordEvent) return;
    if (recordEvent.type !== "response.completed" && recordEvent.type !== "response.incomplete") return;
    const response = record(recordEvent.response);
    const usage = parseUsage(response?.usage, this.#now());
    if (!usage) return;
    this.#seen = true;
    this.#onUsage(usage);
  }
}

/** Attach the scanner without taking over flow control; pipe still sees the bytes. */
export function attachUsageObserver(stream: Readable, scanner: UsageScanner): void {
  stream.on("data", (chunk: Buffer) => scanner.push(chunk));
  stream.on("end", () => scanner.end());
  stream.on("error", () => scanner.end());
}
