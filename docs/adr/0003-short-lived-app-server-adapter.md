# ADR 0003: Use a short-lived App Server Adapter for manual refresh

- Status: Accepted
- Date: 2026-07-30

The Personal Usage Dashboard starts a local Codex App Server child over stdio only when the user opens or refreshes the page, reads the required account data, and then exits. This avoids a daemon, listener, and their lifecycle/security burden while preserving fresh local data; because the protocol is experimental, the adapter is versioned, read-only, and maps unsupported or invalid responses to an explicit unavailable state rather than falling back to non-authoritative Credit estimates.

## Considered Options

- A persistent App Server daemon: rejected because the Dashboard has no background work and does not need durable process or port management.
- Direct OAuth or browser-cookie access: rejected because the App Server provides the required local account boundary without handling credentials.
