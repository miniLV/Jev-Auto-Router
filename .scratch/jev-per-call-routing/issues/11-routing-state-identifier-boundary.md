# 11 — 从 Jev Routing State 移除未经批准的任务标识符

**What to build:** 维护者仍能在本地按任务关联调用记录，但 Jev 只收到规范白名单中的事实，不能收到客户端任意填写的 task/session ID。

Blocked by: None — can start immediately.

Blocks: 03 — Shadow Jev Choice；06 — 真实 Codex 证据。

Status: resolved

Related: `skills/jev-auto-router/references/routing-policy.md` §4；`src/index.ts` 的 `x-jev-task-id`；`src/route-plan.ts` 的 `RoutingState`；`src/jev-adapter.ts` 的 Choice 载荷。

## Problem

HTTP 头 `x-jev-task-id` 可填入任意字符串，随后作为 `RoutingState.task_id` 原样发送给 Jev。策略白名单不批准 task/session 标识符；`call_index` 也需与白名单逐项核对，不能仅因它在内部类型里就认为可外发。

## Solution

1. 区分本地关联 ID 与 Jev 决策事实。保留任务 ID 用于本地状态、调用计数和脱敏日志；删除 Jev 请求中的 `task_id`，并按策略决定 `call_index` 是否有明确授权，未授权则一并从外发状态移除。
2. 对本地关联头设置长度和字符限制；非法或过长值在入口拒绝，不能用其内容构建 Jev 请求、日志键或无限增长的任务状态。不要为每次请求重新生成不同 ID 而破坏同一工具循环关联。
3. 对 Jev transport 做精确载荷断言：用户提示样式、路径、邮箱、密钥样式的 ID 均不出现；合法 ID 仍可关联连续两次本地记录。
4. 若产品确实需要某种匿名会话信息参与 Choice，应先修订权威策略，定义不可逆、不可跨会话追踪的字段和必要性；本票默认不扩张白名单。

## Acceptance criteria

- [x] 任何客户端 task ID 都不出现在 Jev 请求体或 Routing State 中。
- [x] 合法本地 ID 仍可关联同一会话的后续 Model Call；非法、超长 ID 被明确拒绝或安全地不采用。
- [x] 测试检查整个 Jev 载荷，而非只检查少数敏感词正则。

## Boundaries and verification

不要把原始 ID 换成一个未获批准的稳定哈希继续外发。运行隐私、路由状态与 HTTP 测试，再运行 `npm test`、`npm run typecheck`。

## Answer

`RoutingState` 和它的构造器已移除 `task_id` 与 `call_index`，Jev 请求不再带有本地任务或调用序号。HTTP 入口只保留最多 128 个 ASCII 标识符字符且未命中既有 `looksSensitive()` 检查的本地关联 ID；路径、邮箱、密钥样式 ID、非法字符及超长值均以不回显内容的通用 400 响应拒绝，因此不会进入本地记录或 `/decisions`。没有提供 ID 时仍使用本地 `default` 关联。未生成或发送哈希替代值。

HTTP 全链测试捕获完整 Jev 请求体，覆盖任务描述样式、路径、邮箱、GitHub token、`sk-` 密钥样式、`token:` / `password:` 字段、AWS access key 样式及长度边界，并断言载荷中无 `task_id` / `call_index` 字段或客户端 ID；被拒绝的密钥样式 ID 也不会出现在本地调用记录或 `/decisions` 中。A→B 工具循环测试使用同一合法 ID 连续发起两次调用，证明本地调用记录仍归属同一任务，`call_index` 为 0 和 1。

验证通过：定向隐私/路由状态/HTTP 测试（56/56）、`npm test`（152/152）、`npm run typecheck`、`git diff --check`。

证据缺口：载荷捕获使用本地 Jev HTTP stub；本票未连接真实 Jev 服务。真实 Codex 工具循环证据仍由 Issue 06 负责。
