import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  configFromEnv,
  createProductionProxy,
  createRouterServer,
  fetchJevTransport,
  fetchModelList,
  parseActiveCandidates,
  parseBaseline,
  type EntryConfig,
} from "../src/index.js";
import { deriveCandidateCatalogId, resolveBaseline, type ModelCatalog } from "../src/catalog.js";
import { digest } from "../src/canonical.js";
import { ModelDiscovery, parsePairProofManifest } from "../src/discovery.js";
import { looksSensitive, QUESTION_SCHEMA_VERSION } from "../src/route-plan.js";
import { POLICY_VERSION } from "../src/receipt.js";
import { isPinnedJevVersion, isValidJevPolicyParameters, type JevPolicyParameters } from "../src/jev-adapter.js";
import type { EvaluationPlan } from "./paired-evaluation.js";
import type { HarnessConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const FORMAT = "jev-controlled-active-evaluation/1";
const CLASSIFICATION = "EVALUATION_ONLY" as const;

/** Frozen input to the separate local Active evidence collector. */
export interface ControlledActivePlan {
  format: typeof FORMAT;
  classification: typeof CLASSIFICATION;
  config: HarnessConfig;
  plan: EvaluationPlan;
  bindings: {
    upstreamTargetDigest: string;
    jevEndpointTargetDigest: string;
    discoveryDigest: string;
    proofManifestId: string;
    proofManifestDigest: string;
  };
}

export interface ControlledActiveDependencies {
  cwd?: string;
  now?: () => number;
  currentRevision?: (cwd: string) => Promise<string>;
  worktreeClean?: (cwd: string) => Promise<boolean>;
}

export interface ControlledActiveRun {
  config: EntryConfig;
  manifestPath: string;
  server: ReturnType<typeof createRouterServer>;
  stop(): Promise<void>;
}

interface RunManifest {
  format: "jev-evaluation-run/1";
  classification: typeof CLASSIFICATION;
  run_id: string;
  status: "STARTING" | "LISTENING" | "STOPPED" | "START_FAILED" | "STOP_FAILED";
  started_at: string;
  ended_at?: string;
  process: { pid: number; node_version: string; package_version: string; repository_revision: string };
  plan: {
    sha256: string;
    release: string;
    frozen_at: string;
    repository_revision: string;
    repository_snapshot_digest: string;
  };
  runtime: {
    release: string;
    mode: "active";
    baseline: HarnessConfig["baseline"];
    candidates: HarnessConfig["candidates"];
    callerEdgeId: string;
    candidateCatalogId: string;
    jevVersion: string;
    policyVersion: string;
    questionSchemaVersion: string;
    runtimePolicy: JevPolicyParameters;
    discoveryDigest: string;
    proofManifestId: string;
    proofManifestDigest: string;
  };
  evidence_output_location: string;
  artifacts: { manifest: string; observations: string };
}

/**
 * Start a local Active evaluation only after its complete frozen binding and
 * Issue 10 pair-proof catalog have passed. The production main() path is not
 * involved and remains behind its paired-report gate.
 */
export async function startControlledActiveEvaluation(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ControlledActiveDependencies = {},
): Promise<ControlledActiveRun> {
  const now = dependencies.now ?? Date.now;
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const supplied = requireEvaluationEnvironment(env);
  const checkoutRoot = await realpath(cwd);
  const outputRoot = await resolveWithExistingAncestor(supplied.outputDirectory);
  const outputRelativeToCheckout = relative(checkoutRoot, outputRoot);
  if (outputRelativeToCheckout === "" || (!isAbsolute(outputRelativeToCheckout) && outputRelativeToCheckout !== ".." &&
      !outputRelativeToCheckout.startsWith(`..${sep}`))) {
    throw new Error("controlled evaluation output must be outside the source checkout");
  }
  const planBytes = await readRequiredFile(supplied.planFile, "controlled evaluation plan");
  const plan = parseControlledPlan(planBytes.toString("utf8"));
  const revision = await (dependencies.currentRevision ?? gitRevision)(cwd);
  if (plan.plan.repository_revision !== revision) {
    throw new Error("frozen evaluation plan repository revision does not match this checkout");
  }
  if (!(await (dependencies.worktreeClean ?? gitWorktreeClean)(cwd))) {
    throw new Error("controlled Active evaluation requires a clean source worktree");
  }

  const config = runtimeConfig(env, plan, now());
  const proofBytes = await readRequiredFile(supplied.proofFile, "caller-edge pair proof manifest");
  const proofManifest = parsePairProofManifest(parseJson(proofBytes.toString("utf8"), "caller-edge pair proof manifest"));
  if (proofManifest.caller_edge_id !== config.callerEdgeId) {
    throw new Error("pair proof manifest caller-edge ID does not match the frozen plan");
  }
  if (proofManifest.id !== plan.bindings.proofManifestId || digest(proofManifest) !== plan.bindings.proofManifestDigest) {
    throw new Error("caller-edge pair proof manifest does not match the frozen plan binding");
  }
  const frozenCatalogId = validateFrozenCatalogBinding(plan, config, now());
  await checkLoopbackPort(config.port);

  let catalog;
  try {
    catalog = await new ModelDiscovery().discover(
      "controlled-active",
      () => fetchModelList(config.upstreamBaseUrl),
      proofManifest,
      config.callerEdgeId,
      now(),
    );
  } catch {
    throw new Error("caller-edge catalog and pair-proof validation failed");
  }
  const candidateCatalogId = validateCatalogBinding(plan, config, catalog, frozenCatalogId, now());

  const runId = randomUUID();
  const runDirectory = resolve(outputRoot, runId);
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("unable to create the controlled evaluation output directory");
  }
  const manifestPath = resolve(runDirectory, "manifest.json");
  const observationsPath = resolve(runDirectory, "observations.json");
  const packageVersion = await readPackageVersion(cwd);
  const manifest: RunManifest = {
    format: "jev-evaluation-run/1",
    classification: CLASSIFICATION,
    run_id: runId,
    status: "STARTING",
    started_at: new Date(now()).toISOString(),
    process: { pid: process.pid, node_version: process.version, package_version: packageVersion, repository_revision: revision },
    plan: {
      sha256: sha256(planBytes),
      release: plan.config.release,
      frozen_at: plan.plan.frozen_at,
      repository_revision: plan.plan.repository_revision,
      repository_snapshot_digest: plan.plan.repository_snapshot_digest,
    },
    runtime: {
      release: config.releaseId,
      mode: "active",
      baseline: plan.config.baseline,
      candidates: plan.config.candidates,
      callerEdgeId: config.callerEdgeId,
      candidateCatalogId,
      jevVersion: config.policy.jevVersion,
      policyVersion: POLICY_VERSION,
      questionSchemaVersion: QUESTION_SCHEMA_VERSION,
      runtimePolicy: plan.config.runtimePolicy,
      discoveryDigest: catalog.discoveryDigest,
      proofManifestId: catalog.proofManifestId,
      proofManifestDigest: catalog.proofManifestDigest,
    },
    evidence_output_location: runId,
    artifacts: { manifest: "manifest.json", observations: "observations.json" },
  };
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("unable to write the controlled evaluation manifest");
  }

  const proxy = createProductionProxy(config, catalog, fetchJevTransport(config.jevEndpoint, env.JEV_API_KEY));
  const allowedTaskIds = new Set(plan.plan.tasks.map(task => task.task_id));
  const server = createRouterServer(config, catalog, proxy, { allowedTaskIds });
  try {
    await listenLoopback(server, config.port);
  } catch {
    manifest.status = "START_FAILED";
    manifest.ended_at = new Date(now()).toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    throw new Error("controlled evaluation listener failed to bind to loopback");
  }
  manifest.status = "LISTENING";
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    manifest.status = "START_FAILED";
    manifest.ended_at = new Date(now()).toISOString();
    await writeManifestSafely(manifestPath, manifest);
    throw new Error("unable to record the controlled evaluation listener state");
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    const safeTelemetry = proxy.telemetry;
    const observations = {
      format: "jev-evaluation-observations/1",
      classification: CLASSIFICATION,
      run_id: runId,
      calls: safeTelemetry.calls.map(record => sanitizeRecord(record, runId)),
      tasks: safeTelemetry.tasks.map(record => sanitizeRecord(record, runId)),
    };
    const observationText = `${JSON.stringify(observations, null, 2)}\n`;
    try {
      await writeFile(observationsPath, observationText, { flag: "wx", mode: 0o600 });
    } catch {
      manifest.status = "STOP_FAILED";
      manifest.ended_at = new Date(now()).toISOString();
      await writeManifestSafely(manifestPath, manifest);
      throw new Error("unable to write the sanitized EVALUATION_ONLY observations artifact");
    }
    manifest.status = "STOPPED";
    manifest.ended_at = new Date(now()).toISOString();
    try {
      await writeManifestSafely(manifestPath, manifest);
    } catch {
      manifest.status = "STOP_FAILED";
      await writeManifestSafely(manifestPath, manifest);
      throw new Error("unable to finalize the sanitized EVALUATION_ONLY run manifest");
    }
  };

  return { config, manifestPath, server, stop };
}

async function resolveWithExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isMissingPath(error)) throw new Error("unable to inspect the controlled evaluation output path");
      const parent = dirname(current);
      if (parent === current) throw new Error("unable to resolve the controlled evaluation output path");
      suffix.unshift(basename(current));
      current = parent;
      continue;
    }

    let resolved = current;
    if (info.isSymbolicLink()) {
      try {
        resolved = await realpath(current);
        if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error("controlled evaluation output path contains an unresolved symbolic link");
      }
    } else if (!info.isDirectory()) {
      throw new Error("controlled evaluation output path contains a non-directory component");
    } else {
      try {
        resolved = await realpath(current);
      } catch {
        throw new Error("unable to resolve the controlled evaluation output path");
      }
    }
    return resolve(resolved, ...suffix);
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function requireEvaluationEnvironment(env: NodeJS.ProcessEnv): { planFile: string; proofFile: string; outputDirectory: string } {
  if (env.JEV_EVALUATION_ONLY !== CLASSIFICATION) {
    throw new Error("set JEV_EVALUATION_ONLY=EVALUATION_ONLY to start the local evidence collector");
  }
  if (env.JEV_MODE !== "active") throw new Error("controlled evaluation requires explicit JEV_MODE=active");
  if (env.JEV_ROUTER_OFF === "1") throw new Error("controlled evaluation cannot run with JEV_ROUTER_OFF=1");
  if (env.JEV_ACTIVE_EVIDENCE_FILE !== undefined) throw new Error("controlled evaluation does not accept a production Active evidence file");
  if (!env.JEV_API_KEY?.trim()) throw new Error("JEV_API_KEY is required before the evaluation listener can start");
  const port = env.JEV_PORT;
  if (port === undefined || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("set an explicit valid JEV_PORT for the loopback listener");
  }
  return {
    planFile: required(env.JEV_EVALUATION_PLAN_FILE, "JEV_EVALUATION_PLAN_FILE"),
    proofFile: required(env.JEV_PAIR_PROOFS_FILE, "JEV_PAIR_PROOFS_FILE"),
    outputDirectory: required(env.JEV_EVALUATION_OUTPUT_DIR, "JEV_EVALUATION_OUTPUT_DIR"),
  };
}

function runtimeConfig(env: NodeJS.ProcessEnv, plan: ControlledActivePlan, currentTime: number): EntryConfig {
  const expected = plan.config;
  if (expected.mode !== "active" || expected.candidates.length === 0) {
    throw new Error("frozen plan must select Active mode and a non-empty exact candidate set");
  }
  if (!isPinnedJevVersion(expected.jevVersion)) throw new Error("controlled Active requires a pinned Jev version");
  if (expected.policyVersion !== POLICY_VERSION || expected.questionSchemaVersion !== QUESTION_SCHEMA_VERSION) {
    throw new Error("frozen plan policy or question schema version does not match this runtime");
  }
  if (plan.plan.release !== expected.release) throw new Error("frozen task plan and runtime release do not match");
  if (plan.plan.repository_snapshot_digest === "UNKNOWN" || !/^[0-9a-f]{64}$/.test(plan.plan.repository_snapshot_digest)) {
    throw new Error("frozen plan must bind a SHA-256 repository snapshot digest");
  }
  const frozenAt = Date.parse(plan.plan.frozen_at);
  if (!Number.isFinite(frozenAt) || frozenAt > currentTime || plan.plan.tasks.length === 0) {
    throw new Error("controlled Active requires a frozen plan with at least one task");
  }
  if (new Set(plan.plan.tasks.map(task => task.task_id)).size !== plan.plan.tasks.length) {
    throw new Error("frozen task plan contains duplicate task IDs");
  }

  const requiredBindings: Array<[string | undefined, string, string]> = [
    [env.JEV_RELEASE_ID, expected.release, "release ID"],
    [env.JEV_VERSION, expected.jevVersion, "Jev version"],
    [env.JEV_CALLER_EDGE_ID, expected.callerEdgeId, "caller-edge ID"],
  ];
  for (const [actual, frozen, label] of requiredBindings) {
    if (!actual || actual === "UNKNOWN" || actual !== frozen || frozen === "UNKNOWN") {
      throw new Error(`explicit ${label} does not match the frozen plan`);
    }
  }
  if (env.JEV_BASELINE === undefined || !samePair(parseBaseline(env.JEV_BASELINE), expected.baseline)) {
    throw new Error("explicit JEV_BASELINE does not match the frozen plan");
  }
  const activeCandidates = parseActiveCandidates(env.JEV_ACTIVE_CANDIDATES);
  if (!samePairs(activeCandidates, expected.candidates)) {
    throw new Error("explicit JEV_ACTIVE_CANDIDATES do not match the frozen candidate list");
  }
  if (!env.JEV_UPSTREAM_BASE_URL || !env.JEV_ENDPOINT) {
    throw new Error("controlled Active requires explicit caller-edge and Jev endpoints");
  }
  if (endpointBindingDigest(env.JEV_UPSTREAM_BASE_URL) !== plan.bindings.upstreamTargetDigest) {
    throw new Error("caller-edge endpoint does not match the frozen plan binding");
  }
  if (endpointBindingDigest(env.JEV_ENDPOINT) !== plan.bindings.jevEndpointTargetDigest) {
    throw new Error("Jev endpoint does not match the frozen plan binding");
  }
  if (!env.JEV_CONFIDENCE_FLOOR?.trim() || !env.JEV_DEADLINE_MS?.trim() ||
      !Number.isFinite(Number(env.JEV_CONFIDENCE_FLOOR)) || !Number.isFinite(Number(env.JEV_DEADLINE_MS)) ||
      Number(env.JEV_CONFIDENCE_FLOOR) !== expected.runtimePolicy.confidenceFloor ||
      Number(env.JEV_DEADLINE_MS) !== expected.runtimePolicy.deadlineMs) {
    throw new Error("explicit Jev confidence floor and deadline must match the frozen runtime policy");
  }

  // configFromEnv keeps the shared endpoint and policy parsing. Its strict
  // production Active branch is not used by this separate bench entry.
  const parsed = configFromEnv({ ...env, JEV_MODE: "shadow", JEV_ROUTER_OFF: "0" });
  if (parsed.policy.jevVersion !== expected.jevVersion) {
    throw new Error("runtime Jev policy settings do not match the frozen plan");
  }
  if (!isValidJevPolicyParameters(expected.runtimePolicy)) {
    throw new Error("frozen Jev policy parameters are invalid");
  }
  return {
    ...parsed,
    policy: {
      ...parsed.policy,
      confidenceFloor: expected.runtimePolicy.confidenceFloor,
      deadlineMs: expected.runtimePolicy.deadlineMs,
    },
    routerOff: false,
    mode: "active",
    activeCandidates,
    baseline: expected.baseline,
    releaseId: expected.release,
    activeEvidenceFile: undefined,
    callerEdgeId: expected.callerEdgeId,
  };
}

function validateFrozenCatalogBinding(plan: ControlledActivePlan, config: EntryConfig, now: number): string {
  const frozen = plan.config.candidateCatalog;
  const bindings = plan.bindings;
  if (frozen.proofManifestId !== bindings.proofManifestId || frozen.proofManifestDigest !== bindings.proofManifestDigest ||
      frozen.discoveryDigest !== bindings.discoveryDigest) {
    throw new Error("frozen candidate catalog does not match the plan proof and discovery bindings");
  }
  let candidateCatalogId: string;
  try {
    candidateCatalogId = deriveCandidateCatalogId(frozen, config.callerEdgeId, now);
  } catch {
    throw new Error("frozen catalog has no complete exact-pair proof identity");
  }
  if (plan.config.candidateCatalogId !== candidateCatalogId ||
      (config.candidateCatalogIdExpected !== undefined && config.candidateCatalogIdExpected !== candidateCatalogId)) {
    throw new Error("frozen candidate catalog ID does not match the derived exact-pair identity");
  }
  if (!resolveBaseline(frozen, config.baseline.model, config.baseline.effort, now)) {
    throw new Error("frozen Fallback Baseline has no current exact-pair proof through this caller edge");
  }
  if (config.activeCandidates.some(pair => !resolveBaseline(frozen, pair.model, pair.effort, now))) {
    throw new Error("one or more frozen Active candidates have no current exact-pair proof");
  }
  return candidateCatalogId;
}

function validateCatalogBinding(
  plan: ControlledActivePlan,
  config: EntryConfig,
  catalog: Awaited<ReturnType<ModelDiscovery["discover"]>>,
  frozenCatalogId: string,
  now: number,
): string {
  const bindings = plan.bindings;
  if (catalog.proofManifestId !== bindings.proofManifestId || catalog.proofManifestDigest !== bindings.proofManifestDigest) {
    throw new Error("current caller-edge proof manifest does not match the frozen plan");
  }
  if (catalog.discoveryDigest !== bindings.discoveryDigest) {
    throw new Error("current proved candidate catalog does not match the frozen plan");
  }
  let currentCatalogId: string;
  try {
    currentCatalogId = deriveCandidateCatalogId(catalog, config.callerEdgeId, now);
  } catch {
    throw new Error("current catalog has no complete exact-pair proof identity");
  }
  if (frozenCatalogId !== currentCatalogId ||
      plan.config.candidateCatalog.discoveryDigest !== catalog.discoveryDigest ||
      plan.config.candidateCatalog.proofManifestId !== catalog.proofManifestId ||
      plan.config.candidateCatalog.proofManifestDigest !== catalog.proofManifestDigest ||
      plan.config.candidateCatalog.session_binding_digest !== catalog.session_binding_digest ||
      (config.candidateCatalogIdExpected !== undefined && config.candidateCatalogIdExpected !== currentCatalogId)) {
    throw new Error("frozen candidate catalog ID or proof snapshot does not match the current caller-edge catalog");
  }
  if (!resolveBaseline(catalog, config.baseline.model, config.baseline.effort, now)) {
    throw new Error("frozen Fallback Baseline has no current exact-pair proof through this caller edge");
  }
  const unproved = config.activeCandidates.filter(pair => !resolveBaseline(catalog, pair.model, pair.effort, now));
  if (unproved.length) throw new Error("one or more frozen Active candidates have no current exact-pair proof");
  return currentCatalogId;
}

function parseControlledPlan(text: string): ControlledActivePlan {
  const record = parseJson(text, "controlled evaluation plan");
  requireKeys(record, ["format", "classification", "config", "plan", "bindings"], "controlled evaluation plan");
  if (record.format !== FORMAT || record.classification !== CLASSIFICATION) {
    throw new Error("controlled plan must use the EVALUATION_ONLY format");
  }
  const config = record.config as HarnessConfig | undefined;
  const plan = record.plan as EvaluationPlan | undefined;
  const bindings = record.bindings as ControlledActivePlan["bindings"] | undefined;
  if (!config || !plan || !bindings || typeof bindings !== "object") {
    throw new Error("controlled evaluation plan is missing runtime, task, policy or proof bindings");
  }
  validateHarnessConfig(config);
  validateEvaluationPlan(plan);
  requireKeys(bindings as unknown as Record<string, unknown>, [
    "upstreamTargetDigest", "jevEndpointTargetDigest", "discoveryDigest", "proofManifestId", "proofManifestDigest",
  ], "controlled plan bindings");
  if (![bindings.upstreamTargetDigest, bindings.jevEndpointTargetDigest, bindings.discoveryDigest, bindings.proofManifestDigest]
      .every(isDigest) || !safeId(bindings.proofManifestId)) {
    throw new Error("controlled evaluation plan contains an incomplete endpoint or proof binding");
  }
  return record as unknown as ControlledActivePlan;
}

function validateHarnessConfig(config: HarnessConfig): void {
  const value = config as unknown as Record<string, unknown>;
  requireKeys(value, [
    "release", "mode", "baseline", "candidates", "currency", "priceSourceRef", "callerEdgeId", "candidateCatalog",
    "candidateCatalogId",
    "jevVersion", "policyVersion", "questionSchemaVersion", "prices", "cacheConditions", "runtimePolicy",
  ], "frozen runtime configuration");
  if (!safeId(config.release) || config.mode !== "active" || !safeId(config.currency) || !safeId(config.priceSourceRef) ||
      !safeId(config.callerEdgeId) || !safeId(config.candidateCatalogId) || !safeVersion(config.jevVersion) ||
      !safeVersion(config.policyVersion) || !safeVersion(config.questionSchemaVersion) ||
      (config.cacheConditions !== "cold" && config.cacheConditions !== "warm" && config.cacheConditions !== "declared-per-task")) {
    throw new Error("frozen runtime configuration has invalid IDs, mode or cache conditions");
  }
  validatePair(config.baseline, "frozen Fallback Baseline");
  const runtimePolicy = config.runtimePolicy as unknown as Record<string, unknown>;
  requireKeys(runtimePolicy, ["confidenceFloor", "deadlineMs"], "frozen runtime Jev policy");
  if (!isValidJevPolicyParameters(runtimePolicy)) {
    throw new Error("frozen runtime Jev policy parameters are invalid");
  }
  if (!Array.isArray(config.candidates) || config.candidates.length === 0) {
    throw new Error("frozen runtime configuration must name exact Active candidates");
  }
  config.candidates.forEach(pair => validatePair(pair, "frozen Active candidate"));
  const pairKeys = config.candidates.map(pair => `${pair.model}/${pair.effort}`);
  if (new Set(pairKeys).size !== pairKeys.length) throw new Error("frozen runtime configuration repeats an Active candidate");
  validateModelCatalog(config.candidateCatalog);
  if (!safeId(config.candidateCatalogId)) throw new Error("frozen runtime configuration has no derived candidate catalog ID");

  const prices = config.prices as unknown as Record<string, unknown>;
  if (!prices || typeof prices !== "object" || Array.isArray(prices) || Object.getPrototypeOf(prices) !== Object.prototype) {
    throw new Error("frozen runtime configuration has no price table");
  }
  const requiredModels = new Set([config.baseline.model, ...config.candidates.map(pair => pair.model), config.jevVersion]);
  for (const model of requiredModels) {
    const rate = prices[model];
    if (!rate || typeof rate !== "object" || Array.isArray(rate)) throw new Error("frozen runtime configuration has an incomplete price table");
    const fields = rate as Record<string, unknown>;
    requireKeys(fields, ["input", "cached_input", "cache_write_input", "output"], "frozen price entry");
    if (Object.values(fields).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error("frozen runtime configuration has invalid price values");
    }
  }
}

function validateModelCatalog(catalog: ModelCatalog): void {
  const value = catalog as unknown as Record<string, unknown>;
  requireKeys(value, [
    "source", "models", "session_binding_digest", "observed_at", "discoveryDigest", "proofManifestId", "proofManifestDigest",
    "proofExclusions", "effortObservationGapCount",
  ], "frozen candidate catalog");
  if (catalog.source !== "authenticated-caller-edge:/models" || !isDigest(catalog.session_binding_digest) ||
      !Number.isFinite(catalog.observed_at) || !isDigest(catalog.discoveryDigest) || !safeId(catalog.proofManifestId) ||
      !isDigest(catalog.proofManifestDigest) || !Array.isArray(catalog.models) || !Array.isArray(catalog.proofExclusions) ||
      !Number.isInteger(catalog.effortObservationGapCount) || catalog.effortObservationGapCount < 0) {
    throw new Error("frozen candidate catalog has invalid metadata");
  }
  const exclusionReasons = new Set([
    "caller_edge_mismatch", "duplicate_pair", "expired", "invalid_time_window", "request_failed", "model_mismatch",
    "effort_mismatch", "pair_not_discovered",
  ]);
  for (const exclusion of catalog.proofExclusions) {
    const exclusionValue = exclusion as unknown as Record<string, unknown>;
    requireKeys(exclusionValue, ["model", "effort", "reason"], "frozen candidate catalog proof exclusion");
    if (!safeId(exclusion.model) || !safeId(exclusion.effort) || typeof exclusion.reason !== "string" || !exclusionReasons.has(exclusion.reason)) {
      throw new Error("frozen candidate catalog has an invalid proof exclusion");
    }
  }
  for (const model of catalog.models) {
    const modelValue = model as unknown as Record<string, unknown>;
    requireKeys(modelValue, [
      "model", "tier", "supported_efforts", "proved_efforts", "proof_versions", "proof_expires_at",
      "effort_observation_unknown", "requestable",
    ], "frozen candidate catalog model");
    if (!safeId(model.model) || !["luna_max", "sol", "astra"].includes(model.tier) ||
        !Array.isArray(model.supported_efforts) || model.supported_efforts.some(effort => !safeId(effort)) ||
        !Array.isArray(model.proved_efforts) || model.proved_efforts.some(effort => !safeId(effort)) ||
        !plainStringMap(model.proof_versions, isDigest) || !plainNumberMap(model.proof_expires_at) ||
        !Array.isArray(model.effort_observation_unknown) || model.effort_observation_unknown.some(effort => !safeId(effort)) ||
        typeof model.requestable !== "boolean") {
      throw new Error("frozen candidate catalog has an invalid model entry");
    }
    const proved = new Set(model.proved_efforts);
    if (proved.size !== model.proved_efforts.length ||
        new Set(model.supported_efforts).size !== model.supported_efforts.length ||
        model.proved_efforts.some(effort => !model.supported_efforts.includes(effort)) ||
        Object.keys(model.proof_versions).some(effort => !proved.has(effort)) ||
        Object.keys(model.proof_expires_at).some(effort => !proved.has(effort)) ||
        model.proved_efforts.some(effort => !model.proof_versions[effort] || !model.proof_expires_at[effort]) ||
        model.effort_observation_unknown.some(effort => !proved.has(effort)) || model.requestable !== (proved.size > 0)) {
      throw new Error("frozen candidate catalog has inconsistent exact-pair proof metadata");
    }
  }
}

function plainStringMap(value: unknown, validateValue: (value: unknown) => boolean): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([key, item]) => safeId(key) && validateValue(item)));
}

function plainNumberMap(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([key, item]) => safeId(key) && typeof item === "number" && Number.isFinite(item) && item > 0));
}

function validateEvaluationPlan(plan: EvaluationPlan): void {
  const value = plan as unknown as Record<string, unknown>;
  requireKeys(value, [
    "release", "frozen_at", "repository_revision", "repository_snapshot_digest", "randomization_seed",
    "independent_review_method", "gates", "tasks",
  ], "frozen evaluation task plan");
  if (!safeId(plan.release) || typeof plan.frozen_at !== "string" || !Number.isFinite(Date.parse(plan.frozen_at)) ||
      !safeId(plan.repository_revision) || !isDigest(plan.repository_snapshot_digest) || !safeId(plan.randomization_seed) ||
      !safeId(plan.independent_review_method)) {
    throw new Error("frozen evaluation task plan has invalid revision, snapshot, timestamp or review metadata");
  }
  const gates = plan.gates as unknown as Record<string, unknown>;
  requireKeys(gates, [
    "minimum_quality_score", "maximum_completion_regression", "maximum_quality_regression", "maximum_added_rework_per_task",
    "maximum_added_takeover_rate", "maximum_policy_cost_ratio",
  ], "frozen evaluation gates");
  if (Object.values(gates).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error("frozen evaluation task plan has invalid gates");
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error("frozen evaluation task plan has no tasks");
  for (const task of plan.tasks) {
    const taskValue = task as unknown as Record<string, unknown>;
    requireKeys(taskValue, ["task_id", "intent_digest", "snapshot_digest", "acceptance_id", "first_arm", "cache_condition"], "frozen task");
    if (!validTaskId(task.task_id) || !isDigest(task.intent_digest) || !isDigest(task.snapshot_digest) || !safeId(task.acceptance_id) ||
        (task.first_arm !== "baseline" && task.first_arm !== "policy") ||
        (task.cache_condition !== "cold" && task.cache_condition !== "warm")) {
      throw new Error("frozen task has invalid identifiers, digests, arm order or cache condition");
    }
  }
  if (new Set(plan.tasks.map(task => task.task_id)).size !== plan.tasks.length) {
    throw new Error("frozen task plan contains duplicate task IDs");
  }
}

function validatePair(pair: { model: string; effort: string }, label: string): void {
  const value = pair as unknown as Record<string, unknown>;
  requireKeys(value, ["model", "effort"], label);
  if (!safeId(pair.model) || !safeId(pair.effort)) throw new Error(`${label} has an invalid model/effort pair`);
}

function validTaskId(value: string): boolean {
  return safeId(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && value !== "UNKNOWN" && !looksSensitive(value);
}

function safeVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) && value !== "UNKNOWN" && !looksSensitive(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function requireKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const actual = Object.keys(record).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function parseJson(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function endpointBindingDigest(value: string): string {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("caller-edge and Jev endpoints must be valid absolute URLs");
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password || target.search || target.hash) {
    throw new Error("endpoint binding cannot contain credentials, query parameters or fragments");
  }
  return digest({ origin: target.origin, pathname: target.pathname });
}

function samePair(a: { model: string; effort: string }, b: { model: string; effort: string }): boolean {
  return a.model === b.model && a.effort === b.effort;
}

function samePairs(a: Array<{ model: string; effort: string }>, b: Array<{ model: string; effort: string }>): boolean {
  return a.length === b.length && a.every((pair, index) => samePair(pair, b[index]));
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

async function readRequiredFile(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new Error(`unable to read ${label}`);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function gitRevision(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return result.stdout.trim();
  } catch {
    throw new Error("unable to identify the current source revision");
  }
}

async function gitWorktreeClean(cwd: string): Promise<boolean> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
    return result.stdout.trim().length === 0;
  } catch {
    throw new Error("unable to verify the current source worktree");
  }
}

async function readPackageVersion(cwd: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string") return packageJson.version;
  } catch {
    // The package metadata is required for a reviewable run manifest.
  }
  throw new Error("unable to read the current package version");
}

async function writeManifestSafely(path: string, manifest: RunManifest): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    throw new Error("unable to record the EVALUATION_ONLY run manifest status");
  }
}

async function listenLoopback(server: ReturnType<typeof createRouterServer>, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new Error("evaluation listener did not bind to IPv4 loopback");
  }
}

async function checkLoopbackPort(port: number): Promise<void> {
  const probe: Server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = probe.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close(error => error ? rejectClose(error) : resolveClose());
  });
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    throw new Error("controlled evaluation requires a free IPv4 loopback port");
  }
}

function sanitizeRecord<T extends { task_id: string; evidence_refs?: string[] }>(record: T, runId: string): Omit<T, "task_id" | "evidence_refs"> & { task_id: string; evidence_refs?: string[] } {
  const { task_id, evidence_refs, ...safe } = record;
  return {
    ...safe,
    task_id: `sha256:${sha256(`${runId}\0${task_id}`).slice(0, 24)}`,
    ...(evidence_refs === undefined ? {} : { evidence_refs: evidence_refs.map(ref => `sha256:${sha256(`${runId}\0${ref}`).slice(0, 24)}`) }),
  };
}

async function main(): Promise<void> {
  try {
    const run = await startControlledActiveEvaluation();
    const address = run.server.address();
    const port = address && typeof address !== "string" ? address.port : run.config.port;
    process.stdout.write(`EVALUATION_ONLY Active listener ready at http://127.0.0.1:${port}; manifest: ${run.manifestPath}\n`);
    const stop = (): void => {
      void run.stop()
        .then(() => process.stdout.write("EVALUATION_ONLY run saved and listener stopped\n"))
        .catch(() => {
          process.stderr.write("unable to save sanitized EVALUATION_ONLY observations\n");
          process.exitCode = 1;
        });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "controlled evaluation failed"}\n`);
    process.exitCode = 1;
  }
}

declare const require: { main?: unknown } | undefined;
try {
  const req = typeof require !== "undefined" ? require : undefined;
  if (req && (req as { main?: unknown }).main === module) void main();
} catch {
  // Imported by tests: do nothing.
}
