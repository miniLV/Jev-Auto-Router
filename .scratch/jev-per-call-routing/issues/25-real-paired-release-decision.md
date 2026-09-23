# 25 — 运行真实配对质量/成本评估并给出发布决定

**What to build:** 对预注册的同一批 Main Task 实际执行固定基线、Shadow 和受控 Active，按 Candidate Pair 报告独立质量、返工、延迟及完整成本，并作出可复核的放行或不放行决定。

Blocked by: 06 — 可重跑真实 Codex 证据；15 — Shadow 失败归因；19 — Active 证据资产校验；20 — 配对指标统一；24 — 预注册评估计划。

Blocks: 07 — 配对评估 Main Task 质量与完整成本。

Status: ready-for-agent

Related: 原 Issue 07 第 2–4 项；`bench/evaluate.ts`；`docs/sdd/benchmark.md`；`bench/README.md`。

## Problem

目前有评估器与合成测试，但没有真实配对 Main Task 结果、独立交付质量证据和可审计的候选放行清单。仅凭历史 token 重计价、模拟记录或格式正确的 PASS 引用不能宣称节省或开启正式 Active。

## Solution

1. 按 Issue 24 的冻结计划逐任务执行基线、Shadow 和指定 Candidate Pair 的受控 Active；同任务两个配对 arm 使用相同仓库快照、输入摘要、验收标准和声明的缓存条件，记录实际开始时间与随机顺序。
2. 为每个物理调用保存脱敏的请求/观测 pair、Jev 版本、用量与缓存子项；记录所有重试、纠正、验证和 caller-edge 费用。缺少权威用量或价格时，完整成本为 `UNKNOWN`，不得据此计算节省。
3. 独立评审交付 diff、测试和工件，记录完成、质量、返工和关键失败的证据引用；失败/未完成任务仍纳入预注册分母，不因结果不好而剔除。
4. 用 Issue 19 的资产校验与 Issue 20 的汇总规则生成报告；逐候选列出 baseline、Shadow、Active 指标和 transport/cancellation/Shadow/quality/cost 门槛、失败原因及精确版本绑定。
5. 发布一份脱敏决定记录：每个 pair 是否可用于正式 Active、理由、报告/资产摘要、启用配置和通过配置回到 Shadow 或固定基线的演示。没有全部合格证据时决定必须是“不放行”，不得生成假 allowlist。

## Acceptance criteria

- [ ] 所有预注册任务都有完整配对结果或明确缺失/失败原因，质量由独立交付证据支持。
- [ ] 报告按候选与模式展示完成、返工、质量、延迟和全量成本；UNKNOWN 不被置零或用来声称节省。
- [ ] 每个门槛都引用可复核、匹配版本/候选的脱敏资产；不合格组合没有进入正式 Active 清单。
- [ ] 启用与回退步骤可执行，且发布决定没有增加独立部署控制系统。

## Boundaries and verification

若真实 Jev 凭据、认证 caller edge、任务素材或独立评审者缺失，保留本票未完成并报告具体缺口。运行 `npm test`、`npm run typecheck`、配对评估器和证据校验；不要提交凭据、提示词、工具输出或未脱敏记录。
