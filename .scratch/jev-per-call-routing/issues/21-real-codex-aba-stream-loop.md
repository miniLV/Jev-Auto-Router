# 21 — 归档真实 Codex A→B→A 工具与流式会话

**What to build:** 另一位维护者按记录的命令和配置标识重跑同一个真实 Codex 工具循环，并从脱敏 HTTP 记录确认三次实际调用为 `gpt-5.5 → gpt-5.6-sol → gpt-5.5`，工具结果延续且首个 SSE 增量先于完成。

Blocked by: 08 — 受控 Active 评估入口；09 — 正式取消链路；10 — 已证明可请求组合；11 — 任务标识隐私；12 — 工具事实白名单；13 — 压缩响应保真；14 — Jev 实际版本；16 — SSE 失败终态；17 — Jev 参数绑定；18 — 派生目录身份。

Blocks: 06 — 补齐可重跑的真实 Codex 证据。

Status: ready-for-agent

Related: 原 Issue 06 的第 1、2、4 项；`.scratch/jev-per-call-routing/evidence/aba-transfer-report.md`；`bench/README.md`。

## Problem

现有 A→B→A 文件是用户报告的摘要，没有可重跑命令、完整版本/配置清单、请求 effort、关联 ID 和原始脱敏记录。HTTP 替身测试不能证明真实 Codex CLI 与真实 caller edge 的兼容性。

## Solution

1. 固定一个无敏感内容的测试仓库快照和任务，记录可重跑命令、Codex CLI/路由器/Jev/caller-edge/策略/schema/候选证明的版本或配置 ID。凭据只从本机安全环境读取；文档只列变量名，不列值。
2. 使用 Issue 08 的本机评估入口及真实认证 caller edge。将三次 Model Call 的同一会话 ID、调用序号、候选 pair ID、请求 model/effort、HTTP 状态、上游权威观测 model/effort、Jev 请求/返回版本、工具调用与下一次工具结果 ID 的相同摘要保存为脱敏表。
3. 为 SSE 保存代理 HTTP 连接上的“首个输出增量”“响应终态”“上游结束”的时间戳与事件顺序；至少一条非流式 JSON 调用独立核对状态、相关头部、响应内容摘要和完成时刻。不要把 `codex exec --json` 是否逐字显示当作代理流式验收。
4. 上游不能权威返回 effort 时，观测列明确写 `UNKNOWN`，同时保留请求 effort 与外部证据缺口；不能从请求或 Jev 提议反填观测列。
5. 将运行清单、命令、脱敏记录和可核验摘要存入本地证据目录，附一个只读核对说明。真实运行条件缺失时保留本票未完成，并明确缺少哪一类外部配置，不用合成记录代替。

## Acceptance criteria

- [ ] 可重跑的真实 Codex CLI 会话产生三次预期上游模型调用，均有请求 effort、响应状态、关联 ID 和实际 model 观测；实际 effort 缺失时为 `UNKNOWN`。
- [ ] 第二、三次请求引用前一轮工具调用的结果 ID 摘要，且原始工具内容未出现在证据中。
- [ ] SSE 的首个输出增量早于完成，JSON 响应一致；时间戳来自 HTTP 链路而非终端显示推断。
- [ ] 另一位维护者可按清单重跑并验证摘要与版本绑定；合成替身结果不会被计为本票通过。

## Boundaries and verification

本票只取得真实传输与工具循环证据；独立取消和压缩后续跑由 22、23 验收。不得保存提示词、文件内容、工具输出、密钥或完整会话凭据。完成前运行 `npm test`、`npm run typecheck` 并核对脱敏文件。
