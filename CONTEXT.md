# Shared Context

This glossary defines the domain language used by the Dashboard, Auto Router,
documentation, and tests. It does not define routing rules.

| Term | Definition |
| --- | --- |
| Main Task | The user-visible task in which the request is received and the final result is delivered. |
| Root Agent | The owner of user intent, task understanding, integration, final verification, and delivery in the Main Task. |
| Root Model | The model selected for the Main Task. Auto Router does not change it. |
| Auto Router | The explicitly invoked Skill that chooses whether bounded work stays with Root or is delegated under the Router Policy. |
| Router Policy | The single normative source for route eligibility, Worker model and reasoning effort, and fallback behavior. |
| Route Request | The current user request together with any upstream Skill workflow that Auto Router must preserve. |
| Route Decision | The Router Policy result for a Route Request: Root Direct or Terra Background. |
| Root Direct | A Route Decision that keeps the work in the Main Task. |
| Terra Background | A Route Decision that delegates one bounded work unit to a Terra Worker and returns control to Root. |
| Terra Worker | A fresh-context child Agent that performs exactly one bounded work unit and cannot delegate further. |
| Task Packet | A self-contained handoff that gives a Terra Worker its objective, scope, constraints, acceptance criteria, verification, and return contract. |
| Delegation Break-even | The point at which expected delegated work is large and independent enough to justify child startup, handoff, and Root verification. |
| Root Verification | Root's inspection of a Worker result and execution of proportionate checks before adopting it. |
| Personal Usage Dashboard | A loopback-only, manually refreshed view of the current official Credit cycle and locally estimated model attribution. It never participates in a Route Decision. |
| Official Credit Snapshot | The current-cycle Credit limit, used amount, remaining amount, and reset time returned by Codex App Server. |
| Usage Attribution Estimate | A non-authoritative model allocation produced from local model-token shares and the official aggregate Credit used. |
| Profile Export | A user-initiated, content-free JSON export from the Personal Usage Dashboard. |
