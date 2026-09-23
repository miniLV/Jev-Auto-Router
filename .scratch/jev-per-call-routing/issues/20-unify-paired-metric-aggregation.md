# 20 — 统一配对评估的指标汇总路径

**What to build:** 同一批 Main Task 运行只被计入一次，并以相同规则生成整体报告和逐 Candidate Pair 的质量、返工、延迟与完整成本指标。

Blocked by: None — can start immediately.

Blocks: 07 — 配对评估 Main Task 质量与完整成本。

Status: resolved

Related: `bench/paired-evaluation.ts` 中 `decideActiveCandidates()` 与 `pairedComparison()` 的重复汇总逻辑。

## Problem

逐候选决定和整体报告分别计算完成率、验收率、质量分数、返工与接管等相同指标。以后增补一个质量门槛或改变 UNKNOWN 规则时，两处可能分歧。此票是低优先级维护性修复，不代表当前已发现重复计费错误。

## Solution

1. 在现有评估器内部提取一次可复用的纯汇总函数，输入一组已校验的运行记录，输出完成、验收、质量、返工、接管、耗时和成本的同一统计结构；整体与逐候选都调用它。
2. 保持“物理调用逐行计费”：Jev、上游、允许的重试、纠正和验证各计一次；缓存子集与 reasoning 子集不重复收费；任一必要用量未知使总费用为 `UNKNOWN`。
3. 不改变已有报告字段、阈值和候选资格语义，除非测试证明旧值确实错误；若发现错误，单列可解释的修正与样例。
4. 用不对称的三任务样例（成功、失败、未知成本、不同重试数）验证整体与逐候选统计来自相同记录，任何物理调用只贡献一次，UNKNOWN 不被置零。

## Acceptance criteria

- [x] 完成率、质量、返工、耗时与成本只有一处共享计算规则，两个报告视图保持一致。
- [x] 测试能识别重复计费、遗漏 Jev/edge 开销或把 UNKNOWN 算零的回归。
- [x] 公开报告结构与现有合格 fixture 的结果保持兼容，或清楚记录必要纠错。

## Boundaries and verification

不要顺手重写整个 benchmark、引入通用统计框架或改变放行标准。运行评估器定向测试、`npm test`、`npm run typecheck`。

## Answer

- `pairedComparison()`、`decideActiveCandidates()` 和候选 Shadow 报告共用评估器内部的纯 `summarizeRuns()` 汇总完成、验收、质量、返工、接管、延迟、调用数及成本；成本比率和门槛也由同一 helper 计算。公开报告字段、阈值和资格语义未变。
- 新增不对称三任务行为样例，核对整体与候选统计一致，重试及 Jev/edge 费用分别可见；单次未知调用用量使完整成本保持 `UNKNOWN`。既有全量已知费用样例继续校验 Jev 进入总成本，缓存及 reasoning 仍作为用量组成而非额外物理调用计费。
- 验证通过：定向 benchmark 测试 14/14；`npm test` 147/147；`npm run typecheck`；`git diff --check`。
- 外部证据：此维护票不依赖生产数据；行为样例是合成 fixture，因此不构成真实任务效果或节省证明，也未据此提出节省结论。
