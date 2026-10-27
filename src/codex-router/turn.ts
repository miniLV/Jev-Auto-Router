import { createHash } from "node:crypto";

export interface ResponsesBody {
  model?: string;
  input?: unknown;
  tools?: unknown;
  instructions?: string;
  prompt_cache_key?: unknown;
  client_metadata?: unknown;
  [key: string]: unknown;
}

interface InputItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!isRecord(part)) return [];
      if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    })
    .join("\n");
}

export function cleanPrompt(text: string): string {
  return text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
}

export function isAuxiliaryPrompt(prompt: string): boolean {
  return /^Generate a concise, single-line task title\b/i.test(prompt);
}

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
  "tool_search_output",
  "mcp_tool_call_output",
]);

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
  "web_search_call",
]);

const COMPACTION_TYPES = new Set(["compaction", "context_compaction", "compaction_trigger"]);

function isToolOutput(item: InputItem): boolean {
  return typeof item.type === "string" &&
    (TOOL_OUTPUT_TYPES.has(item.type) || item.type.endsWith("_output"));
}

function isToolCall(item: InputItem): boolean {
  return typeof item.type === "string" &&
    (TOOL_CALL_TYPES.has(item.type) || item.type.endsWith("_call"));
}

function isCompaction(item: InputItem): boolean {
  return typeof item.type === "string" && COMPACTION_TYPES.has(item.type);
}

/** Codex puts tool definitions in the input as `additional_tools`; older shapes use `tools`. */
export function hasToolSurface(body: ResponsesBody): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return Array.isArray(body.input) && body.input.some((item) => isRecord(item) && item.type === "additional_tools");
}

/**
 * The current user prompt, or null when this request is a tool continuation or
 * an auxiliary call. Walking backwards is important: a tool result after the
 * last user message means the turn is still running.
 */
export function freshTurnPrompt(body: ResponsesBody): string | null {
  if (!hasToolSurface(body) || !Array.isArray(body.input)) return null;

  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const raw = body.input[index];
    if (!isRecord(raw)) continue;
    const item = raw as InputItem;

    if (isToolOutput(item)) return null;
    if (isToolCall(item)) return null;
    if (isCompaction(item)) return null;
    if (item.type === "reasoning") return null;

    if (item.role === "user" || (item.type === "message" && item.role === "user")) {
      const prompt = cleanPrompt(textOf(item.content));
      if (!prompt || isAuxiliaryPrompt(prompt)) return null;
      return prompt;
    }

    // An assistant/developer/system item after the last user item means this
    // request is a continuation or a retry, not a fresh user turn.
    if (item.role && item.role !== "user") return null;
  }
  return null;
}

function stableText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (isRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Stable per-conversation key; prefer the same fields Codex uses for cache routing. */
export function conversationKey(body: ResponsesBody): string {
  const metadata = isRecord(body.client_metadata) ? body.client_metadata : undefined;
  const stable =
    stableText(body.prompt_cache_key) ??
    stableText(metadata?.["x-codex-turn-metadata"]) ??
    `${body.instructions ?? ""}|${firstUserText(body.input) ?? ""}`;
  return createHash("sha1").update(stable).digest("hex").slice(0, 12);
}

function firstUserText(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    if (raw.role === "user" || (raw.type === "message" && raw.role === "user")) {
      const text = textOf(raw.content);
      if (text) return text;
    }
  }
  return undefined;
}

/** Approximate context size. The exact token count is not available on the request hot path. */
export function estimateContextTokens(value: unknown): number {
  if (!Array.isArray(value) && !isRecord(value)) return 0;
  try {
    return Math.round(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

export function promptChars(prompt: string): number {
  return [...prompt].length;
}

/** A compaction changes the cache prefix; the caller should reset cache warmth. */
export function hasCompaction(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) => isRecord(item) && typeof item.type === "string" && COMPACTION_TYPES.has(item.type));
}

/**
 * Remove provider-bound encrypted reasoning before a cross-model continuation.
 * A readable summary or content is preserved. Items with neither are dropped.
 * Returns the number of reasoning items changed or removed.
 */
export function stripForeignReasoning(body: ResponsesBody): number {
  if (!Array.isArray(body.input)) return 0;
  let changed = 0;
  const kept: unknown[] = [];
  for (const raw of body.input) {
    if (!isRecord(raw) || raw.type !== "reasoning" || typeof raw.encrypted_content !== "string") {
      kept.push(raw);
      continue;
    }
    changed += 1;
    const { encrypted_content: _encrypted, id: _id, ...rest } = raw;
    const summary = Array.isArray(rest.summary) ? rest.summary.length > 0 : false;
    const content = Array.isArray(rest.content) ? rest.content.length > 0 : false;
    if (summary || content) kept.push(rest);
  }
  body.input = kept;
  return changed;
}
