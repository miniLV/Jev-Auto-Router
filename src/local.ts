import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { LocalUsage, ObservationWindow, ReadinessDiagnostic } from "./types.js";

const MAX_OUTPUT_BYTES = 512 * 1024;
const LOCAL_TIMEOUT_MS = 8_000;

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isNamedModel(model: string): boolean {
  return /^gpt-[a-z0-9.-]+$/i.test(model) && !/unknown/i.test(model);
}

export function aggregateLocalUsage(value: unknown): LocalUsage {
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
  return ["codex", "session", "--json", "--offline", "--since", window.since, "--until", window.until];
}

const projectRoot = resolve(__dirname, "../..");

export function resolveCcusageLauncher(root = projectRoot): string | undefined {
  try {
    const packageJsonPath = resolve(root, "node_modules", "ccusage", "package.json");
    const packageDirectory = realpathSync(dirname(packageJsonPath));
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: { ccusage?: unknown } };
    const bin = metadata.bin?.ccusage;
    if (typeof bin !== "string" || bin.length === 0 || isAbsolute(bin) || !bin.endsWith(".js")) return undefined;
    const launcher = realpathSync(resolve(packageDirectory, bin));
    const contained = relative(packageDirectory, launcher);
    return contained && !contained.startsWith("..") && !isAbsolute(contained) && statSync(launcher).isFile() ? launcher : undefined;
  } catch {
    return undefined;
  }
}

function unavailable(code: ReadinessDiagnostic["code"], message: string, remediation: string): LocalUsage {
  return { models: [], skippedEntries: 0, diagnostic: { source: "local", code, message, remediation } };
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  const fallback = setTimeout(() => child.kill(), 250);
  fallback.unref();
}

export async function readLocalUsage(window: ObservationWindow): Promise<LocalUsage> {
  return new Promise((resolve) => {
    const launcher = resolveCcusageLauncher();
    if (!launcher) {
      resolve(unavailable("ccusage-missing", "Local session usage is unavailable because the bundled ccusage launcher is missing.", "Run npm run setup, then retry."));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [launcher, ...buildCcusageArgs(window)], { shell: false, stdio: "pipe", env: process.env });
    } catch {
      resolve(unavailable("unavailable", "Local session usage could not start.", "Run npm run setup, then retry."));
      return;
    }
    let raw = "";
    let bytes = 0;
    let stderrBytes = 0;
    let done = false;
    const finish = (result: LocalUsage): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopChild(child);
      resolve(result);
    };
    const timer = setTimeout(() => finish(unavailable("read-timeout", "Local session usage did not respond within 8 seconds.", "Retry after restarting Codex; run npm run setup to recheck prerequisites.")), LOCAL_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) finish(unavailable("invalid-response", "Local session usage returned an invalid response.", "Update or restart Codex, then retry."));
      else raw += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) finish(unavailable("invalid-response", "Local session usage returned too much diagnostic output.", "Update dependencies with npm run setup, then retry."));
    });
    child.once("error", () => finish(unavailable("unavailable", "Local session usage could not be read.", "Run npm run setup, then retry.")));
    child.once("close", (code) => {
      if (done || bytes > MAX_OUTPUT_BYTES) return;
      if (code !== 0) return finish(unavailable("unavailable", "Local session usage could not be read.", "Restart Codex and retry."));
      try { finish(aggregateLocalUsage(JSON.parse(raw))); } catch { finish(unavailable("invalid-response", "Local session usage returned an invalid response.", "Update or restart Codex, then retry.")); }
    });
  });
}
