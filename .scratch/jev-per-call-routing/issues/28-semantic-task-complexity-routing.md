# 28 — 建立可审计的语义任务复杂度信号，再评估复杂度路由

**What to build:** 在现有请求形状事实之外，建立一个来源、隐私边界、版本和失败语义都可核对的非内容型任务复杂度信号契约；只有契约冻结并完成实现后，才预注册复杂度路由评估。长度桶不能代替语义复杂度，也不能直接成为新的生产选模依据。

Type: task

Blocked by: 外部条件 — 尚无已证明的认证 producer、获准的语义来源和独立评估安排；在这些条件齐备前，本票只保留门禁和停止规则。

Blocks: 后续语义复杂度路由实现与生产阈值决定；Issue 24 的评估框架只能在本票完成实现和契约冻结后复用或扩展。

Status: needs-info

Related: [spec.md §4](../../../spec.md#4-routing-state-and-privacy)、[spec.md §11](../../../spec.md#11-out-of-scope)、[runtime policy §4](../../../skills/jev-auto-router/references/routing-policy.md#4-routing-state-and-send-eligibility)、[runtime policy §11](../../../skills/jev-auto-router/references/routing-policy.md#11-forbidden-additions)、[Issue 12](12-allowlisted-tool-facts.md)、[Issue 24](24-preregister-paired-evaluation.md)。

## Problem

当前 `src/route-plan.ts` 的 `RoutingState` 只有 `step_type`、已知的 `current_model`、`context_size_bucket` 和 `user_turn_facts.request_length_bucket`。`src/index.ts` 从请求头读取有限控制值，并在本地把 user-turn 输入做敏感检查和长度分桶；原始输入继续送往 caller edge，但不会作为 Jev Routing State。`src/jev-adapter.ts` 将该状态和 Candidate Pair IDs 发给 Jev，执行一次 pair Choice；现有契约没有语义复杂度字段或可信的复杂度 producer。

入口收到的 `x-jev-*` 控制信号仍是请求方输入，即使部分字段经过枚举、模型目录或布尔值校验，也不能据此证明复杂度判断来自独立、认证的 producer。当前仓库没有建立这样的 producer edge，也没有证明某个 header 或请求 payload 能独立于 caller 伪造。

根规范和运行时策略只允许获准的结构化事实；原始指令、文件内容、工具输出、完整会话、凭据和认证材料禁止外发。规范 §11 和策略 §11 还明确排除本地语义分类器、task-kind 表、tier ladder 和第二次 Choice。因此，增加复杂度路由前必须先解决来源和隐私契约，不能把长度桶、请求方自报字段或本地启发式当作语义事实。

## Solution

按以下顺序推进；前一步未满足时不得进入下一步。

1. **证明独立、认证的 producer。** 由维护者提供可核对的 producer 身份、认证方式、允许的 endpoint/版本、调用关联和非递归边界。说明它在可信本地边界内究竟观察什么有任务含义的事实、如何从中产生复杂度信号，以及为何同样长度但难度不同的任务不会被迫得到相同判断。证明复杂度信号不能由 caller 提供的 header、请求 body 或工具结果直接注入或改写；记录 producer 未知、认证失败、版本漂移和响应不可验证时的处理。没有这项证明，保持 `needs-info`，不改运行时。
2. **选择非内容型来源并核对隐私适配。** 维护者先决定信号来自哪个获准的结构化观察源，冻结字段含义、来源、大小、时效和关联方式。把该契约逐项映射到现有 allowlist；原始 prompt、文件、工具文本、完整会话和凭据继续禁止外发，截断也不构成授权。若用户选择发送脱敏摘要或原文，必须作为超出现有规则的单独政策变更审查，不能由本票默许。若选定来源超出现有隐私政策，先取得用户对该范围的明确批准，再另行修改规范/策略；在来源选择和政策适配未完成前不得实现。
3. **冻结版本化枚举和拒绝语义。** 在实现前冻结复杂度 enum 的精确版本和值域，以及缺失、`UNKNOWN`、畸形、过期、版本不匹配、认证失败和 producer 不可达时的行为。未知值不能静默映射到某一等级，不能从长度、confidence 或模型自报推断；是否进入 Jev、记录何种 reason、何时使用 Fallback Baseline 必须是可测试的固定契约。producer/Jev confidence 单独记录，绝不能当作质量分数或完成证据。
4. **仅在前三项通过后实现。** 实现范围才可以包括必要的 Routing State/schema、producer 适配、Guard、记录和行为测试，并保持单次版本化 Choice、allowlisted state、仅修改 `model`/`reasoning.effort` 的 Apply 及现有回退边界。不得新增本地语义分类器、task-kind 表、第二个 selector 或绕过认证 caller edge。生产 Active 和生产阈值继续关闭，直到下一步评估完成。
5. **实现前冻结评估计划，再运行真实结果。** 预注册 producer/source/schema 版本、Candidate Pairs、Fallback Baseline、Jev/policy/caller-edge/release 绑定、任务与仓库快照、标签方法、阈值、缺失值规则和分析顺序。样本至少包含：
   - 与路由执行者和 Jev 分离的人工任务复杂度标签，说明标注时点、盲法/偏倚和争议处理；样本必须覆盖短而难、长而易及长度接近但复杂度不同的任务；
   - 实际下游结果，包括完成/接受、独立质量、返工、失败、接管、验证和必要的交付证据；
   - 预先定义的 under-route 与 over-route 判定，并按复杂度标签、实际结果和候选 pair 报告；
   - 质量、完整成本和端到端/JeV 延迟，保留 Jev、模型调用、缓存、重试、失败和验证开销；
   - 未知信号、缺失标签/结果、未覆盖复杂度枚举、无可比候选和其他 missing coverage，均单独计数并保持 `UNKNOWN`。

   置信度是路由观测字段，质量来自独立验收和交付结果；两者必须分列。评估结果只能回答预注册的候选和阈值是否满足，不能声称全局最优。

6. **Issue 24 的时序。** 不修改现有 Issue 24，也不把它的空白/合成框架当作本票的来源或结果。只有 producer/source/privacy/schema 已实现并冻结、且实现通过行为验证后，才允许把本票的复杂度标签和结果字段接入 Issue 24 的未来评估框架。

## Stop rules

只要缺少认证 producer 证明、来源选择、现有隐私政策适配或独立下游结果，立即停止在本票范围外扩展：不得修改 runtime、`spec.md`、runtime policy、Routing State/Choice schema、本地 classifier 或生产阈值；不得开启 Active、生成 allowlist 或声称复杂度路由最优。任何未知、缺失或无法独立核对的结果都保持缺口，不得补零、反填或改写成 PASS。

## Acceptance criteria

- [ ] 有独立于 caller header/body 的认证 producer 证明、allowlist、版本和非递归边界；伪造请求不能制造可接受的复杂度信号。
- [ ] producer 的任务含义来源和生成方法可审查；在长度相近而人工复杂度标签不同的任务上，信号具有可测的区分能力，不能由长度或自报难度独自决定。
- [ ] 维护者已选择非内容型来源，并证明其字段、大小、时效和关联符合现有隐私政策；超出政策的来源有单独的用户批准记录。
- [ ] 复杂度 enum/schema 版本、精确值域、`UNKNOWN`、缺失、畸形、漂移、认证失败和拒绝/回退行为均已冻结并可测试。
- [ ] 只有上述门禁完成后才有 runtime/schema/producer 适配实现；实现保留现有单次 Choice、Guard、Apply、认证 edge 和回退不变量。
- [ ] 运行前已有可核对的评估计划，含独立人工复杂度标签、实际下游结果、under/over-route、质量、完整成本、延迟和 missing coverage；confidence 与质量分开。
- [ ] 评估没有把缺失数据当零，也没有从 Jev confidence、模型自报或模型 mix 宣称质量、节省或最优；Issue 24 未在契约冻结前被修改或复用。

## Boundaries and verification

本票当前只新增本地 tracker 文档和 map 注册，不改 `src/`、根 `spec.md`、runtime policy、schema、classifier、生产配置或 Issue 24。维护者补齐前置输入后，按门禁逐项留下脱敏版本/摘要和独立证据；实现阶段再补 HTTP-chain、隐私、伪造 producer、未知/拒绝路径测试，并运行 `npm test`、`npm run typecheck` 和 `git diff --check`。本票未完成前不应标记 `resolved`。
