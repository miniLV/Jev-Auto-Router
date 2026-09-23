# 13 — 保持压缩响应的头部与实际字节一致

**What to build:** Codex 收到的 SSE 或 JSON 响应不会因代理解压与头部不匹配而再次解压失败；上游状态、可保留的头部和事件内容仍按原顺序到达。

Blocked by: None — can start immediately.

Blocks: 02 — 固定基线路径；06 — 真实 Codex 证据。

Status: resolved

Related: `src/index.ts` 的 `fetchUpstream()`、`HOP_BY_HOP`、响应头转发；Issue 02 的 SSE/JSON 验收。

## Problem

Node `fetch` 会自动解压 gzip 响应体，但 `fetchUpstream()` 仍复制原 `content-encoding: gzip`。本地复现得到 `gzip` 头和明文 JSON；客户端会按错误头部再次解压。当前代码只在客户端写头前删掉 `content-length`，没有处理编码头。

## Solution

1. 明确当前 fetch 适配器交给下游的是**已解码字节**还是原始压缩字节。优先保留标准 fetch 的解码行为，并在响应边界移除与原字节长度/编码相关的 `content-encoding`、`content-length`；保留状态、内容类型和仍有效的相关头部。
2. 对 `Vary`、缓存/实体校验相关头部做同一语义检查：只有在变换后仍准确的头才能继续转发。不要笼统删除所有上游头，也不要为了“透明”二次压缩 SSE。
3. 用真实本地 HTTP caller-edge 替身返回 gzip JSON 和 gzip SSE；从代理客户端解码一次后得到原本 JSON 或逐事件顺序，且响应头不再错误声明 gzip 或压缩前长度。
4. 保留普通未压缩 SSE 的逐增量转发：首个事件必须早于完成事件与上游连接关闭到达；观测扫描不能缓冲整个响应后才输出。

## Acceptance criteria

- [x] gzip JSON 和 gzip SSE 的客户端可见头部与实际字节一致，状态及有效头部保留。
- [x] SSE 事件顺序、内容和提前输出行为未回归；非流式 JSON 完整且无重复解压。
- [x] 未压缩响应沿现有路径工作；测试会在重新转发旧 `content-encoding` 时失败。

## Boundaries and verification

不改变路由、模型选择或认证职责。运行完整 HTTP 链路定向测试、`npm test`、`npm run typecheck`。

## Answer

`fetchUpstream()` 依据标准 `fetch` 已解码的已知内容编码，移除描述压缩表示的编码、长度、范围、摘要和 ETag 头；`Vary` 去掉 `Accept-Encoding` 后保留其他字段，状态、内容类型、缓存策略、`Last-Modified` 和自定义头仍转发。未知编码不会触发这些头部改写。

新增真实本地 HTTP caller-edge 替身测试覆盖 gzip JSON 单次解码，以及 gzip SSE 的状态、头部、事件顺序和首增量提前输出。既有未压缩 SSE 提前输出测试继续通过。未改变路由或认证。

验证：定向 `http-chain` 测试通过；`npm test` 通过（174/174）；`npm run typecheck`、`git diff --check` 通过。真实 Codex/caller-edge 证据仍由 Issue 21 负责。
