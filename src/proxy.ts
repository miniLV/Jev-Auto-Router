import {
  buildCandidateSet,
  resolveBaseline,
  type CandidateConstraints,
  type CandidatePair,
  type ModelCatalog,
} from "./catalog.js";
import {
  applyRoute,
  observeFromCompletedEvent,
  type AppliedRoute,
  type ObservedExecution,
  type ResponsesRequest,
} from "./execution-contract.js";
import { choose, DEFAULT_JEV_POLICY, type JevDecision, type JevPolicy, type JevTransport } from "./jev-adapter.js";
import { trackResolvedVersion, type VersionDisciplineState } from "./observation.js";
import { validate } from "./policy-guard.js";
import { buildCallRecord, type CallRecord, type TaskRecord } from "./receipt.js";
import { buildRoutingState, type RoutingState, type ToolFacts } from "./route-plan.js";
import { UNKNOWN, unknownUsage, type StepType } from "./types.js";
import {
  consumeGpt6Eligibility,
  newTask,
  openGpt6Eligibility,
  recordVerification,
  verifyTask,
  type TaskState,
  type VerificationEvidence,
} from "./verification.js";

export interface RouterConfig {
  routerOff: boolean;
  mode: "active" | "shadow";
  baseline: { model: string; effort: string };
  verificationTier: { model: string; effort: string };
  infrastructureProfile: { model: string; effort: string };
  policy: JevPolicy;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  routerOff: false,
  mode: "active",
  baseline: { model: "gpt-5.6-terra", effort: "medium" },
  verificationTier: { model: "gpt-5.6-sol", effort: "medium" },
  infrastructureProfile: { model: "gpt-5.6-terra", effort: "medium" },
  policy: DEFAULT_JEV_POLICY,
};

export interface UpstreamResult {
  status: number;
  contentType: string;
  /** The native response body, passed through unchanged. */
  body: ReadableStream<Uint8Array>;
}

export type Upstream = (request: ResponsesRequest) => Promise<UpstreamResult>;

export interface TelemetrySink {
  recordCall(record: CallRecord): void;
  recordTask(record: TaskRecord): void;
}

export class MemoryTelemetry implements TelemetrySink {
  readonly calls: CallRecord[] = [];
  readonly tasks: TaskRecord[] = [];
  recordCall(record: CallRecord): void {
    this.calls.push(record);
  }
  recordTask(record: TaskRecord): void {
    this.tasks.push(record);
  }
}

interface TaskEntry {
  state: TaskState;
  jevSkipped: boolean;
  callCounter: number;
  verifications: Array<"PASS" | "FAIL">;
}

export interface RouteCallInput {
  task_id: string;
  step_type: StepType;
  request: ResponsesRequest;
  current_model?: string;
  context_size_bucket?: RoutingState["context_size_bucket"];
  tool_facts?: ToolFacts;
  user_turn?: { request_text: string };
  /** Bounded text (tool-output tails, request prefixes): sensitive check only, never sent. */
  raw_hints?: string[];
  /** User hard constraint: an explicit forced-model request. */
  forced_model?: string;
  /** Explicit "must use GPT-6" mandate over its stated scope. */
  gpt6_mandate?: boolean;
  competing_authority?: boolean;
}

export interface RouteCallResult {
  /** The request to forward upstream: routed, or the host's original on bypass. */
  forwardRequest: ResponsesRequest;
  upstream: UpstreamResult;
  record: CallRecord;
  /** Resolves from the passthrough scan of response.completed; UNKNOWN fields otherwise. */
  observed: Promise<ObservedExecution>;
}

/**
 * The local Responses proxy pipeline. One Codex session, many routing
 * decisions; native streaming events forwarded unchanged.
 */
export class ResponsesProxy {
  readonly telemetry: MemoryTelemetry;
  #tasks = new Map<string, TaskEntry>();
  #versionDiscipline: VersionDisciplineState = { lastResolved: "UNKNOWN", demoted: false };

  constructor(
    readonly config: RouterConfig,
    readonly catalog: ModelCatalog,
    readonly transport: JevTransport,
    readonly upstream: Upstream,
    telemetry: MemoryTelemetry = new MemoryTelemetry(),
  ) {
    this.telemetry = telemetry;
  }

  taskState(taskId: string): TaskState {
    return structuredClone(this.#task(taskId).state);
  }

  #task(taskId: string): TaskEntry {
    let entry = this.#tasks.get(taskId);
    if (!entry) {
      entry = { state: newTask(taskId), jevSkipped: false, callCounter: 0, verifications: [] };
      this.#tasks.set(taskId, entry);
    }
    return entry;
  }

  async routeCall(input: RouteCallInput): Promise<RouteCallResult> {
    const entry = this.#task(input.task_id);
    const callIndex = entry.callCounter;
    entry.callCounter += 1;
    const task = entry.state;

    // A pending failure fact marks the next session call as a correction.
    const stepType = task.failure_facts && input.step_type === "user_turn" ? "correction" : input.step_type;
    const correctionFacts = stepType === "correction" ? task.failure_facts : undefined;

    // 1. Kill switch: bypass Jev, restore the host's originally specified model.
    if (this.config.routerOff) {
      return this.#dispatch(input, callIndex, stepType, correctionFacts, task, input.request, "bypass", "router_off", undefined, undefined, []);
    }
    // 2. Competing routing authority: stand down to the host's original request.
    if (input.competing_authority) {
      return this.#dispatch(input, callIndex, stepType, correctionFacts, task, input.request, "bypass", "competing_authority", undefined, undefined, []);
    }
    // 3. Explicitly forced-model calls bypass Jev entirely.
    if (input.forced_model) {
      const pair = { model: input.forced_model, effort: input.request.reasoning?.effort ?? "medium" };
      return this.#dispatch(input, callIndex, stepType, correctionFacts, task, applyRoute(input.request, pair).routed, "bypass", "forced_model", undefined, pair, []);
    }
    // 4. Infrastructure and verification calls are excluded from economic routing.
    if (stepType === "infrastructure") {
      return this.#dispatch(input, callIndex, stepType, correctionFacts, task, applyRoute(input.request, this.config.infrastructureProfile).routed, "bypass", "infrastructure", undefined, this.config.infrastructureProfile, []);
    }
    if (stepType === "verification") {
      return this.#dispatch(input, callIndex, stepType, correctionFacts, task, applyRoute(input.request, this.config.verificationTier).routed, "bypass", "verification_fixed", undefined, this.config.verificationTier, []);
    }
    // 5. Jev transport failure earlier in this task, or active-alias demotion: explicit baseline.
    if (entry.jevSkipped || (this.#versionDiscipline.demoted && this.config.mode === "active")) {
      return this.#baseline(input, callIndex, stepType, correctionFacts, task, "jev_skipped_for_task", "active", []);
    }

    // 6. Privacy check: no send eligibility means Jev is skipped for this call.
    const { state, privacy } = buildRoutingState({
      task_id: input.task_id,
      call_index: callIndex,
      step_type: stepType,
      current_model: input.current_model,
      context_size_bucket: input.context_size_bucket,
      tool_facts: input.tool_facts,
      user_turn: input.user_turn,
      correction_facts: correctionFacts,
      rawHints: input.raw_hints,
    });
    if (!privacy.hasSendEligibility) {
      return this.#baseline(input, callIndex, stepType, correctionFacts, task, "privacy_refusal", "bypass", []);
    }

    // 7. Validated candidate pairs under hard constraints.
    const constraints: CandidateConstraints = {};
    if (input.gpt6_mandate) {
      const gpt6 = this.catalog.models.find(m => m.tier === "gpt6" && m.requestable);
      if (gpt6) constraints.forcedModel = gpt6.model;
    }
    if (task.gpt6_eligibility || input.gpt6_mandate) constraints.gpt6Admitted = true;
    const candidateSet = buildCandidateSet(this.catalog, constraints);
    const eligiblePairIds = candidateSet.pairs.map(pair => pair.pair_id);

    // 8. One Jev Choice over the pairs.
    const decision = await choose(state, candidateSet, this.config.policy, this.transport);
    if (decision.jev_resolved_version !== UNKNOWN) {
      this.#versionDiscipline = trackResolvedVersion(this.#versionDiscipline, this.config.policy, decision.jev_resolved_version);
    }
    if (decision.failure_reason === "transport") entry.jevSkipped = true;

    let selected: CandidatePair | undefined;
    let fallbackReason: string | undefined =
      decision.failure_reason === "floor" ? "low_confidence" : decision.failure_reason;
    if (decision.valid && decision.chosen_pair_id !== undefined) {
      const verdict = validate(decision, candidateSet, constraints, false);
      if (verdict.verdict === "ALLOW") {
        selected = candidateSet.pairs.find(pair => pair.pair_id === verdict.pair_id);
        if (!selected) fallbackReason = "malformed";
      } else {
        fallbackReason = "guard_deny";
      }
    }

    const shadow = this.config.mode === "shadow";

    if (shadow || selected === undefined) {
      // Shadow executes the baseline and logs the would-be route; active
      // fallback uses the explicit baseline. Both are recorded, never silent.
      const baselinePair = resolveBaseline(this.catalog, this.config.baseline.model, this.config.baseline.effort);
      if (!baselinePair) {
        // Baseline unavailable: keep the host's original request, never a silent provider switch.
        return this.#dispatch(input, callIndex, stepType, correctionFacts, task, input.request, "bypass", "baseline_unavailable", decision, undefined, eligiblePairIds);
      }
      return await this.#dispatch(
        input, callIndex, stepType, correctionFacts, task,
        applyRoute(input.request, baselinePair).routed,
        shadow ? "shadow" : "active",
        shadow ? undefined : (fallbackReason ?? "fallback"),
        decision, baselinePair, eligiblePairIds,
      );
    }

    // 9. Active Jev selection executes; a used GPT-6 pair consumes the one-shot eligibility.
    const result = await this.#dispatch(
      input, callIndex, stepType, correctionFacts, task,
      applyRoute(input.request, selected).routed,
      "active", undefined, decision, selected, eligiblePairIds,
    );
    if (selected.tier === "gpt6" && task.gpt6_eligibility) {
      entry.state = consumeGpt6Eligibility(entry.state);
    }
    return result;
  }

  async #baseline(
    input: RouteCallInput,
    callIndex: number,
    stepType: StepType,
    correctionFacts: RoutingState["correction_facts"],
    task: TaskState,
    reason: string,
    mode: "active" | "bypass",
    eligiblePairIds: string[],
  ): Promise<RouteCallResult> {
    const baselinePair = resolveBaseline(this.catalog, this.config.baseline.model, this.config.baseline.effort);
    if (!baselinePair) {
      return this.#dispatch(input, callIndex, stepType, correctionFacts, task, input.request, "bypass", "baseline_unavailable", undefined, undefined, eligiblePairIds);
    }
    return this.#dispatch(
      input, callIndex, stepType, correctionFacts, task,
      applyRoute(input.request, baselinePair).routed,
      mode, reason, undefined, baselinePair, eligiblePairIds,
    );
  }

  async #dispatch(
    input: RouteCallInput,
    callIndex: number,
    stepType: StepType,
    correctionFacts: RoutingState["correction_facts"],
    task: TaskState,
    forwardRequest: ResponsesRequest,
    mode: "active" | "shadow" | "bypass",
    fallbackReason: string | undefined,
    decision: JevDecision | undefined,
    selectedPair: { model: string; effort: string } | undefined,
    eligiblePairIds: string[],
  ): Promise<RouteCallResult> {
    void correctionFacts;
    const applied: AppliedRoute = selectedPair
      ? applyRoute(input.request, selectedPair).applied
      : {
          original_model: input.request.model,
          routed_model: forwardRequest.model,
          routed_effort: forwardRequest.reasoning?.effort ?? UNKNOWN,
        };
    const started = Date.now();
    const upstreamResult = await this.upstream(forwardRequest);
    const { passthrough, observed } = teeAndObserve(applied, upstreamResult.body);
    // Await the scan: the tee keeps the passthrough branch independent, so
    // native bytes still flow unchanged to the caller.
    const observation = await observed;
    const record = buildCallRecord({
      task_id: input.task_id,
      call_index: callIndex,
      step_type: stepType,
      mode,
      decision,
      eligiblePairs: eligiblePairIds,
      selectedPair: selectedPair ?? { model: forwardRequest.model, effort: String(forwardRequest.reasoning?.effort ?? UNKNOWN) },
      route_source: mode === "bypass" ? "bypass" : decision && !fallbackReason ? "jev" : "fallback",
      fallback_reason: fallbackReason,
      gpt6_eligibility_reason: task.gpt6_eligibility?.reason_code,
      observed: observation,
      model_latency_ms: Date.now() - started,
      call_status: upstreamResult.status >= 400 ? "error" : "ok",
    });
    this.telemetry.recordCall(record);
    return { forwardRequest, upstream: { ...upstreamResult, body: passthrough }, record, observed };
  }

  /**
   * Task-boundary verification: outside the economic routing loop. Records
   * the task outcome and advances correction-cycle state.
   */
  verifyTask(taskId: string, evidence: VerificationEvidence): TaskRecord {
    const entry = this.#task(taskId);
    const result = verifyTask(evidence);
    const firstPass = entry.verifications.length === 0 && result.verification === "PASS";
    entry.verifications.push(result.verification);
    entry.state = recordVerification(entry.state, result);
    if (result.verification === "PASS") {
      // A resolved blocker clears any pending one-shot GPT-6 eligibility.
      entry.state = consumeGpt6Eligibility(entry.state);
    }
    const record: TaskRecord = {
      task_id: taskId,
      verification: result.verification,
      evidence_refs: result.evidence_refs,
      first_pass: firstPass,
      correction_cycles: entry.state.correction_cycles,
      root_takeover: entry.state.status === "taken_over",
      critical_failure: entry.state.status === "taken_over",
    };
    this.telemetry.recordTask(record);
    return record;
  }

  /** Open the one-shot GPT-6 eligibility from verified reasoning-blocker evidence. */
  openGpt6(taskId: string, reasonCode: string, evidenceRef: string): void {
    const entry = this.#task(taskId);
    entry.state = openGpt6Eligibility(entry.state, reasonCode, evidenceRef);
  }
}

/**
 * Tee the upstream body: one branch passes through unchanged (native
 * streaming fidelity), the other scans for response.completed to observe
 * actual model/effort/usage. The scan never mutates bytes.
 */
export function teeAndObserve(
  applied: AppliedRoute,
  body: ReadableStream<Uint8Array>,
): { passthrough: ReadableStream<Uint8Array>; observed: Promise<ObservedExecution> } {
  const [passthrough, scan] = body.tee();
  const observed = (async (): Promise<ObservedExecution> => {
    const reader = scan.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const completed = extractCompletedEvent(text);
    return completed ? observeFromCompletedEvent(applied, completed) : {
      actual_model: UNKNOWN,
      actual_effort: UNKNOWN,
      observation: "unobservable",
      usage: unknownUsage(),
    };
  })();
  return { passthrough, observed };
}

function extractCompletedEvent(text: string): { response?: { model?: string; reasoning?: { effort?: string }; usage?: Record<string, number> } } | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { type?: string; response?: unknown };
      if (parsed.type === "response.completed" && parsed.response && typeof parsed.response === "object") {
        return parsed as { response?: { model?: string; reasoning?: { effort?: string }; usage?: Record<string, number> } };
      }
    } catch {
      // Non-JSON data lines are ignored; bytes still pass through untouched.
    }
  }
  return undefined;
}
