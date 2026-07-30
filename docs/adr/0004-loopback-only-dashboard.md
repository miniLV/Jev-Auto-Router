# ADR 0004: Bind the Dashboard to loopback only

- Status: Accepted
- Date: 2026-07-30

The Personal Usage Dashboard binds only to `127.0.0.1`; its port may be selected at startup but is not persisted. LAN or public access would expose account-usage information and require an authentication and transport-security design that V1 deliberately does not provide.
