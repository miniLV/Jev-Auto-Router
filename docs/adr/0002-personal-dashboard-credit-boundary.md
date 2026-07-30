# ADR 0002: Separate Official Credit Totals from Usage Attribution

- Status: Proposed
- Date: 2026-07-30

## Context

The project needs a local Personal Usage Dashboard before defining automatic model-routing rules. A user without workspace-admin access can read current-cycle Codex Credit information through the local Codex App Server, but that source does not provide historical per-day, per-model, or per-effort billed Credits. Local Codex session logs do contain model, effort, and token telemetry, but they are not an official billing ledger.

Treating a local token calculation as actual Credits would make the Dashboard misleading. Conversely, showing only an aggregate Credit total would not identify which model or effort choices a future Router should optimize.

## Decision

1. V1 displays an Official Credit Snapshot from `account/rateLimits/read` as the billing source of truth for the current Credit cycle.
2. V1 reads official account-level daily token activity from `account/usage/read` only as a coverage and reconciliation reference.
3. V1 uses `ccusage` for local Codex session token and model parsing, and adds a narrow local reader for the recorded reasoning effort and service tier.
4. Any model- or effort-level Credit number is a Usage Attribution Estimate. It must be labelled as an estimate and never presented as an official invoice or billing export.
5. The default observation window is the current official Credit cycle.
6. Refresh is manual. V1 has no daemon, scheduler, background polling, prompt capture, or upload.
7. The Dashboard is observational only. It does not create, modify, or enable Router rules.

## Consequences

### Positive

- Users see the official current Credit total without administrator access or browser-cookie scraping.
- Model and effort behaviour can be analysed without uploading business content.
- The resulting evidence is sufficient to design and validate a later Router policy.
- V1 stays local, small, and easy to remove.

### Negative

- V1 cannot reconstruct an official historical daily Credit curve before snapshots exist.
- Per-model and per-effort Credits remain attribution estimates.
- The App Server command is documented but marked experimental, so the integration needs a versioned adapter and a clear unavailable-data state.

## Alternatives Rejected

- Treating local session token estimates as actual Credits: inaccurate and misleading.
- Browser screenshots or OCR as the billing data source: manual, brittle, and not machine-readable.
- Directly reading OAuth tokens and using private ChatGPT web endpoints: unnecessary credential exposure and no stable contract.
- Background polling in V1: adds a daemon and retention behaviour before the Dashboard's value is proven.
