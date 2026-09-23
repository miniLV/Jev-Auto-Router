import { createHash } from "node:crypto";
import {
  buildCandidateSet,
  resolveBaseline,
  currentlyProvedEfforts,
  type CandidateConstraints,
  type CandidatePair,
  type ModelEffortPair,
  type ModelCatalog,
} from "./catalog.js";
import {
  applyRoute,
  observeFromCompletedEvent,
  type AppliedRoute,
  type ObservedExecution,
  type ResponsesRequest,
  type RouteObservation,
} from "./execution-contract.js";
import { choose, isAbortError, isPinnedJevVersion, type JevDecision, type JevPolicy, type JevTransport } from "./jev-adapter.js";
import type { GuardReason } from "./policy-guard.js";
import { validate } from "./policy-guard.js";
import { buildCallRecord, type CallRecord, type TaskRecord } from "./receipt.js";
import { buildRoutingState, factsSufficientForChoice, isBoundedModelId, type RoutingState } from "./route-plan.js";
import { AUTO_MODEL, parseStepType, UNKNOWN, unknownUsage, type CallStatus, type EntryKind, type Mode, type RouteReason, type RouteSource, type StepType } from "./types.js";
import {
  consumeAstraEligibility,
  newTask,
  openAstraEligibility,
  recordVerification,
  verifyTask,
  type TaskState,
  type VerificationEvidence,
} from "./verification.js";

export interface RouterConfig {
  routerOff: boolean;
  mode: "active" | "shadow";
  /** One caller-edge-proved Fallback Baseline pair. Required, never defaulted. */
  baseline: { model: string; effort: string };
  /** Exact pair scope; Active requires it, and Shadow uses it when supplied. */
  activeCandidates: ModelEffortPair[];
  policy: JevPolicy;
}

export interface UpstreamResult {
  status: number;
  contentType: string;
  /** Relevant upstream headers, relayed to the client unchanged. */
  headers: Record<string, string>;
  /** The native response body, passed through unchanged. */
  body: ReadableStream<Uint8Array>;
}

export type Upstream = (request: ResponsesRequest, signal?: AbortSignal) => Promise<UpstreamResult>;

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
  callCounter: number;
  verifications: Array<"PASS" | "FAIL">;
}

export interface RouteCallInput {
  task_id: string;
  step_type: StepType;
  request: ResponsesRequest;
  current_model?: string;
  context_size_bucket?: RoutingState["context_size_bucket"];
  user_turn?: { request_text: string };
  /** Bounded user text: sensitive check only, never sent. */
  raw_hints?: string[];
  /** User hard constraint: restrict candidates to one model (not an entry bypass). */
  forced_model?: string;
  /** Explicit "must use Astra" mandate over its stated scope. */
  astra_mandate?: boolean;
  competing_authority?: boolean;
  /** Client cancellation: aborts the Jev wait or the upstream request, never falls back. */
  signal?: AbortSignal;
}

export interface RouteCallResult {
  /** The request to forward upstream: routed, or the caller's original on bypass. */
  forwardRequest: ResponsesRequest;
  upstream: UpstreamResult;
  /**
   * The per-call record. Observed fields start UNKNOWN and are filled when
   * the response scan settles; the telemetry sink receives the same object
   * after that, so records never block or mutate the native stream.
   */
  record: CallRecord;
  /** Resolves from the passthrough scan of the upstream terminal outcome. */
  observed: Promise<ObservedExecution & { terminated: "completed" | "aborted" | "failed" }>;
}

function validatedForcedModel(
  catalog: ModelCatalog,
  value: unknown,
  allowedPairs: ModelEffortPair[],
  astraAdmitted: boolean,
  now: number,
): string | undefined {
  if (!isBoundedModelId(value)) return undefined;
  const model = catalog.models.find(info => info.model === value && currentlyProvedEfforts(info, now).length > 0);
  if (!model || (model.tier === "astra" && !astraAdmitted)) return undefined;
  const hasAllowedEffort = currentlyProvedEfforts(model, now).some(effort =>
    allowedPairs.length === 0 || allowedPairs.some(pair => pair.model === value && pair.effort === effort),
  );
  return hasAllowedEffort ? value : undefined;
}

/** The configured Fallback Baseline is not requestable: fail before output (spec §3). */
export class BaselineUnavailableError extends Error {
  constructor(readonly baseline: { model: string; effort: string }) {
    super(`baseline_unavailable: ${baseline.model}/${baseline.effort} is not requestable through the current caller edge`);
  }
}

/** The client cancelled the call; no fallback request was made. */
export class CallCancelledError extends Error {
  constructor() {
    super("call cancelled by client");
  }
}

interface DispatchPlan {
  input: RouteCallInput;
  callIndex: number;
  stepType: StepType;
  task: TaskState;
  entry: EntryKind;
  forwardRequest: ResponsesRequest;
  appliedPair: { model: string; effort: string };
  mode: Mode;
  routeSource: RouteSource;
  reason?: RouteReason;
  decision?: JevDecision;
  proposedPair?: { model: string; effort: string };
  guardVerdict?: "allow" | "deny";
  guardReason?: GuardReason;
  eligiblePairIds: string[];
}

/**
 * The local Responses router pipeline. Entry is by requested model: only
 * `jev/auto` routes through Jev; real models forward unchanged. Native
 * streaming events pass through untouched; observation stays off the
 * response path.
 */
export class ResponsesProxy {
  readonly telemetry: MemoryTelemetry;
  #tasks = new Map<string, TaskEntry>();
  #now: () => number;

  constructor(
    readonly config: RouterConfig,
    readonly catalog: ModelCatalog,
    readonly transport: JevTransport,
    readonly upstream: Upstream,
    telemetry: MemoryTelemetry = new MemoryTelemetry(),
    now: () => number = Date.now,
  ) {
    this.telemetry = telemetry;
    this.#now = now;
  }

  taskState(taskId: string): TaskState {
    return structuredClone(this.#task(taskId).state);
  }

  #task(taskId: string): TaskEntry {
    let entry = this.#tasks.get(taskId);
    if (!entry) {
      entry = { state: newTask(taskId), callCounter: 0, verifications: [] };
      this.#tasks.set(taskId, entry);
    }
    return entry;
  }

  /** Entry boundary (routing-policy §1): route by requested model identifier only. */
  #entryKind(model: string): EntryKind {
    if (model === AUTO_MODEL) return "auto";
    const known = this.catalog.models.some(info => info.model === model);
    return known ? "manual" : "out_of_policy";
  }

  async routeCall(input: RouteCallInput): Promise<RouteCallResult> {
    const entry = this.#task(input.task_id);
    const callIndex = entry.callCounter;
    entry.callCounter += 1;
    const task = entry.state;

    // A pending failure fact marks the next session call as a correction.
    const requestedStepType = parseStepType(input.step_type);
    const stepType = task.failure_facts && requestedStepType === "user_turn" ? "correction" : requestedStepType;

    // 1. Entry boundary: only jev/auto enters routing. Real (or unknown)
    //    models forward through the normal path, unchanged, without Jev.
    const entryKind = this.#entryKind(input.request.model);
    if (entryKind !== "auto") {
      return this.#dispatch({
        input, callIndex, stepType, task, entry: entryKind,
        forwardRequest: input.request,
        appliedPair: { model: input.request.model, effort: String(input.request.reasoning?.effort ?? UNKNOWN) },
        mode: "bypass",
        routeSource: "bypass",
        reason: entryKind === "manual" ? "manual_model" : "out_of_policy_entry",
        eligiblePairIds: [],
      });
    }

    // An automatic call is only admitted while its configured fallback is
    // still proved. Check before any Jev Choice as well as at dispatch time.
    this.#requireBaseline(this.#now());

    // 2. Pre-admission fallbacks: one baseline, distinct reasons.
    if (this.config.routerOff) {
      return this.#baseline(input, callIndex, stepType, task, "router_off");
    }
    if (stepType === "infrastructure") {
      return this.#baseline(input, callIndex, stepType, task, "infrastructure");
    }
    if (input.competing_authority === true) {
      return this.#baseline(input, callIndex, stepType, task, "competing_authority");
    }
    // An unpinned Jev version is not Active-eligible (spec §5).
    if (this.config.mode === "active" && !isPinnedJevVersion(this.config.policy.jevVersion)) {
      return this.#baseline(input, callIndex, stepType, task, "jev_version_mismatch");
    }

    // 3. Routing State: privacy and sufficiency gates happen before any Jev call.
    const { state, privacy } = buildRoutingState({
      step_type: stepType,
      known_model_ids: this.catalog.models.map(model => model.model),
      current_model: input.current_model,
      context_size_bucket: input.context_size_bucket,
      user_turn: input.user_turn,
      rawHints: input.raw_hints,
    });
    if (!privacy.hasSendEligibility) {
      return this.#baseline(input, callIndex, stepType, task, "privacy_refusal");
    }
    if (!factsSufficientForChoice(state)) {
      return this.#baseline(input, callIndex, stepType, task, "insufficient_routing_facts");
    }

    // 4. Candidate Pairs under hard constraints.
    const constraints: CandidateConstraints = {};
    if (this.config.activeCandidates.length > 0) constraints.allowedPairs = this.config.activeCandidates;
    const now = this.#now();
    const astraMandate = input.astra_mandate === true;
    const forcedModel = validatedForcedModel(
      this.catalog,
      input.forced_model,
      this.config.activeCandidates,
      task.astra_eligibility !== undefined || astraMandate,
      now,
    );
    if (forcedModel) constraints.forcedModel = forcedModel;
    if (astraMandate) {
      const astra = this.catalog.models.find(m => m.tier === "astra" && currentlyProvedEfforts(m, now).length > 0);
      if (astra) constraints.forcedModel = astra.model;
    }
    if (task.astra_eligibility || astraMandate) constraints.astraAdmitted = true;
    const candidateSet = buildCandidateSet(this.catalog, constraints, now);
    const eligiblePairIds = candidateSet.pairs.map(pair => pair.pair_id);

    // 5. One pinned-version Jev Choice with a deadline. Cancellation
    //    propagates; it never converts into a fallback request.
    let decision: JevDecision;
    try {
      decision = await choose(state, candidateSet, this.config.policy, this.transport, input.signal);
    } catch (error) {
      if (isAbortError(error)) {
        // Cancelled while waiting for Jev: no request was applied or sent.
        this.telemetry.recordCall(buildCallRecord({
          task_id: input.task_id, call_index: callIndex, step_type: stepType, entry: "auto",
          mode: this.config.mode, route_source: "fallback",
          jevConfidenceFloor: this.config.policy.confidenceFloor,
          jevDeadlineMs: this.config.policy.deadlineMs,
          eligiblePairs: eligiblePairIds,
          originalModel: input.request.model, model_latency_ms: 0, call_status: "cancelled",
        }));
        throw new CallCancelledError();
      }
      throw error;
    }
    const proposedPair = decision.chosen_pair_id !== undefined
      ? candidateSet.pairs.find(pair => pair.pair_id === decision.chosen_pair_id)
      : undefined;
    const postChoiceNow = this.#now();
    this.#requireBaseline(postChoiceNow);

    // 6. Guard: deterministic validation of the single answer.
    const verdict = validate(decision, candidateSet, constraints, false);
    let guardVerdict = verdict.verdict === "ALLOW" ? "allow" as const : "deny" as const;
    let guardReason = verdict.verdict === "DENY" ? verdict.reason : undefined;
    let selected: CandidatePair | undefined;
    if (verdict.verdict === "ALLOW") {
      selected = candidateSet.pairs.find(pair => pair.pair_id === verdict.pair_id);
    }
    if (selected && !resolveBaseline(this.catalog, selected.model, selected.effort, postChoiceNow)) {
      selected = undefined;
      guardVerdict = "deny";
      guardReason = "PAIR_UNAVAILABLE";
    }

    // 7. Mode decides execution: shadow always runs the baseline; active
    //    applies the accepted pair or falls back with the exact reason.
    const shadow = this.config.mode === "shadow";
    if (shadow || selected === undefined) {
      const reason: RouteReason = shadow ? "shadow_mode" : fallbackReasonOf(decision, guardReason);
      return this.#baseline(input, callIndex, stepType, task, reason, {
        decision, proposedPair, guardVerdict, guardReason, eligiblePairIds,
      });
    }

    // 8. Active apply; a used Astra pair consumes the one-shot eligibility.
    const dispatchNow = this.#now();
    this.#requireBaseline(dispatchNow);
    if (!resolveBaseline(this.catalog, selected.model, selected.effort, dispatchNow)) {
      return this.#baseline(input, callIndex, stepType, task, "invalid_choice", {
        decision, proposedPair, guardVerdict: "deny", guardReason: "PAIR_UNAVAILABLE", eligiblePairIds,
      });
    }
    const result = await this.#dispatch({
      input, callIndex, stepType, task, entry: "auto",
      forwardRequest: applyRoute(input.request, selected).routed,
      appliedPair: selected,
      mode: "active",
      routeSource: "jev",
      decision, proposedPair, guardVerdict, guardReason, eligiblePairIds,
    });
    if (selected.tier === "astra" && task.astra_eligibility) {
      entry.state = consumeAstraEligibility(entry.state);
    }
    return result;
  }

  /** Every fallback path executes the same proved baseline with its own reason. */
  #baseline(
    input: RouteCallInput,
    callIndex: number,
    stepType: StepType,
    task: TaskState,
    reason: RouteReason,
    extras: {
      decision?: JevDecision;
      proposedPair?: { model: string; effort: string };
      guardVerdict?: "allow" | "deny";
      guardReason?: GuardReason;
      eligiblePairIds?: string[];
    } = {},
  ): Promise<RouteCallResult> {
    const baselinePair = this.#requireBaseline(this.#now());
    return this.#dispatch({
      input, callIndex, stepType, task, entry: "auto",
      forwardRequest: applyRoute(input.request, baselinePair).routed,
      appliedPair: baselinePair,
      mode: this.config.mode,
      routeSource: "fallback",
      reason,
      decision: extras.decision,
      proposedPair: extras.proposedPair,
      guardVerdict: extras.guardVerdict,
      guardReason: extras.guardReason,
      eligiblePairIds: extras.eligiblePairIds ?? [],
    });
  }

  #requireBaseline(now: number): CandidatePair {
    const baselinePair = resolveBaseline(this.catalog, this.config.baseline.model, this.config.baseline.effort, now);
    if (!baselinePair) {
      // Fail explicitly before any output; never restore the virtual request
      // and never pick an unproved pair (spec §3).
      throw new BaselineUnavailableError(this.config.baseline);
    }
    return baselinePair;
  }

  async #dispatch(plan: DispatchPlan): Promise<RouteCallResult> {
    // Non-recursive caller edge: an automatic request always names a real model.
    if (plan.entry === "auto" && plan.forwardRequest.model === AUTO_MODEL) {
      throw new Error("non_recursive_violation: forwarded automatic request still names jev/auto");
    }
    const applied: AppliedRoute = {
      original_model: plan.input.request.model,
      routed_model: plan.forwardRequest.model,
      routed_effort: plan.forwardRequest.reasoning?.effort ?? UNKNOWN,
    };
    const started = Date.now();
    let upstreamResult: UpstreamResult;
    try {
      upstreamResult = await this.upstream(plan.forwardRequest, plan.input.signal);
    } catch (error) {
      // Failure before any output: record, then surface. Cancellation is
      // recorded as cancelled, never as a fallback completion.
      const cancelled = plan.input.signal?.aborted === true || isAbortError(error);
      this.telemetry.recordCall(buildCallRecord({
        task_id: plan.input.task_id,
        call_index: plan.callIndex,
        step_type: plan.stepType,
        entry: plan.entry,
        mode: plan.mode,
        jevConfidenceFloor: this.config.policy.confidenceFloor,
        jevDeadlineMs: this.config.policy.deadlineMs,
        route_source: plan.routeSource,
        reason: plan.reason,
        decision: plan.decision,
        proposedPair: plan.proposedPair,
        guardVerdict: plan.guardVerdict,
        guardReason: plan.guardReason,
        eligiblePairs: plan.eligiblePairIds,
        appliedPair: plan.appliedPair,
        originalModel: plan.input.request.model,
        upstream_started_at: new Date(started).toISOString(),
        request_tool_result_refs: toolResultRefs(plan.input.request),
        astra_eligibility_reason: plan.task.astra_eligibility?.reason_code,
        model_latency_ms: Date.now() - started,
        call_status: cancelled ? "cancelled" : "error",
      }));
      if (cancelled) throw new CallCancelledError();
      throw error;
    }
    const { passthrough, observed } = teeAndObserve(
      applied,
      upstreamResult.body,
      plan.input.signal,
      started,
      upstreamResult.contentType,
    );
    const record = buildCallRecord({
      task_id: plan.input.task_id,
      call_index: plan.callIndex,
      step_type: plan.stepType,
      entry: plan.entry,
      mode: plan.mode,
      jevConfidenceFloor: this.config.policy.confidenceFloor,
      jevDeadlineMs: this.config.policy.deadlineMs,
      route_source: plan.routeSource,
      reason: plan.reason,
      decision: plan.decision,
      proposedPair: plan.proposedPair,
      guardVerdict: plan.guardVerdict,
      guardReason: plan.guardReason,
      eligiblePairs: plan.eligiblePairIds,
      appliedPair: plan.appliedPair,
      originalModel: plan.input.request.model,
      upstream_http_status: upstreamResult.status,
      upstream_started_at: new Date(started).toISOString(),
      request_tool_result_refs: toolResultRefs(plan.input.request),
      astra_eligibility_reason: plan.task.astra_eligibility?.reason_code,
      model_latency_ms: Date.now() - started,
      call_status: upstreamResult.status >= 400 ? "error" : "ok",
    });
    // Observation is off the response path: the record fills in when the
    // scan settles and only then reaches telemetry. Bytes never wait.
    void observed.then(obs => {
      record.observed_model = obs.actual_model;
      record.observed_effort = obs.actual_effort;
      record.observation = obs.observation;
      record.model_input_tokens = obs.usage.input_tokens;
      record.model_cached_tokens = obs.usage.cached_input_tokens;
      record.model_cache_write_tokens = obs.usage.cache_write_input_tokens;
      record.model_output_tokens = obs.usage.output_tokens;
      record.model_reasoning_tokens = obs.usage.reasoning_tokens;
      record.first_output_delta_at = obs.first_output_delta_at;
      record.time_to_first_output_delta_ms = obs.time_to_first_output_delta_ms;
      record.response_completed_at = obs.response_completed_at;
      record.upstream_completion_ms = obs.upstream_completion_ms;
      record.response_tool_call_refs = obs.response_tool_call_refs;
      record.model_latency_ms = Date.now() - started;
      if (obs.terminated === "aborted") record.call_status = "cancelled";
      else if (obs.terminated === "failed") record.call_status = "error";
      this.telemetry.recordCall(record);
    });
    return { forwardRequest: plan.forwardRequest, upstream: { ...upstreamResult, body: passthrough }, record, observed };
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
      // A resolved blocker clears any pending one-shot Astra eligibility.
      entry.state = consumeAstraEligibility(entry.state);
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

  /** Open the one-shot Astra eligibility from verified reasoning-blocker evidence. */
  openAstra(taskId: string, reasonCode: string, evidenceRef: string): void {
    const entry = this.#task(taskId);
    entry.state = openAstraEligibility(entry.state, reasonCode, evidenceRef);
  }
}

/** Map an unacceptable Jev outcome to its exact policy reason. */
function fallbackReasonOf(decision: JevDecision, guardReason?: GuardReason): RouteReason {
  if (guardReason === "VERSION_DRIFT") return "jev_version_mismatch";
  if (decision.valid && guardReason) return "guard_deny";
  switch (decision.failure_reason) {
    case "timeout":
      return "jev_timeout";
    case "transport":
      return "jev_failure";
    case "floor":
      return "low_confidence";
    case "malformed":
      return decision.failure_subreason === "version_drift" ? "jev_version_mismatch" : "invalid_choice";
    default:
      return "invalid_choice";
  }
}

/**
 * Tee the upstream body: one branch passes through unchanged (native
 * streaming fidelity), the other scans terminal events and response.completed
 * to observe actual model/effort/usage. The scan never mutates bytes and
 * never delays the passthrough branch.
 */
export function teeAndObserve(
  applied: AppliedRoute,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  startedAt = Date.now(),
  contentType = "text/event-stream",
): { passthrough: ReadableStream<Uint8Array>; observed: Promise<StreamObservation> } {
  const [passthrough, scan] = body.tee();
  const observed = (async (): Promise<StreamObservation> => {
    const reader = scan.getReader();
    const decoder = new TextDecoder();
    const isSse = contentType.toLowerCase().includes("text/event-stream");
    let jsonBody = "";
    let lineBuffer = "";
    let dataLines: string[] = [];
    let completedEvent: Parameters<typeof observeFromCompletedEvent>[1] | undefined;
    let explicitFailureSeen = false;
    let explicitCompletionSeen = false;
    let firstOutputDeltaAt: string | typeof UNKNOWN = UNKNOWN;
    let timeToFirstOutputDeltaMs: number | typeof UNKNOWN = UNKNOWN;
    let responseCompletedAt: string | typeof UNKNOWN = UNKNOWN;
    let upstreamCompletionMs: number | typeof UNKNOWN = UNKNOWN;
    const responseToolCallRefs = new Set<string>();
    const observeEvent = (event: Record<string, unknown>): void => {
      if (firstOutputDeltaAt === UNKNOWN && typeof event.type === "string" && event.type.startsWith("response.") && event.type.endsWith(".delta")) {
        firstOutputDeltaAt = new Date().toISOString();
        timeToFirstOutputDeltaMs = Date.now() - startedAt;
      }
      for (const ref of toolCallRefs(event)) responseToolCallRefs.add(ref);
      const response = event.response && typeof event.response === "object" && !Array.isArray(event.response)
        ? event.response as Record<string, unknown>
        : undefined;
      const statuses = [event.status, response?.status].filter(status => status !== undefined);
      const explicitFailure = event.type === "response.failed" || event.type === "response.incomplete"
        || statuses.some(status => status === "failed" || status === "incomplete");
      if (explicitFailure) explicitFailureSeen = true;
      const completedStatusConflict = event.type === "response.completed"
        && statuses.some(status => status !== "completed");
      if (event.type === "response.completed" && !completedStatusConflict) {
        explicitCompletionSeen = true;
        completedEvent = event as Parameters<typeof observeFromCompletedEvent>[1];
        responseCompletedAt = new Date().toISOString();
        upstreamCompletionMs = Date.now() - startedAt;
      }
    };
    const consumeSseLine = (line: string): void => {
      if (line === "") {
        const payload = dataLines.join("\n");
        dataLines = [];
        if (!payload || payload === "[DONE]") return;
        try {
          const event = JSON.parse(payload) as unknown;
          if (event && typeof event === "object" && !Array.isArray(event)) observeEvent(event as Record<string, unknown>);
        } catch {
          // Non-JSON data lines stay opaque; the passthrough branch is untouched.
        }
        return;
      }
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (isSse) {
            lineBuffer += decoder.decode();
            if (lineBuffer) consumeSseLine(lineBuffer.replace(/\r$/, ""));
            if (dataLines.length > 0) consumeSseLine("");
          } else {
            jsonBody += decoder.decode();
            try {
              const payload = JSON.parse(jsonBody) as unknown;
              if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                const response = payload as Record<string, unknown>;
                for (const ref of toolCallRefs(response)) responseToolCallRefs.add(ref);
                if (responseCompletedAt === UNKNOWN) {
                  responseCompletedAt = new Date().toISOString();
                  upstreamCompletionMs = Date.now() - startedAt;
                }
              }
            } catch {
              // Non-JSON bodies remain unobservable.
            }
          }
          break;
        }
        const decoded = decoder.decode(value, { stream: true });
        if (!isSse) {
          jsonBody += decoded;
          continue;
        }
        lineBuffer += decoded;
        let newline: number;
        while ((newline = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(newline + 1);
          consumeSseLine(line);
        }
      }
    } catch {
      // A client abort and an upstream failure are different outcomes even
      // though neither provides an authoritative completed response.
      const terminated = signal?.aborted ? "aborted" : "failed";
      return {
        actual_model: UNKNOWN,
        actual_effort: UNKNOWN,
        observation: "unobservable",
        usage: unknownUsage(),
        terminated,
        first_output_delta_at: firstOutputDeltaAt,
        time_to_first_output_delta_ms: timeToFirstOutputDeltaMs,
        response_completed_at: UNKNOWN,
        upstream_completion_ms: UNKNOWN,
        response_tool_call_refs: [...responseToolCallRefs],
      };
    } finally {
      reader.releaseLock();
    }
    const completed = completedEvent ?? (isSse ? undefined : extractJsonCompletedEvent(jsonBody));
    const execution: ObservedExecution = completed
      ? observeFromCompletedEvent(applied, completed)
      : { actual_model: UNKNOWN, actual_effort: UNKNOWN, observation: "unobservable", usage: unknownUsage() };
    const terminated = signal?.aborted
      ? "aborted"
      : explicitFailureSeen || (isSse && !explicitCompletionSeen)
        ? "failed"
        : "completed";
    return {
      ...execution,
      terminated,
      first_output_delta_at: firstOutputDeltaAt,
      time_to_first_output_delta_ms: timeToFirstOutputDeltaMs,
      response_completed_at: terminated === "completed" ? responseCompletedAt : UNKNOWN,
      upstream_completion_ms: terminated === "completed" ? upstreamCompletionMs : UNKNOWN,
      response_tool_call_refs: [...responseToolCallRefs],
    };
  })();
  return { passthrough, observed };
}

interface StreamObservation extends ObservedExecution {
  terminated: "completed" | "aborted" | "failed";
  first_output_delta_at: string | typeof UNKNOWN;
  time_to_first_output_delta_ms: number | typeof UNKNOWN;
  response_completed_at: string | typeof UNKNOWN;
  upstream_completion_ms: number | typeof UNKNOWN;
  response_tool_call_refs: string[];
}

function toolResultRefs(request: ResponsesRequest): string[] {
  if (!Array.isArray(request.input)) return [];
  const refs = new Set<string>();
  for (const item of request.input) {
    if (!item || typeof item !== "object") continue;
    const value = item as { type?: unknown; call_id?: unknown };
    if (value.type === "function_call_output" && typeof value.call_id === "string") refs.add(hashToolRef(value.call_id));
  }
  return [...refs];
}

function toolCallRefs(value: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const add = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    const call = item as { type?: unknown; call_id?: unknown };
    if (call.type === "function_call" && typeof call.call_id === "string") refs.add(hashToolRef(call.call_id));
  };
  if (Array.isArray(value.output)) for (const item of value.output) add(item);
  add(value.item);
  add(value.output_item);
  if (value.response && typeof value.response === "object" && !Array.isArray(value.response)) {
    const response = value.response as Record<string, unknown>;
    if (Array.isArray(response.output)) for (const item of response.output) add(item);
  }
  return [...refs];
}

function hashToolRef(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function extractJsonCompletedEvent(text: string): { response?: { model?: string; reasoning?: { effort?: string }; usage?: Record<string, number> } } | undefined {
  // Non-streaming JSON responses report the authoritative model at the top level.
  try {
    const parsed = JSON.parse(text) as { model?: unknown };
    if (typeof parsed.model === "string") return { response: parsed as { model?: string; reasoning?: { effort?: string }; usage?: Record<string, number> } };
  } catch {
    // Not a JSON body: stays unobservable.
  }
  return undefined;
}

export type { CallStatus, RouteObservation };
