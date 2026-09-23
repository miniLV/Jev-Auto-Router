# 09 — 让正式入口的取消信号到达上游

**What to build:** Codex 取消或断开 `jev/auto` 调用时，正在等待的 Jev 或正在生成的真实上游立即收到取消；该调用只记为 cancelled，不产生固定基线重放。

Blocked by: None — can start immediately.

Blocks: 02 — 固定基线路径；05 — Active 故障与取消边界；06 — 真实 Codex 证据。

Status: resolved

Related: `src/index.ts` 的 `main()`、`fetchUpstream()`、`createRouterServer()`；`src/proxy.ts` 的 `#dispatch()`；`test/http-chain.test.ts`。

## Problem

`#dispatch()` 已将 `AbortSignal` 传给抽象上游，但正式 `main()` 中的包装函数只接收请求参数，丢弃信号。测试夹具使用了另一套正确接线，因此现有绿色测试掩盖了生产故障。

## Solution

1. 让正式启动构造的上游函数原样接收并转交 `(request, signal)`，不改路由决策、请求体或 fallback 规则。
2. 检查连接关闭、已发响应头后断开和 Jev 等待中取消的路径。区分客户端取消与上游自身失败；上游 abort 不能被转化为一次新的 baseline 请求。
3. 将 HTTP 测试的启动方式与正式组装函数共用一处接线，或增加覆盖 `main()` 组装路径的测试，避免未来测试夹具再次比生产路径多传一个参数。
4. 用可控的慢 Jev 和慢 caller edge 证明：取消后各自的 abort 事件被观察到；每个 Model Call 的上游请求数为 0 或 1；`/decisions` 的最终状态为 `cancelled`，而不是 `ok`。

## Acceptance criteria

- [x] 正式入口上游 fetch 收到非空、与客户端请求同源的取消信号。
- [x] 断开连接后，上游工作停止；没有回退、重放或第二个上游请求。
- [x] Jev 等待中取消不会发上游请求；已开始生成时取消将记录一次 cancelled。
- [x] 回归测试会在把正式接线改回“只传 request”时失败。

## Answer

新增 `createProductionProxy()` 作为正式上游接线，并由 `main()` 与 HTTP
链路测试共用。上游函数将同一个客户端取消 `AbortSignal` 传给
`fetchUpstream()`。HTTP stub 现在观测 Jev 和 caller edge 连接关闭。

定向 HTTP 回归先在漏传信号的生产组装下复现两项失败：上游调用最终记成
`ok`，且 Jev 仍在处理请求。修复后，Jev 等待中取消不发 caller-edge 请求；
上游生成中取消会中止唯一一次 edge 请求，`/decisions` 最终记为
`cancelled`，没有 baseline 重放。

验证：`node --test dist/test/http-chain.test.js`（17/17）、`npm test`
（146/146）、`npm run typecheck` 和 `git diff --check` 均通过。

证据边界：目前验证使用本地 Jev 与 caller-edge HTTP stub。真实认证 caller
edge 的独立取消证据尚未取得，仍由 Issue 22 负责；本票不作为该实机证据。

## Boundaries and verification

不要通过缩短超时或销毁客户端响应来假装上游已停止。运行定向 HTTP 测试、`npm test` 和 `npm run typecheck`；真实 caller edge 的独立取消证据仍归 Issue 06。
