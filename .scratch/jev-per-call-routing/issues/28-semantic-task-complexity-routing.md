# 28 — 建立可审计的语义任务复杂度信号，再评估复杂度路由

**What to build:** 在用户明确授权的窄范围内，把当前 Responses 请求中的用户问题作为一次 Jev Choice 的输入信号；冻结来源、隐私边界、版本和拒绝语义，并为后续独立复杂度评估留下可核对的预注册计划。长度桶不再作为用户问题信号，也不能直接成为新的生产选模依据。

Type: task

Blocked by: 外部条件 — 真实认证 caller edge、独立下游质量评估和可复核的复杂度标注仍未提供；运行时实现已完成，但这些条件齐备前不能宣称生产 Active 或复杂度路由收益。

Blocks: 后续语义复杂度路由阈值决定；Issue 24 的评估框架只能在本票实现和契约冻结后按预注册计划复用或扩展。

Status: needs-info

Related: [spec.md §4](../../../spec.md#4-routing-state-and-privacy)、[spec.md §11](../../../spec.md#11-out-of-scope)、[runtime policy §4](../../../skills/jev-auto-router/references/routing-policy.md#4-routing-state-and-send-eligibility)、[runtime policy §11](../../../skills/jev-auto-router/references/routing-policy.md#11-forbidden-additions)、[Issue 12](12-allowlisted-tool-facts.md)、[Issue 24](24-preregister-paired-evaluation.md)。

## Problem

此前 `src/route-plan.ts` 只把 user-turn 输入转换为 `request_length_bucket`，这不能区分长度相近但难度不同的问题，也不应继续作为语义复杂度代理。当前实现将用户明确选择的当前问题写入版本化 `RoutingState.question`，由 `src/jev-adapter.ts` 连同 Candidate Pair IDs 发给一次 Jev Choice；它不是本地分类器，也不是第二个 selector。

入口收到的 `x-jev-*` 控制信号仍是请求方输入，不能伪造当前问题的来源或改变提取结果。路由器只从共享 `ResponsesProxy.routeCall` 收到的原生 `request.input` 提取问题；单独提供的 `user_turn` 字段被忽略，不能绕过边界。真实 caller edge 和独立质量结果仍没有在本地 fixture 之外得到证明。

根规范和运行时策略现在只允许这一条窄路径：顶层非空字符串，或数组最后一个 `type:message`、`role:user` 项中的非空字符串/纯 `input_text` 文本片段。历史项、工具、文件、图片、未知或混合内容不进入 Jev；原始会话、文件内容、工具输出、凭据和认证材料继续禁止外发。规范 §11 和策略 §11 仍排除本地语义分类器、task-kind 表、tier ladder 和第二次 Choice。

## Solution

### 已实现的运行时契约

1. `ResponsesProxy.routeCall` 从原生 `request.input` 提取当前问题，支持顶层非空字符串，以及最后一个用户消息中的非空字符串或纯 `input_text` 文本片段；消息的 `id`/`status` 元数据会被忽略。
2. 只有最后一个数组项有资格成为问题。历史、工具、文件、图片、未知或混合内容、空值、畸形值、敏感值和超过 **8 KiB UTF-8** 的问题统一走 `privacy_refusal` 与 Fallback Baseline，原生请求仍完整转发且不截断。
3. `question` 只出现在由原生 user-turn 派生的 Jev 状态中；tool-step 不携带它。`RouteCallInput.user_turn` 仅为兼容旧调用保留并被忽略，不能注入文本。Jev 之外的记录、错误、遥测和 Dashboard 不保存问题原文。
4. `routing-state/3`、`choice-pairs/3` 和 `per-call/2` 绑定这一隐私/Choice 变化；仍保持一次 Choice、确定性 Guard、只修改 `model`/`reasoning.effort` 和现有回退边界。
5. HTTP-chain、代理、路由状态和安全测试覆盖正向字符串/数组路径、元数据、排除历史和工具内容、敏感/混合/未知/畸形/超限拒绝、认证头、原生上游保真和无遥测泄漏。

### 仍待外部条件

真实认证 caller edge、独立于路由执行者和 Jev 的人工复杂度标签、实际下游质量/交付结果，以及完整成本和延迟数据仍未提供。实现通过本地行为测试不等于生产 Active 资格，也不构成质量或节省结论。

### 后续评估预注册（待真实运行前冻结）

比较当前“问题原文输入 Jev”的路径与此前“仅长度桶”的基线；样本必须包含长度接近但人工复杂度不同、短而难和长而易的任务。运行前冻结 caller-edge、Jev、策略、schema、候选对、Fallback Baseline、仓库快照、样本顺序、独立标注方法、under-route/over-route 判定和阈值。由不参与路由执行的标注者记录复杂度标签，并分别收集完成/接受、独立质量、返工、失败/接管、验证证据、模型与 Jev 延迟、完整成本和缓存/重试开销；未知和缺失覆盖单独计数并保留 `UNKNOWN`。不在真实运行前填写标签、结果或 PASS。

Issue 24 暂不修改；只有上述契约已实现并冻结、真实 caller edge 和独立结果可核对后，才把这些字段接入未来的配对评估。

## Stop rules

在真实认证 caller edge、独立下游结果和预注册评估完成前，不得开启生产 Active、调整生产阈值、声称复杂度路由最优或把 Jev confidence 当作质量证据。任何未知、缺失或无法独立核对的结果都保持缺口，不得补零、反填或改写成 PASS；本票继续保持 `needs-info`。

## Acceptance criteria

- [x] 原生 `request.input` 是唯一问题来源；请求方 header/body 不能注入替代问题，旧 `user_turn` 字段不能绕过提取。
- [x] 最后用户消息、元数据忽略、纯 `input_text`、工具/文件/图片/混合/未知拒绝、8 KiB 上限、敏感拒绝和原生回退行为已冻结并可测试。
- [x] `RoutingState`、Choice 和策略版本已升级；实现保留单次 Choice、Guard、Apply、认证 caller edge 和固定基线不变量。
- [x] HTTP-chain 和单元测试覆盖实际 Jev JSON、Jev 认证头、正反路径、上游保真和记录/遥测不泄漏。
- [ ] 真实 caller edge 的认证/非递归证明与独立下游质量结果可核对；本地 fixture 不算该证据。
- [ ] 真实运行前完成预注册并冻结独立复杂度标签、under/over-route、质量、完整成本、延迟、缺失值规则和阈值；不把 confidence 当质量。
- [x] Issue 24 未被提前修改或复用；在外部门禁完成前不生成 PASS、Active 或节省结论。

## Boundaries and verification

本次已修改 `src/`、根 `spec.md`、runtime policy、README/上下文说明、schema 版本和行为测试；未修改 Issue 24、生产 Active 配置或 `dist/`。已运行聚焦测试、类型检查和真实 Jev 接口的合成问题冒烟；后者只证明接口接受新版状态，不证明 Codex 执行质量。由于真实 caller edge 和独立评估仍缺失，Status 保持 `needs-info`，本票不标记 `resolved`。

## Comments

- 2026-09-26 实现复审：双轴 code review 的重复检查、显式纠正问题和常见认证凭据漏检已修复；`npm test` 通过 236 项，`npm run typecheck` 与 `git diff --check` 通过。`npm run bench:jev-smoke` 使用合成问题请求真实固定 Jev，5 个场景中 4 个获得有效 Choice、1 个因低置信度按规则回退；两个不同问题选中同一 pair，因此不能从冒烟结果推断复杂度区分能力或节省。仍需认证 caller edge、独立人工标签及真实下游结果。
