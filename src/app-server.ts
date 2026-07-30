import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OfficialRateLimit, OfficialSnapshot } from "./types.js";
import { subtractCredits } from "./credit.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const READ_TIMEOUT_MS = 8_000;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
}

function isRateLimit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const individualLimit = (value as Record<string, unknown>).individualLimit;
  if (!individualLimit || typeof individualLimit !== "object") return false;
  const rate = individualLimit as Record<string, unknown>;
  if (!isDecimal(rate.limit) || !isDecimal(rate.used) || !finiteNumber(rate.remainingPercent) || !finiteNumber(rate.resetsAt)) return false;
  const resetsAt = new Date(rate.resetsAt * 1_000);
  const remaining = subtractCredits(rate.limit, rate.used);
  return !Number.isNaN(resetsAt.valueOf()) && remaining !== undefined;
}

export function normalizeRateLimits(value: unknown): OfficialRateLimit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = value as Record<string, unknown>;
  const byId = response.rateLimitsByLimitId;
  const preferred = byId && typeof byId === "object" ? (byId as Record<string, unknown>).codex : undefined;
  const candidate = isRateLimit(preferred) ? preferred : response.rateLimits;
  if (!isRateLimit(candidate)) return undefined;
  const rate = (candidate as { individualLimit: Record<string, unknown> }).individualLimit;
  return {
    limit: rate.limit as string,
    used: rate.used as string,
    remaining: subtractCredits(rate.limit as string, rate.used as string) as string,
    remainingPercent: rate.remainingPercent as number,
    resetsAt: new Date((rate.resetsAt as number) * 1_000).toISOString()
  };
}

export function hasValidUsage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  const summary = response.summary;
  const summaryFields = ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"];
  const validSummary = Boolean(summary && typeof summary === "object")
    && summaryFields.every((field) => {
      const entry = (summary as Record<string, unknown>)[field];
      return entry === null || finiteNumber(entry);
    });
  const buckets = response.dailyUsageBuckets;
  return validSummary
    && Array.isArray(buckets)
    && buckets.length > 0
    && buckets.every((bucket) => Boolean(bucket && typeof bucket === "object")
      && typeof (bucket as Record<string, unknown>).startDate === "string"
      && finiteNumber((bucket as Record<string, unknown>).tokens));
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  const fallback = setTimeout(() => child.kill(), 250);
  fallback.unref();
}

export async function readOfficialSnapshot(): Promise<OfficialSnapshot> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("codex", ["app-server", "--listen", "stdio://"], { shell: false, stdio: "pipe" });
    } catch {
      resolve({ usageAvailable: false });
      return;
    }
    let buffer = "";
    let bytes = 0;
    let initialized = false;
    let rateLimit: OfficialRateLimit | undefined;
    let usageAvailable = false;
    let rateRead = false;
    let usageRead = false;
    let completed = false;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      stopChild(child);
      resolve({ rateLimit, usageAvailable });
    };
    const timer = setTimeout(finish, READ_TIMEOUT_MS);
    timer.unref();
    const send = (message: object): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (completed) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) return finish();
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) return finish();
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown };
          if (message.id === 1 && !initialized) {
            initialized = true;
            send({ method: "initialized" });
            send({ id: 2, method: "account/rateLimits/read" });
            send({ id: 3, method: "account/usage/read" });
          } else if (message.id === 2) {
            rateRead = true;
            rateLimit = normalizeRateLimits(message.result);
          } else if (message.id === 3) {
            usageRead = true;
            usageAvailable = hasValidUsage(message.result);
          }
          if (initialized && rateRead && usageRead) finish();
        } catch {
          // Ignore malformed protocol lines and keep the bounded read alive.
        }
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) finish();
    });
    child.stderr.resume();
    child.once("error", finish);
    child.once("close", finish);
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex-auto-router", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }
    });
  });
}
