/**
 * Task-boundary verification, correction cycles and Root takeover.
 * Verification is outside the economic routing loop: acceptance is read
 * from the original user request, checks run independently, and necessary
 * semantic judgment belongs to the fixed verification tier.
 */

export const MAX_CORRECTION_CYCLES = 2;

export interface AcceptanceCondition {
  id: string;
  condition: string;
}

export type EvidenceKind = "diff" | "test" | "artifact" | "run";

export type EvidenceStatus = "pass" | "fail" | "insufficient";

export interface EvidenceItem {
  acceptance_id: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  detail_ref: string;
}

export interface VerificationEvidence {
  conditions: AcceptanceCondition[];
  evidence: EvidenceItem[];
}

export interface VerificationResult {
  verification: "PASS" | "FAIL";
  /** Present on FAIL: specific failing items for the same-session correction. */
  failing: EvidenceItem[];
  evidence_refs: string[];
}

/**
 * PASS requires every acceptance condition independently evidenced. Model
 * self-report is never evidence; missing evidence is never PASS.
 */
export function verifyTask(evidence: VerificationEvidence): VerificationResult {
  const evidence_refs = evidence.evidence.map(item => item.detail_ref);
  const byCondition = new Map<string, EvidenceItem[]>();
  for (const item of evidence.evidence) {
    const list = byCondition.get(item.acceptance_id) ?? [];
    list.push(item);
    byCondition.set(item.acceptance_id, list);
  }
  const failing: EvidenceItem[] = [];
  for (const condition of evidence.conditions) {
    const items = byCondition.get(condition.id) ?? [];
    const hasPass = items.some(item => item.status === "pass");
    if (!hasPass) {
      // Report the concrete failing check, or the absence of evidence as such.
      failing.push(items.find(item => item.status === "fail") ?? {
        acceptance_id: condition.id,
        kind: "run",
        status: "insufficient",
        detail_ref: `no-passing-evidence:${condition.id}`,
      });
    }
  }
  return {
    verification: failing.length === 0 ? "PASS" : "FAIL",
    failing,
    evidence_refs,
  };
}

export type TakeoverTrigger =
  | "correction_cycles_exhausted"
  | "repeated_defect"
  | "scope_runaway"
  | "permission_problem"
  | "unclear_identity"
  | "gpt6_avoided_when_necessary";

export interface TaskState {
  task_id: string;
  status: "running" | "verifying" | "completed" | "unverified" | "taken_over";
  correction_cycles: number;
  takeover?: TakeoverTrigger;
  /** Bounded failure facts returned to the same session for correction. */
  failure_facts?: { failing_item_ids: string[] };
  /** One-shot GPT-6 eligibility: cleared after use or resolution. */
  gpt6_eligibility?: { reason_code: string; evidence_ref: string };
  /** Tracks defects for the immediate repeated-defect takeover. */
  seen_defect_ids: string[];
}

export function newTask(task_id: string): TaskState {
  return { task_id, status: "running", correction_cycles: 0, seen_defect_ids: [] };
}

/**
 * Apply a task-boundary verification result. One correction cycle spans
 * from an independent FAIL to the end of the next verification. Default
 * maximum 2 cycles, then Root takeover; repeated defects take over
 * immediately.
 */
export function recordVerification(task: TaskState, result: VerificationResult): TaskState {
  if (result.verification === "PASS") {
    return { ...task, status: "completed", failure_facts: undefined };
  }

  const defectIds = result.failing.map(item => `${item.acceptance_id}:${item.kind}`);
  const repeated = defectIds.some(id => task.seen_defect_ids.includes(id));

  if (task.correction_cycles >= MAX_CORRECTION_CYCLES) {
    return {
      ...task,
      status: "taken_over",
      takeover: "correction_cycles_exhausted",
      seen_defect_ids: [...task.seen_defect_ids, ...defectIds],
    };
  }
  if (repeated) {
    return {
      ...task,
      status: "taken_over",
      takeover: "repeated_defect",
      seen_defect_ids: [...task.seen_defect_ids, ...defectIds],
    };
  }

  return {
    ...task,
    status: "running",
    correction_cycles: task.correction_cycles + 1,
    failure_facts: { failing_item_ids: result.failing.map(item => item.acceptance_id) },
    seen_defect_ids: [...task.seen_defect_ids, ...defectIds],
  };
}

/** Immediate takeover triggers that bypass cycle counting. */
export function immediateTakeover(task: TaskState, trigger: TakeoverTrigger): TaskState {
  return { ...task, status: "taken_over", takeover: trigger };
}

/**
 * One verified reasoning-blocker evidence grants one temporary eligibility
 * for the next call targeting that blocker. It is consumed by use or
 * cleared by resolution; it never persists across routine calls.
 */
export function openGpt6Eligibility(task: TaskState, reason_code: string, evidence_ref: string): TaskState {
  if (task.gpt6_eligibility) return task;
  return { ...task, gpt6_eligibility: { reason_code, evidence_ref } };
}

export function consumeGpt6Eligibility(task: TaskState): TaskState {
  if (!task.gpt6_eligibility) return task;
  const next = { ...task };
  delete next.gpt6_eligibility;
  return next;
}
