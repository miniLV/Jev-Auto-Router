# ADR 0002: Separate Official Credit Totals from Usage Attribution

- Status: Proposed
- Date: 2026-07-30

## Context

The project needs a local Personal Usage Dashboard before defining automatic model-routing rules. A user without workspace-admin access can read current-cycle Codex Credit information through the local Codex App Server, but that source does not provide historical per-day, per-model, or per-effort billed Credits. Local Codex session logs do contain model, effort, and token telemetry, but they are not an official billing ledger.

Treating a local token calculation as actual Credits would make the Dashboard misleading. Conversely, showing only an aggregate Credit total would not identify which model or effort choices a future Router should optimize.

## Decision

1. V1 displays an Official Credit Snapshot from `account/rateLimits/read` as the billing source of truth for the current Credit cycle.
2. V1 reads official account-level daily token activity from `account/usage/read` only as a coverage and reconciliation reference.
3. V1 uses `ccusage --offline` for local Codex session token and model parsing. It reads only a verified session-summary envelope and field-whitelists model names and numeric token counts; reasoning effort and service tier remain unavailable unless a separately verified, field-whitelisted envelope provides them. It does not parse, retain, or expose session prompts, tool output, paths, code, or other free text; absent metadata remains `unknown`.
4. Any model- or effort-level Credit number is a Usage Attribution Estimate. When Official Credits used and local model attribution are available, it allocates the official total in proportion to the local model token share. It must be labelled as an estimate and never presented as an official invoice or billing export; Attribution Quality explains any coverage or timing difference. It is unavailable only when either source is unavailable.
5. Reconciliation compares local token attribution only with Official Token Activity for compatible observation windows. If they differ, App Server remains unchanged and authoritative; the Dashboard reports the local coverage or timing mismatch without comparing token units with Official Credits or deriving an official per-model Credit value.
6. The Dashboard uses the locally confirmed monthly attribution boundary: the one-time bootstrap period starts on 2026-07-16 and ends on the current UTC date; subsequent periods start on the first UTC day of the current month and end on the current UTC date. Since `ccusage --until` is inclusive, those dates are passed directly. This supplies consistent local model attribution while App Server aggregate Credit remains authoritative.
7. Refresh is manual. V1 has no daemon, scheduler, background polling, prompt capture, upload, or persisted Dashboard snapshot. The local web view holds only the current in-memory result of a read.
8. If an Official Credit read is unavailable or invalid, the Dashboard states that the official value is unavailable. It may still render local token attribution as non-billing data, but it does not infer or display a Credit amount.
9. The Dashboard is observational only. It does not create, modify, or enable Router rules.

## Consequences

### Positive

- Users see the official current Credit total without administrator access or browser-cookie scraping.
- Model and effort behaviour can be analysed without uploading business content.
- Differences between App Server totals and local session attribution are visible instead of being silently normalised into misleading billing data.
- The resulting evidence is sufficient to design and validate a later Router policy.
- V1 stays local, small, and easy to remove.

### Negative

- V1 cannot reconstruct an official historical daily Credit curve before snapshots exist.
- Per-model and per-effort Credits remain attribution estimates.
- A session count and a model-record count are distinct measures: one session can contain more than one model record, so they are never summed or treated as a billing metric.
- The App Server command is documented but marked experimental, so the integration needs a versioned adapter and a clear unavailable-data state.

## Alternatives Rejected

- Treating local session token estimates as actual Credits: inaccurate and misleading.
- Browser screenshots or OCR as the billing data source: manual, brittle, and not machine-readable.
- Directly reading OAuth tokens and using private ChatGPT web endpoints: unnecessary credential exposure and no stable contract.
- Background polling in V1: adds a daemon and retention behaviour before the Dashboard's value is proven.
