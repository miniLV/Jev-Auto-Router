# Offline evaluation (bench)

This directory contains offline research tools and one separate local,
`EVALUATION_ONLY` Active evidence collector. The collector can exercise the
real Responses HTTP chain under a frozen plan; its artifacts do not prove a
production release by themselves and cannot satisfy the production Active
gate.

`npm run bench:jev-smoke` checks five synthetic allowlisted states against Jev.
It requires `JEV_API_KEY` or `TYPESAFE_API_KEY`; it does not run Codex or
measure quality or savings.

`npm run bench:evaluate -- <sanitized-evaluation-bundle.json> [--report
<report.json>]` reads a frozen paired evaluation bundle and emits a sanitized
report that refers to the bundle by its raw-byte SHA-256. The input contains a
sanitized current candidate catalog snapshot plus configuration IDs, digests,
task outcomes, model-call usage and cost data; the report emits only the
catalog ID derived from that snapshot. Do not put prompts, file contents, tool
output or credentials in it.

- `config.ts` — exact baseline/candidate pairs, version IDs and frozen prices.
- `harness.ts` — historical repricing, always labeled
  `ESTIMATED/COUNTERFACTUAL`.
- `paired-evaluation.ts` — pairing validation, full accounting and Active
  eligibility decisions.
- `controlled-active.ts` — local, loopback-only real-call evidence collection
  for a frozen plan. It reuses the production Responses proxy and HTTP route.

## Freeze before running

Commit the evaluation bundle before either arm runs. Freeze the repository
revision and per-task snapshot, input and acceptance digests, independent
review method, seeded arm order, cache condition, quality thresholds, cost
target, caller-edge/catalog IDs, exact `(model, effort)` pairs, Jev/policy
versions, exact `runtimePolicy.confidenceFloor` and `runtimePolicy.deadlineMs`,
currency, price source and full price table. Use opaque task IDs and
store only digests for task inputs. Record every arm's start timestamp and
opaque `kind:sha256:<hex>` independent-review references to its diff, tests and artifacts; the
evaluator rejects runs started before the plan was frozen or in the wrong
randomized order.

Record the same `runtimePolicy` on every Jev call. Shadow and controlled runs
must match the frozen values exactly; missing or changed values block Active.
The report copies the pair to `configuration.runtimePolicy`, and the
`evaluation_data_digest` binds it with the sanitized evaluation bundle.

Derive the catalog ID from the current discovered catalog with
`deriveCandidateCatalogId` from `src/catalog.ts`; freeze that value in the
evaluation configuration. Do not use a manually assigned catalog label.

The same frozen task must run through the configured fallback pair and the
Active policy with matching digests and cache conditions. The evaluator rejects
missing, duplicated or mismatched pairs. Candidate decisions require a second
pair-locked comparison for each exact candidate plus passing transport,
cancellation and Shadow evidence for the same edge, catalog, Jev, policy,
question schema and price release. Give each gate an opaque reference such as
`transport:sha256:<hex>`, `cancellation:sha256:<hex>` or `shadow:sha256:<hex>`
to its sanitized, separately reviewable evidence artifact. A PASS without a
matching evidence reference remains UNKNOWN and cannot enable Active.

## Active report bundle and asset manifest

The formal Active report uses schema `jev-paired-evaluation-report-v2` and
contains `active_evidence_bundle: { schema_version, path, sha256 }`. The path is
a POSIX relative path from the report directory to a
`jev-active-evaluation-bundle-v1` JSON file. Keep the report and bundle in the
same directory or put the bundle in a child directory; parent traversal,
absolute paths and symlink escapes are rejected. The bundle has exactly these
top-level fields:

| Field | Value |
| --- | --- |
| `schema_version` | `jev-active-evaluation-bundle-v1` |
| `config` | Complete sanitized `HarnessConfig` object |
| `plan` | Complete frozen `EvaluationPlan` object |
| `tasks` | Paired baseline/policy task runs array |
| `candidate_evaluations` | Per-candidate paired and Shadow evaluations array |
| `evidence_manifest` | Manifest entries for every required asset array |

Each manifest entry has exactly `id`, `ref`, `path`, `sha256`, `kind`,
`schema_version`, `release_id`, `candidate_id`, `configuration_digest` and
`association_id`. `path` is relative to the bundle directory and must resolve
inside it. The `sha256` is over the exact asset-file bytes, and `ref` must be
`<kind>:sha256:<same digest>`. IDs, paths and references are unique. The
configuration digest is SHA-256 over the repository's canonical JSON encoding
of the complete `HarnessConfig`; release, candidate and association fields
must match the evaluated inputs.

Assets are JSON objects with exactly `schema_version`, `kind`, `release_id`,
`candidate_id`, `configuration_digest`, `association_id` and `facts`. Accepted
kinds and schema versions are `transport/jev-transport-evidence-v1`,
`cancellation/jev-cancellation-evidence-v1`, `shadow/jev-shadow-evidence-v1`,
and `diff`, `test` or `artifact` with `jev-quality-evidence-v1`. Transport facts
bind the requested pair to the observed candidate model and observed effort
(the effort may explicitly be `UNKNOWN`); cancellation facts separately cover
Jev wait and upstream generation; Shadow facts bind the proposed pair to the
executed baseline; quality facts bind the frozen task, arm, acceptance ID,
review method and outcome metrics. Unknown kinds, versions, fields or
associations are rejected.

Generate and save the report with:

```sh
npm run bench:evaluate -- ./release/evaluation-bundle.json --report ./release/report.json
```

Formal Active reads that saved bundle and all referenced asset files, verifies
their bytes and associations, reruns the pure paired evaluator, then compares
the complete result with the report. This catches hand-edited PASS fields and
unbound or incomplete evidence; a hash binds bytes but does not prove who
created them, whether a model request really ran, or whether a person actually
reviewed quality. Synthetic bundles in tests prove only the validator and
evaluator behavior. They are not human review or real caller-edge evidence.
Inspect and independently establish provenance for real quality, transport,
cancellation and Shadow evidence before using a report for a production release.

To collect Shadow evidence for a chosen candidate set, set
`JEV_MODE=shadow` and `JEV_ACTIVE_CANDIDATES` to those exact pairs. Jev sees
only that set while the router continues to execute the configured baseline.
The report contains separate baseline, Shadow and Active measurements for
each exact candidate and an input digest that binds its sanitized evaluation
bundle, including independent-review references. Save the sanitized bundle,
all referenced evidence artifacts, and the complete JSON report before
enabling Active.

## Local controlled Active evidence collection

This entry resolves the evidence dependency cycle for Issues 06/07. It runs the
same `ResponsesProxy`, HTTP handler, Jev transport and authenticated caller-edge
adapter as the formal process, but starts from `bench/controlled-active.ts`,
not `src/index.ts`. It always listens on `127.0.0.1`; no request header can
switch a production process into evaluation mode.

Before starting, freeze a JSON plan and proof manifest outside the source
checkout (for example in a private directory under `${TMPDIR:-/tmp}`). The
source checkout must remain clean so its revision can be bound to the run. The
file uses this shape:

```json
{
  "format": "jev-controlled-active-evaluation/1",
  "classification": "EVALUATION_ONLY",
  "config": "the complete HarnessConfig from config.ts, with mode active and the sanitized current candidateCatalog",
  "plan": "the complete frozen EvaluationPlan from paired-evaluation.ts",
  "bindings": {
    "upstreamTargetDigest": "sha256 endpoint binding",
    "jevEndpointTargetDigest": "sha256 endpoint binding",
    "discoveryDigest": "current proved-catalog discovery digest",
    "proofManifestId": "current caller-edge proof manifest id",
    "proofManifestDigest": "current parsed proof manifest digest"
  }
}
```

The frozen task plan must name the checkout's exact Git revision and a
64-character SHA-256 repository snapshot digest. The runtime configuration
must pin the release, Fallback Baseline, exact Candidate Pair list, caller-edge
and sanitized candidate catalog, Jev version, policy version, question schema,
runtime policy and prices. Put `runtimePolicy: { confidenceFloor, deadlineMs }`
inside the `HarnessConfig`. Derive `candidateCatalogId` with
`deriveCandidateCatalogId` from that frozen `candidateCatalog`; a manually
assigned label is not authoritative. The optional `JEV_CANDIDATE_CATALOG_ID`
environment value is checked only as an additional expectation.

Build the catalog snapshot with the shared `parsePairProofManifest`,
`fetchModelList` and `ModelDiscovery.discover` APIs. Use the fixed discovery
session ID `controlled-active`, the current caller-edge ID and the exact
redacted proof manifest; the catalog source must be
`authenticated-caller-edge:/models`. This binds the frozen catalog to the
same discovery and proof session that startup will re-check.
Startup rechecks those bindings. Each required pair must have a current,
successful proof from that caller edge; `/models` alone does not prove
requestability. Endpoint bindings are made with the exported
`endpointBindingDigest(url)` helper from `dist/bench/controlled-active.js`;
it rejects endpoint URLs containing credentials, query parameters or
fragments and stores only a digest.

Set the explicit process bindings (use the exact values frozen in the plan):

```sh
export EVALUATION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jev-controlled-evaluation.XXXXXX")"
cp "/path/to/frozen/evaluation-plan.json" "$EVALUATION_DIR/evaluation-plan.json"
cp "/path/to/frozen/caller-edge-pair-proofs.json" "$EVALUATION_DIR/caller-edge-pair-proofs.json"
export JEV_EVALUATION_ONLY=EVALUATION_ONLY
export JEV_EVALUATION_PLAN_FILE="$EVALUATION_DIR/evaluation-plan.json"
export JEV_PAIR_PROOFS_FILE="$EVALUATION_DIR/caller-edge-pair-proofs.json"
export JEV_EVALUATION_OUTPUT_DIR="$EVALUATION_DIR/runs"
export JEV_MODE=active
export JEV_PORT=8789
export JEV_RELEASE_ID="<frozen-release-id>"
export JEV_BASELINE="<model>/<effort>"
export JEV_ACTIVE_CANDIDATES="<model>/<effort>,<model>/<effort>"
export JEV_CALLER_EDGE_ID="<frozen-caller-edge-id>"
export JEV_CANDIDATE_CATALOG_ID="<frozen-catalog-id>"
export JEV_VERSION="<pinned-jev-version>"
export JEV_CONFIDENCE_FLOOR="<frozen-confidence-floor>"
export JEV_DEADLINE_MS="<frozen-deadline-ms>"
export JEV_UPSTREAM_BASE_URL="<authenticated-non-recursive-caller-edge>"
export JEV_ENDPOINT="<jev-endpoint>"
export JEV_API_KEY="<jev-api-key>"
npm run bench:active-evaluation
```

Startup refuses missing or mismatched plan, endpoint, proof, version, edge,
baseline or candidate bindings before it opens the listener. It verifies the
current Git revision and a clean source worktree, re-discovers the catalog,
then checks that the baseline and every exact candidate still have valid
proofs and re-derives the candidate catalog identity. Only planned, bounded
task IDs are accepted; invalid or unplanned task requests are rejected before
Jev or model inference. A proof expiry or edge
change also closes subsequent routing through the shared catalog rules. The
generated run directory contains a sanitized
`manifest.json` and `observations.json`, both marked `EVALUATION_ONLY`; task
and review identifiers are hashed, and no Jev key, endpoint URL, prompt, file
content or tool output is copied into them.

Configure the existing Codex Router's `jev/auto` Responses route to
`http://127.0.0.1:8789/v1` while the collector is running. Keep real-model
manual routes pointed through their normal path. Use one of the frozen task
IDs and provide the allowlisted step/context facts needed for Jev Choice. The
server prints the local manifest path; `GET /decisions` is also available on
loopback while it runs. Press Ctrl-C to stop it and write the final sanitized
observations file. Review and copy the required artifacts into the evidence
bundle for Issues 06/07, then remove the temporary run directory and unset the
evaluation variables.

Do not set `JEV_ACTIVE_EVIDENCE_FILE` for this entry. The formal `npm start`
path does not read `JEV_EVALUATION_ONLY` and still requires a separately
validated paired-evaluation release report. The evaluation manifest and
observations cannot be used as that report. Until real Jev credentials and an
authenticated caller edge are available, local stubs can verify startup and
HTTP behavior only; they are not real-session evidence and do not count as
PASS.

## Complete accounting

Each physical call is one row, including Jev Choices, caller-edge upstream
calls, retries, corrections and verification. Supply all five usage fields:
input, cached input, cache-write input, output and reasoning tokens. Cached and
cache-write tokens are subsets of input; reasoning tokens are a subset of
output, so reasoning is reported but output is billed only once. The price
table requires separate rates for input, cached input, cache-write input and
output. Each arm also needs its measured caller-edge cost; record `0` only when
the source confirms no charge. Unknown usage, rates or edge charges make full
cost `UNKNOWN`.

The report includes completion and acceptance, independent quality scores,
rework, Root takeovers, end-to-end latency, all-call cost, Jev cost and
caller-edge cost. It reports costs even when quality regresses, but only marks
a savings claim eligible when pairing, quality, cost and every exact candidate
gate pass. Missing candidate evidence remains `UNKNOWN` and blocks Active.

## Historical replay

Historical replay reprices a fixed hypothetical route over existing token
traces. It is counterfactual and may not claim that a changed model would
produce the same tokens, tool path, cache behavior or quality. Missing Jev
usage stays `UNKNOWN`; it is not replaced by a guessed token count.

## Enable and rollback

Reports created before `runtimePolicy` was required are not Active evidence.
Regenerate the Shadow and paired evaluation from a newly frozen input bundle;
do not fill old reports with the `0.55` / `2000` defaults.

After exact candidates are eligible and their evidence is reviewed, set
`JEV_MODE=active` and set `JEV_ACTIVE_CANDIDATES` to the comma-separated
allowlist from the report. Set `JEV_ACTIVE_EVIDENCE_FILE` to the saved report,
`JEV_RELEASE_ID` to its `configuration.release`, and keep the caller-edge,
catalog, Jev, policy and question-schema IDs unchanged. The router refuses
Active startup unless the report approves every configured pair for that exact
runtime and never offers other catalog pairs to Jev. Roll back to Shadow by setting
`JEV_MODE=shadow` and restarting; route choices are then observed while the
fixed baseline executes. For a fixed-baseline-only rollback, set
`JEV_ROUTER_OFF=1` and restart. These are existing runtime settings; no
additional deployment control plane is required.
