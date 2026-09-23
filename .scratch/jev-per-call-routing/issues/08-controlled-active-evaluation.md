# 08 — 打通受控 Active 评估入口，解除证据依赖环

**What to build:** 维护者可以在本机用真实 Codex 会话运行预先限定候选组合的 Active 评估，取得 Issue 06/07 所需证据；正式 `npm start` 的 Active 入口仍必须先通过发布报告校验。

Blocked by: None — can start immediately.

Blocks: 06 — 补齐可重跑的真实 Codex 证据；07 — 配对评估 Main Task 质量与完整成本。

Status: ready-for-human

Related: 06、07；`spec.md` §9–10；`docs/adr/0017-per-call-responses-routing.md`；`src/index.ts` 的启动校验；`bench/paired-evaluation.ts` 的 Active 配对要求。

## Problem

正式 Active 启动要求 Issue 07 的合格配对报告；Issue 07 的配对报告又要求实际 Active 运行，而 Issue 07 被 Issue 06 的真实 A→B→A 证据阻塞。现有单元测试绕开正式启动校验直接构造 `ResponsesProxy`，不能作为真实 Codex 运行方案。用伪造 PASS 报告启动会破坏证据门槛。

## Solution

1. 在产品规范和 ADR 中明确区分**仅供采证的本机评估运行**与**正式发布的 Active 运行**。前者可以执行真实逐调用选路，但不能生成“已获准生产 Active”的结论；后者继续要求 Issue 07 报告。记录评估的入口、约束、输出和退出方式。
2. 构建 `bench/` 下的**独立本机评估程序**，复用当前 `ResponsesProxy`、HTTP Server、Jev transport 和 caller-edge 适配器。它不由正式 `main()` 调用，也不在正式入口增加任何环境变量、普通配置或请求头可触发的“跳过证据校验”分支。若复用需要导出已有的小函数，可以导出；避免复制整套路由器。
3. 评估启动前读取已冻结的任务计划及精确候选清单，检查本机回环监听、显式评估标识、caller-edge 标识、固定基线、Jev/策略/schema 版本、候选目录身份和组合可请求性。缺任一项即拒绝启动；不允许候选全集自动放宽。
4. 为每次评估写入独立的脱敏运行清单：计划摘要、进程/代码版本、配置标识、启动时间、输出证据位置及“EVALUATION_ONLY”标记。评估日志和报告不得被 `JEV_ACTIVE_EVIDENCE_FILE` 当作发布 PASS 报告接受。
5. 给出可照做的本机启动、Codex 指向该入口、停止与清理步骤，并说明没有真实 Jev 凭据或认证 caller edge 时只能验证启动拒绝和替身链路，不能勾选实机验收。

## Acceptance criteria

- [ ] 有一个明确的本机评估入口能跑真实 A→B→A Model Call；正式 `npm start` 在没有合格发布报告时仍拒绝 Active。
- [x] 评估入口只监听回环地址，必须显式提供冻结计划、精确候选和版本绑定；普通请求头不能切换为评估运行。
- [x] 测试证明正式生产请求和配置不能到达评估专用入口或绕过发布报告门禁。
- [x] 本地可判定的冻结计划/候选/入口错误在 caller-edge GET `/models` 前失败；实时目录漂移必须先经只读 GET `/models` 发现，并在 Jev Choice/Responses 推理前拒绝。测试覆盖拒绝和允许路径。
- [x] 文档解释评估记录如何供 06/07 使用，以及它为什么不能直接批准生产 Active。

## Boundaries and verification

不要删除正式 Active 的报告门禁，不要制造默认候选或把合成测试标为实机证据。使用 `node:test` 对启动入口做行为测试；完成后运行 `npm test` 与 `npm run typecheck`。只有真实会话记录满足 06/07 的要求时，才关闭对应原 issue。

## Answer

新增 `npm run bench:active-evaluation`，从 `bench/controlled-active.ts` 启动独立的 loopback-only 评估进程，复用生产 Responses proxy、HTTP handler、Jev transport、caller-edge adapter、`parsePairProofManifest`、`ModelDiscovery.discover`、`resolveBaseline` 和 `deriveCandidateCatalogId`。启动前校验显式 `EVALUATION_ONLY`、工作树 revision/clean 状态、冻结任务及 task ID、运行 schema/版本/策略、精确 baseline/candidate、proof manifest、脱敏 catalog snapshot、派生 catalog ID、edge/path digest、回环端口和 checkout 外的输出目录。只允许冻结计划中的 task ID；request headers 不能放宽候选或进入评估模式。

每次运行写入权限受限且脱敏的 `manifest.json` 和 `observations.json`，均带 `EVALUATION_ONLY`。生产 Active evidence validator 明确拒绝该分类，正式入口仍由合格 paired report 控制。文档已补充冻结字段、启动、Codex 指向、停止、证据移交和清理流程。

验证通过：定向受控启动测试 16/16，`npm test` 205/205，`npm run typecheck` 和 `git diff --check` 均通过。启动拒绝路径与允许的 HTTP 链路使用本机 stub；stub 仅验证机制，不代表真实 Jev/caller-edge 证据。

**未完成的实机证据：** 目前没有真实 Jev 凭据、认证 caller edge 或真实 Codex A→B→A 会话记录；未声称 PASS，首项验收保持未勾选，Issue 保持 `ready-for-human`。实时 caller-edge 目录变化需通过只读 GET `/models` 才能核对；发现不匹配后，在发送 Jev 或 Responses inference 请求前关闭启动。
