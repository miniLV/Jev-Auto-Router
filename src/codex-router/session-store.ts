import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionState } from "./types.js";

export interface SessionStore {
  load(): Promise<Record<string, SessionState>>;
  save(states: Record<string, SessionState>): void;
}

export function defaultSessionFile(): string {
  return join(homedir(), ".codex-router", "sessions.json");
}

export class NoopSessionStore implements SessionStore {
  async load(): Promise<Record<string, SessionState>> {
    return {};
  }
  save(_states: Record<string, SessionState>): void {}
}

export class MemorySessionStore implements SessionStore {
  states: Record<string, SessionState> = {};
  async load(): Promise<Record<string, SessionState>> {
    return structuredClone(this.states);
  }
  save(states: Record<string, SessionState>): void {
    this.states = structuredClone(states);
  }
}

function validState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.model === "string" &&
    (state.tier === "fast" || state.tier === "balanced" || state.tier === "strong" || state.tier === "long") &&
    typeof state.updatedAt === "number" &&
    typeof state.turns === "number" &&
    typeof state.switches === "number" &&
    typeof state.turnsSinceSwitch === "number";
}

/**
 * Atomic JSON persistence. It stores routing state only: no prompt text,
 * credentials or response content. Writes are serialized and files are 0600.
 */
export class JsonSessionStore implements SessionStore {
  readonly path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(path = defaultSessionFile()) {
    this.path = path;
  }

  async load(): Promise<Record<string, SessionState>> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const states: Record<string, SessionState> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (validState(value)) states[key] = value;
      }
      return states;
    } catch {
      return {};
    }
  }

  save(states: Record<string, SessionState>): void {
    const snapshot = JSON.stringify(states);
    this.#queue = this.#queue.then(() => this.#write(snapshot)).catch(() => undefined);
  }

  async #write(snapshot: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export function createSessionStore(path?: string): SessionStore {
  return new JsonSessionStore(path ?? defaultSessionFile());
}
