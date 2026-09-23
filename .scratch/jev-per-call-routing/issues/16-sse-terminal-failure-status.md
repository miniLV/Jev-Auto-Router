# 16 — 把 SSE 的失败终态记录为失败

**What to build:** 上游已经输出后若以 `response.failed` 或明确的不完整终态结束，客户端仍收到原生事件，而调用记录显示失败，不会被记为成功完成或触发改模重放。

Blocked by: None — can start immediately.

Blocks: 05 — Active 故障与取消边界；06 — 真实 Codex 证据。

Status: resolved

Related: `src/proxy.ts` 的 `teeAndObserve()`、`#dispatch()`；`src/index.ts` 的响应流管道。

## Problem

观察器仅识别 `response.completed`，读流正常结束便设置 `terminated: completed`。上游可以返回 HTTP 200、发出若干增量再发 `response.failed`；这时客户端看到失败事件，但 `/decisions` 的 `call_status` 仍为 `ok`。本地 SSE 复现已确认该误判。

## Solution

1. 在不改写 SSE 字节的扫描支路识别成功、失败和不完整终态。`response.failed`、上游明确 `status: failed` 或对应不完整事件应归入失败/不完整结果；正常 EOF 不等于 `response.completed`。
2. 定义终态优先级：客户端取消、上游流错误、明确失败事件、明确完成事件；避免同一调用因多个事件重复记账。若输入矛盾，保留真实事件并标为异常，不推断成功。
3. 更新 `CallRecord` 的最终状态，但保持请求模型、已收到的输出事件及工具调用 ID 不变。失败后不得请求第二个上游或重放工具动作。
4. HTTP 测试用受控 caller edge 发送“增量 → `response.failed` → EOF”、正常完成、不完整结束和中途断流；断言客户端原样收到事件与顺序、遥测一次记录正确状态和请求次数。

## Acceptance criteria

- [x] `response.failed` 后调用不为 `ok/completed`，客户端看见原始失败事件。
- [x] 正常 `response.completed` 仍记成功；无终态的异常 EOF 不伪装成成功。
- [x] 任何输出后失败都不触发模型切换、重放或第二次上游请求。

## Boundaries and verification

不为“补偿”失败而生成新的 SSE 事件或业务重试。运行扫描器和完整 HTTP 测试，再运行 `npm test`、`npm run typecheck`。

## Answer

The shared SSE observer now records `response.failed`, `response.incomplete`, nested failed/incomplete statuses, and EOF without a valid `response.completed` as `error`. Explicit failure outranks completion, while a client abort remains `cancelled`; non-success terminal outcomes leave `response_completed_at` and `upstream_completion_ms` as `UNKNOWN`. Upstream event bytes and order are passed through unchanged. No retry path was added.

Verification passed: scanner tests (33/33), targeted HTTP terminal and mid-stream failure tests (2/2), `npm test` (183/183), `npm run typecheck`, and `git diff --check`.

Evidence gap: the HTTP tests use local Jev and caller-edge stubs. They do not establish terminal behavior in a live authenticated caller-edge or real Codex session; that evidence remains with Issues 21/22.
