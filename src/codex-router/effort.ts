import { createHash } from "node:crypto";
import type { EffortUpdate, JevScores } from "./types.js";

export const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

export interface EffortChoice {
  effort: string;
  source: "jev" | "fallback";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeEffort(value: unknown): Effort | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (EFFORT_ORDER as readonly string[]).includes(normalized) ? (normalized as Effort) : undefined;
}

function capIndex(cap: string | undefined): number {
  return normalizeEffort(cap) ? EFFORT_ORDER.indexOf(normalizeEffort(cap)!) : EFFORT_ORDER.length - 1;
}

/** Pick the highest supported effort at or below the requested level. */
function nearestSupported(desired: Effort, supported: readonly string[], cap?: string): Effort | undefined {
  const usable = [...new Set(supported.map(normalizeEffort).filter((value): value is Effort => Boolean(value)))]
    .sort((left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right));
  if (usable.length === 0) return undefined;
  const capped = Math.min(EFFORT_ORDER.indexOf(desired), capIndex(cap));
  const atOrBelow = usable.filter((effort) => EFFORT_ORDER.indexOf(effort) <= capped);
  if (atOrBelow.length > 0) return atOrBelow[atOrBelow.length - 1];
  return usable[0];
}

function desiredFromScores(scores: JevScores | undefined): Effort | undefined {
  if (!scores) return undefined;
  const score = Math.max(scores.reasoningRequired, scores.taskComplexity);
  if (score < 0.25) return "low";
  if (score < 0.5) return "medium";
  if (score < 0.75) return "high";
  if (score < 0.9) return "xhigh";
  return "max";
}

/**
 * Map Jev's complexity scores to an effort the model advertises. The fallback
 * is used when Jev had no scores or the score mapping is unavailable.
 */
export function chooseEffort(
  scores: JevScores | undefined,
  fallback: string,
  cap: string | undefined,
  supported: readonly string[],
): EffortChoice | undefined {
  const fallbackEffort = normalizeEffort(fallback);
  if (!fallbackEffort) return undefined;
  const desired = desiredFromScores(scores) ?? fallbackEffort;
  const effort = nearestSupported(desired, supported, cap);
  if (!effort) return undefined;
  return { effort, source: desiredFromScores(scores) ? "jev" : "fallback" };
}

export function effortIndex(value: string): number {
  const normalized = normalizeEffort(value);
  return normalized ? EFFORT_ORDER.indexOf(normalized) : -1;
}

export function effectiveEffort(baseline: string | undefined, updates: readonly EffortUpdate[] | undefined): string | undefined {
  const last = updates?.at(-1)?.effort;
  return last ?? baseline;
}

export function itemSignature(item: unknown): string {
  try {
    return createHash("sha1").update(JSON.stringify(item)).digest("hex").slice(0, 16);
  } catch {
    return "unhashable";
  }
}

function lastUserIndex(input: unknown): number | undefined {
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item)) continue;
    if (item.role === "user" || (item.type === "message" && item.role === "user")) return index;
  }
  return undefined;
}

/** Append or replace the update at the current user-message anchor. */
export function addOrReplaceUpdate(
  input: unknown,
  updates: readonly EffortUpdate[],
  effort: string,
): EffortUpdate[] {
  const index = lastUserIndex(input);
  if (index === undefined || !normalizeEffort(effort)) return [...updates];
  const anchor = (input as unknown[])[index];
  const next: EffortUpdate = {
    anchorIndex: index,
    anchorSignature: itemSignature(anchor),
    effort: normalizeEffort(effort)!,
  };
  const existing = updates.findIndex((update) => update.anchorIndex === index);
  if (existing >= 0) {
    const copy = [...updates];
    copy[existing] = next;
    return copy.sort((left, right) => left.anchorIndex - right.anchorIndex);
  }
  return [...updates, next].sort((left, right) => left.anchorIndex - right.anchorIndex);
}

/** Every stored anchor must still point at the same native history item. */
export function validateUpdates(input: unknown, updates: readonly EffortUpdate[] | undefined): boolean {
  if (!updates || updates.length === 0) return true;
  if (!Array.isArray(input)) return false;
  return updates.every((update) => {
    const item = input[update.anchorIndex];
    return item !== undefined && itemSignature(item) === update.anchorSignature;
  });
}

function configurationUpdate(effort: string): Record<string, unknown> {
  return { type: "configuration_update", reasoning: { effort } };
}

/**
 * Reinsert all historical authored updates before their anchors. Anchors refer
 * to indices in the native input, which is append-only between compactions.
 */
export function applyEffortUpdates(input: unknown, updates: readonly EffortUpdate[] | undefined): unknown {
  if (!Array.isArray(input) || !updates || updates.length === 0) return input;
  const byAnchor = new Map<number, string[]>();
  for (const update of updates) {
    const list = byAnchor.get(update.anchorIndex) ?? [];
    list.push(update.effort);
    byAnchor.set(update.anchorIndex, list);
  }
  const output: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const efforts = byAnchor.get(index);
    if (efforts) {
      for (const effort of efforts) output.push(configurationUpdate(effort));
    }
    output.push(input[index]);
  }
  return output;
}

/** Remove adjacent duplicate updates so a reinserted history stays valid. */
export function dedupeAdjacentUpdates(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const output: unknown[] = [];
  let previous: string | undefined;
  for (const item of input) {
    if (isRecord(item) && item.type === "configuration_update") {
      const effort = isRecord(item.reasoning) && typeof item.reasoning.effort === "string"
        ? item.reasoning.effort
        : undefined;
      if (effort && effort === previous) continue;
      previous = effort;
    } else {
      previous = undefined;
    }
    output.push(item);
  }
  return output;
}
