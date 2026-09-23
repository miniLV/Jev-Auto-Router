# 02 — 打通 `jev/auto` 的固定基线路径

**What to build:** 用户选择 `jev/auto` 后，一次原生 Responses Model Call 能通过本地路由入口和已认证的 caller edge 由固定组合完成，并及时返回给 Codex；手动选择真实模型仍走正常通道。

Blocked by: 01 — 统一方案 A 的权威路由契约。

Status: ready-for-agent

- [ ] 完整 HTTP 请求链路证明：仅 `jev/auto` 进入自动路由，真实模型请求不被 Jev Router 改写；固定组合是当前 caller edge 已实测可请求的 `(model, effort)` 对，转发不会递归回到虚拟模型。
- [ ] caller edge 完成上游认证；Jev Router 不接收、保存或记录 Codex 会话凭据，Jev 密钥与上游认证分离。
- [ ] SSE 的上游状态、相关头部、事件顺序和内容被透明传递，首个客户端增量早于上游完成；非流式 JSON 保留上游状态、相关头部和完整响应内容。
- [ ] 客户端取消或断开连接会终止进行中的上游请求，不启动替代请求，并记录取消结果。
