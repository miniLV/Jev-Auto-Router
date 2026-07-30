import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { LocalUsage, ObservationWindow } from "./types.js";

const MAX_OUTPUT_BYTES = 512 * 1024;
const LOCAL_TIMEOUT_MS = 8_000;

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isNamedModel(model: string): boolean {
  return /^gpt-[a-z0-9.-]+$/i.test(model) && !/unknown/i.test(model);
}

export function aggregateCcusage(value: unknown): LocalUsage {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).sessions)) return { models: [], skippedEntries: 0 };
  const totals = new Map<string, number>();
  let skippedEntries = 0;
  for (const session of (value as { sessions: unknown[] }).sessions) {
    const models = session && typeof session === "object" ? (session as Record<string, unknown>).models : undefined;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, counts] of Object.entries(models as Record<string, unknown>)) {
      if (!isNamedModel(model) || !counts || typeof counts !== "object") {
        skippedEntries += 1;
        continue;
      }
      const count = counts as Record<string, unknown>;
      const total = numberValue(count.totalTokens) || numberValue(count.inputTokens) + numberValue(count.cachedInputTokens) + numberValue(count.outputTokens) + numberValue(count.reasoningOutputTokens);
      if (total <= 0) {
        skippedEntries += 1;
        continue;
      }
      totals.set(model, (totals.get(model) ?? 0) + total);
    }
  }
  return { models: [...totals].sort(([left], [right]) => left.localeCompare(right)).map(([model, tokens]) => ({ model, tokens })), skippedEntries };
}

export function buildCcusageArgs(window: ObservationWindow): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window.since) || !/^\d{4}-\d{2}-\d{2}$/.test(window.until) || window.timezone !== "UTC") throw new Error("ccusage requires UTC date-only bounds");
  return ["codex", "session", "--json", "--offline", "--since", window.since, "--until", window.until, "--timezone", window.timezone];
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  const fallback = setTimeout(() => child.kill(), 250);
  fallback.unref();
}

export async function readLocalUsage(window: ObservationWindow): Promise<LocalUsage | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("ccusage", buildCcusageArgs(window), { shell: false, stdio: "pipe" });
    } catch {
      resolve(undefined);
      return;
    }
    let raw = "";
    let bytes = 0;
    let done = false;
    const finish = (result?: LocalUsage): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopChild(child);
      resolve(result);
    };
    const timer = setTimeout(() => finish(), LOCAL_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) finish();
      else raw += chunk;
    });
    child.stderr.resume();
    child.once("error", () => finish());
    child.once("close", () => {
      if (done || bytes > MAX_OUTPUT_BYTES) return finish();
      try { finish(aggregateCcusage(JSON.parse(raw))); } catch { finish(); }
    });
  });
}
