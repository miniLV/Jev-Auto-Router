# Content-aware model routing for coding agents

**Research date:** 2026-07-30  
**Decision:** do not add an independent router engine, gateway, embedding classifier, or learned router to V1. Reuse Codex Orchestration's model-pinned roles and add only a small, Root-owned delegation convention for new bounded child work.

## Executive answer

Yes: there are products that inspect a prompt and choose a model. The closest open-source implementation is **Plano** (formerly Arch): it has explicit Codex and Claude Code proxy demos, preference descriptions such as `code generation` / `code understanding`, and a router LLM that selects a configured model pool. The closest specialist product is **Not Diamond**, whose official documentation explicitly calls out long-running coding agents and offers both a pre-trained Code router and custom router training. [Plano Codex demo](https://github.com/katanemo/plano/tree/main/demos/llm_routing/codex_router), [Plano routing guide](https://github.com/katanemo/plano/blob/main/docs/source/guides/llm_router.rst), [Not Diamond model-routing docs](https://docs.notdiamond.ai/docs/what-is-model-routing)

Neither is the right V1 for this repository. Both require placing a prompt-inspecting router/proxy in the model call path and, for meaningful accuracy, maintaining candidate-model configuration and calibration/evaluation. This project's proposed operation is narrower: the Root already has the task context and decides whether a *bounded Skill request* is worth delegating. Repeating that semantic read in a service produces extra cost, privacy surface, integration risk, and a competing scheduler without improving the existing Planner/Advisor/Executor governance.

The recommended V1 is therefore a three-intent, **agent-owned judgment**:

| Intent | Suggested model | Use only for a new bounded child request | Do not use for |
| --- | --- | --- | --- |
| `LIGHT` | Luna | mechanical extraction, narrow search, format conversion, and faithful summarization of supplied material | work that requires new engineering judgment |
| `DEFAULT` | Terra | normal implementation, investigation, tests, and integration | work that already triggers the orchestration policy's planner/review gate |
| `DEEP` | Sol | a clearly isolated difficult diagnosis or reasoning packet | a label to bypass Planner/Advisor governance, or routine implementation |

The Root first decides whether to delegate at all; if it does, it selects the intent from the bounded request and invokes a child with the matching already-available route. A user-selected model/effort/no-subagents instruction wins. This is **not** a way to change the already-running Root model. In Codex, routing means selecting a child/subagent (or, in an API architecture, selecting the next request); it cannot retroactively make the Root cheaper.

## Boundary with Codex Orchestration

Codex Orchestration is already role-to-model workflow configuration, not a per-prompt quality router. Its published skill says that the task's initial model remains the orchestrator, role labels are literal, and setup assigns explicit Planner, Advisor, Designer, and Executor routes. The Root owns handoffs, integration, verification, and the judgment to delegate; the configured Executor does not become Luna/Terra/Sol based on prompt content. A custom role can be created with an explicit model and effort, but that is still configuration, not automatic semantic selection. [Orchestration skill source](https://github.com/Cjbuilds/Codex-Orchestration/blob/main/plugins/codex-orchestration/skills/codex-orchestration/SKILL.md), [project README](https://github.com/Cjbuilds/Codex-Orchestration/blob/main/README.md)

Consequences:

- Do not fork or replace its Planner/Advisor/Executor protocol.
- Do not route around a configured Planner or Advisor when the existing policy requires them.
- A content-router convention must choose only an *optional, bounded* child route. It is upstream of the child call, not a second scheduler and not a rewrite of the saved Executor seat.
- If the required child model is not currently callable, return the normal Root result rather than silently substituting a provider/model.

## Claude Code comparison

Anthropic documents several mechanisms which can look like automatic model routing, but they are different:

- The main model is selected manually through `/model`, configuration, or `--model`. A model setting is an initial selection; it is not a prompt-complexity classifier. [Model configuration](https://code.claude.com/docs/en/model-config#setting-your-model)
- Claude can automatically delegate to a subagent when its *description* matches the task. Built-ins generally inherit the main model; custom subagents may pin `model` and `effort`, and the invocation can also supply a model. This is model-pinned delegation, not a documented quality prediction over an arbitrary candidate set. [Subagents: delegation and models](https://code.claude.com/docs/en/sub-agents#choose-a-model)
- `opusplan` is a deliberate phase rule: Opus in plan mode and Sonnet in execution mode. It switches at the plan/execution boundary, not by classifying each prompt's difficulty. [The `opusplan` setting](https://code.claude.com/docs/en/model-config#opusplan-model-setting)
- Adaptive reasoning lets a supported model decide how much to think at each step under an effort level. That changes reasoning depth, not the model. [Adaptive reasoning](https://code.claude.com/docs/en/model-config#adaptive-reasoning-and-fixed-thinking-budgets)
- Fallback models handle overload/unavailability; that is reliability routing, not semantic routing. [Fallback model setting](https://code.claude.com/docs/en/settings#available-settings)

So the accurate answer is: Claude Code supports manual model choice, phase-based `opusplan`, adaptive thinking, and model-pinned/description-triggered subagents. Its official documentation does **not** describe an automatic arbitrary-prompt complexity router that continuously chooses between Haiku/Sonnet/Opus for the main task.

## Candidate comparison

`Content selection` below means the candidate reads prompt semantics to choose a model. It is deliberately separate from choosing a provider/deployment because it is cheapest, fastest, or healthy.

| Candidate | Mechanism and content selection | Coding-agent fit | Cost / maintenance / integration signal | Recommendation here |
| --- | --- | --- | --- | --- |
| [Plano](https://github.com/katanemo/plano) (formerly Arch) | **Strong semantic match.** Preference-aligned router LLM infers domain/action and maps natural-language route preferences to model pools; can then order candidates by live cost/latency. Repository contains Codex and Claude Code proxy demos. | Directly targets code generation, understanding, debugging, and architecture. Supports affinity to pin a route in an agent loop. | Apache-2.0; active public repository at research date. Requires local proxy, provider credentials, request interception, model aliases/config, and its own trace/affinity behavior. [Codex demo](https://github.com/katanemo/plano/tree/main/demos/llm_routing/codex_router), [routing API](https://github.com/katanemo/plano/blob/main/docs/routing-api.md), [repository metadata](https://api.github.com/repos/katanemo/plano) | **Reject for V1; retain as the strongest external benchmark.** It solves a gateway product problem, not a composable Codex Skill problem, and would inspect all request content plus overlap Root routing/orchestration. Reconsider only if the product requirement changes to an API/proxy-controlled multi-provider coding-agent platform. |
| [Not Diamond](https://docs.notdiamond.ai/docs/what-is-model-routing) | **Strong learned content router.** Analyses messages and predicts the best candidate under quality/cost/latency trade-offs; official docs advertise a pre-trained Code router and custom routers trained on an application's evaluation data. | Its stated target includes long-running coding agents; strongest hosted specialist fit. | Managed service/API, not a drop-in local Codex Skill. The selector receives message content; using it still requires the caller to make the selected model call. Custom training needs representative evaluations. The published proxy repository is MIT, while the routing service is a product. [selection API](https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post), [proxy source](https://github.com/Not-Diamond/notdiamond-proxy) | **Reject for V1; possible later experiment.** It is appropriate only after there is a stable, provider-level harness and a labeled coding-agent evaluation set. Do not use a cross-domain/pretrained router as evidence that it can rank Luna/Terra/Sol in this exact workflow. |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | **Learned strong-vs-weak content router.** Its Matrix-Factorization, BERT, LLM-classifier, and similarity-based routers estimate the strong model's win rate from the prompt, then compare against a cost threshold. | Conceptually relevant for two-way cost/quality routing, but its shipped training/evaluation focus is general benchmarks and a two-model pair, not this multi-turn coding-agent harness. | Apache-2.0. The public repo provides an OpenAI-compatible server and evaluation framework, but its latest source push shown by GitHub at research time was 2024-08-10; treat maintenance/model-pair fit as uncertain rather than production-ready. [Repository metadata](https://api.github.com/repos/lm-sys/RouteLLM) | **Reject.** Training/calibration, embeddings/API dependencies for some routers, a proxy/server, and a 2-way abstraction are all disproportionate for a Root that already understands the task. Use only as a research baseline if a future offline benchmark is needed. |
| [semantic-router](https://github.com/aurelio-labs/semantic-router) | **Semantic intent routing, not capability routing.** Embeds example utterances for named routes and chooses by vector similarity/threshold; routes can select an action, prompt, or tool. | Useful for stable intent labels such as support vs billing, but it does not itself predict whether a coding request needs a strong or weak model. Route examples would have to be authored and continually tuned. | MIT; actively maintained public repository at research date. Needs an encoder/vector layer and a labelled utterance set. [Repository metadata](https://api.github.com/repos/aurelio-labs/semantic-router) | **Reject.** It duplicates a simple three-label classification with heavier infrastructure and is likely brittle on repository/context-sensitive coding work. It could be a V2 option only if Root judgment must be replaced by a privacy-preserving local classifier and enough labelled examples exist. |
| [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router) | **Hosted semantic selection.** `openrouter/auto`, powered by Not Diamond, analyses prompt complexity/task/capabilities, picks from a curated pool, and returns the selected model. Session stickiness pins a conversation. | General agent fit; not a Codex-native route and curated pool/model IDs can change. | Managed gateway; requires OpenRouter API/cost path and forwards prompts to it. Allowed models can be restricted, but it still owns final model selection. | **Reject.** Useful proof that semantic prompt routing is commercially deployed, not a composable local Skill. It cannot switch the existing Root, and changing a Codex task to this gateway expands authentication, billing, and data-boundary scope. |
| [LiteLLM Router](https://docs.litellm.ai/docs/routing) | **Mostly non-semantic deployment routing.** The documented Router handles weighted/RPM/TPM/latency/least-busy/cost strategies, retries, cooldowns, and fallbacks across configured deployments. | Good gateway/reliability component for an API service, but it does not decide a model's coding quality from prompt semantics by default. | Widely used open-source gateway; GitHub lists license as `NOASSERTION`, so do not infer a permissive licence without a separate legal check. Requires proxy/runtime/credential and operational state (often Redis). [repository](https://github.com/BerriAI/litellm), [repository metadata](https://api.github.com/repos/BerriAI/litellm) | **Reject for semantic V1.** It is complementary only if a future service needs load balancing/fallback after a model has already been selected. |

### Important distinction: semantic selection vs. service routing

The products often share the word “router,” but have different decision inputs:

| Decision | Examples | Keep for this V1? |
| --- | --- | --- |
| “What capability does this bounded task need?” | Root judgment; Plano; Not Diamond; RouteLLM; semantic-router | Yes, but Root judgment only |
| “Which deployment/provider is healthy, cheap, or fast?” | LiteLLM; OpenRouter provider routing; Plano candidate ordering | No |
| “What should happen after a failed request?” | LiteLLM/OpenRouter/Claude fallback chains | No |
| “Which role reviews/plans/implements and in what order?” | Codex Orchestration | Yes, unchanged |

## Smallest non-redundant V1

The smallest V1 is a Codex Orchestration preset plus one short Root instruction, not a new application/service or decision engine:

1. Keep Terra as the recommended Root/default Executor route.
2. Define one model-pinned `light_worker` role on Luna and one model-pinned `deep_reasoner` role on Sol, with narrow descriptions that tell Root when each is useful.
3. Root preserves the original Skill request, decides whether delegation is justified, and invokes one of those optional roles only for a new bounded child packet.
4. Root retains integration and final verification. Existing Codex Orchestration rules continue to decide whether Planner, Advisor, and Executor participate.
5. The repository may package/version those role descriptions and installation guidance, but it must not introduce a second route-class state machine or duplicate role-to-model execution.

That is sufficient for V1 because Codex Orchestration already leaves delegation judgment with Root and supports model-pinned roles. A learned router needs a defensible target: a dataset of comparable, completed child tasks with the actual candidate models, outcome/validation labels, and a cost-quality objective. The dashboard's aggregate model/token observations do not provide that training signal. Revisit a learned router only after real role usage proves that Root's description-based choices are repeatedly inconsistent or expensive.

## Delete or defer from the current elaborate design

This is a scope recommendation for the **new routing Skill**, not a request to delete the already-implemented local dashboard or historical ADRs.

Delete from V1 scope:

- a standalone deterministic router service/CLI and any additional model classifier call;
- a duplicate `router-policy.yml` state machine when the same policy can live in versioned role descriptions and existing orchestration configuration;
- Jira acquisition, structured `Task Signal Set` extraction, content-free serialization, and a Jira adapter as routing prerequisites;
- automatic child creation, automatic model switching, or any config rewrite of Codex Orchestration;
- a separate scheduler, route database, per-ticket billed-credit estimate, or rollout-wide policy engine.

Defer until a later evidence-backed decision:

- HIGH risk-floor / LOW-eligibility policy mechanics, a fixed-per-credit-cycle team policy, and a full Shadow Route Record/Outcome schema;
- user calibration, learned routing, embeddings, custom router training, and cross-provider gateway/proxy adoption;
- credit-runway inputs as a selector. They may remain dashboard/reporting signals, but must never override a concrete safety/governance condition;
- formal Luna eligibility beyond the narrow `LIGHT` child contract. If real tasks show handoff cost, bad validation, or weak outcomes, remove `LIGHT` rather than adding a classifier to rescue it.

Keep unchanged: the dashboard as observation, user override, Root final authority, and Codex Orchestration's role-specific planning/review/executor workflow. The resulting V1 is removable: delete one Skill convention and normal Root/Codex behavior remains.

## Evidence limits and follow-up trigger

The candidate documentation establishes mechanisms and integration boundaries, not comparative accuracy for this repository's models, codebases, or subscription Credit accounting. Provider model pools, licences, and maintenance status can change; the maintenance observations above are only the cited repository state on 2026-07-30.

Only revisit Plano/Not Diamond/RouteLLM after all of the following are true:

- a supported programmatic/proxy call path is explicitly in scope;
- task content may cross that router's data boundary;
- there is a frozen, representative coding-agent evaluation set with validation/rework outcomes; and
- the candidate can choose the exact permitted models and preserve the existing Planner/Advisor governance.
