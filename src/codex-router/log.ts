import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JevScores, Tier } from "./types.js";

export interface DecisionRecord {
  at: string;
  session: string;
  prompt_hash: string;
  prompt_chars: number;
  context_tokens: number;
  current_tier: Tier;
  current_model: string;
  chosen_tier: Tier;
  chosen_model: string;
  confidence: number | null;
  reason: string;
  changed: boolean;
  jev_latency_ms: number;
  jev_model: string;
  scores?: JevScores;
  session_turns: number;
  session_switches: number;
  turns_since_switch: number;
  cache_warm?: boolean | null;
  downgrade_allowed?: boolean | null;
  downgrade_reason?: string;
  break_even_turns?: number | null;
  upgrade_allowed?: boolean;
  effort?: string;
  effort_update?: boolean;
}

export interface DecisionLog {
  write(record: DecisionRecord): void;
}

export class NoopDecisionLog implements DecisionLog {
  write(_record: DecisionRecord): void {}
}

function defaultLogPath(): string {
  return join(homedir(), ".codex-router", "decisions.jsonl");
}

/**
 * Append-only JSONL. Records contain a prompt hash and character count, never
 * the prompt text; the file is created 0600 under a 0700 directory.
 */
export class JsonlDecisionLog implements DecisionLog {
  readonly path: string;
  #ready: Promise<void> | undefined;

  constructor(path = defaultLogPath()) {
    this.path = path;
  }

  write(record: DecisionRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    void this.#append(line);
  }

  async #append(line: string): Promise<void> {
    try {
      this.#ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => undefined);
      await this.#ready;
      await appendFile(this.path, line, { mode: 0o600 });
    } catch {
      // Logging must never break a request.
    }
  }
}

export function createDecisionLog(path: string | undefined): DecisionLog {
  return path ? new JsonlDecisionLog(path) : new JsonlDecisionLog();
}
