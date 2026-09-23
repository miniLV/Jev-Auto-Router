# 19 — 校验 Active 报告引用的实际证据资产

**What to build:** 正式 Active 门禁只能接受由可核验的配对输入和脱敏证据资产算出的合格报告；手改 `PASS`、伪造 hash 形状的引用或丢失资产不能批准候选。

Type: task

Blocked by: 17 — Jev 策略参数绑定；18 — 候选目录身份派生。

Blocks: 07 — 配对评估 Main Task 质量与完整成本。

Status: resolved

Related: `src/active-evidence.ts`；`bench/paired-evaluation.ts` 与 `bench/evaluate.ts`；`bench/README.md`。

## Problem

目前 Active 启动主要信任 JSON 中的 `pairing_gate`、`active_eligible`、各项 `PASS` 和 64 位十六进制摘要；证据引用只检查 `kind:sha256:<hex>` 格式，不读取资产、重算摘要或验证其与这次评估的关联。因此本地手改报告可宣称未经测试的候选合格。

## Solution

1. 定义一份脱敏评估 bundle 与证据清单：每个引用映射到受限定目录内的相对文件、内容 SHA-256、证据种类、运行/候选/配置关联 ID。拒绝绝对路径、`..` 越界、重复 ID、缺失文件和摘要不符。引用不得指向提示词、原始工具输出或凭据。
2. 发布报告时保存生成它的 bundle 摘要；正式 Active 校验读取 bundle，重新运行现有纯评估逻辑或等价确定性验证，核对候选 PASS、配对结果、质量与成本门槛、完整配置绑定。不要只检查报告字段格式，也不要把 `PASS` 字符串当独立证据。
3. 检查传输、取消、Shadow、质量等证据资产的预期 schema 和关联 ID；“正确 hash、错误候选/edge/版本”同样拒绝。人工独立评审仍需在资产上进行，自动校验不能伪称判断交付质量本身。
4. 将失败原因写成明确的启动错误，但不输出资产原文。覆盖合法 bundle、缺失资产、改动字节、替换候选、篡改报告 PASS、路径穿越和旧报告版本。

## Acceptance criteria

- [x] 缺失、篡改、错配或仅有 hash 形状的证据引用不能启动正式 Active。
- [x] 候选决定由保存的配对输入重新计算/核对，修改报告中的 PASS 或 allowlist 无法独立放行。
- [x] 证据文件受路径约束且脱敏；错误消息不泄露原始内容。
- [x] 完整合法资产和精确运行绑定可以通过，且报告可由另一维护者独立复核。

## Boundaries and verification

不要引入远程发布控制系统，也不要把自动格式校验当作人工质量评审。运行 Active 证据、评估器和启动测试，再运行 `npm test`、`npm run typecheck`。

## Answer

- 正式报告升至 `jev-paired-evaluation-report-v2`，由 `bench:evaluate -- <bundle> --report <report>` 写入同目录相对 bundle 路径和 bundle 原始字节 SHA-256。Active 从报告目录读取 bundle，再从 bundle 目录读取资产；两个层级都拒绝绝对路径、路径穿越和目录外 symlink。清单强制唯一 ID、path、ref、受控 kind/schema、release、候选、配置摘要及关联 ID；资产字节必须同时匹配 `sha256` 与 `kind:sha256:<hex>`。
- Active 对保存的 config、冻结 plan、paired tasks 和候选评估重新执行 `pairedComparison()`，再比较完整报告。配置 digest 绑定 edge、Jev、policy、question schema、价格和 catalog；候选与证据关联逐项重算。手改 PASS/allowlist、缺失/改动资产、旧报告、未知 schema、错候选、过期或错误运行绑定均不能单独放行。当前目录证明仍在生成评估结果时按当前有效性重检，不比较偶然报告时间。
- 质量基线资产可被多个候选共享，但必须绑定同一 `run:<task>:baseline` 关联及相同事实；同 ref 被用于不同事实时拒绝。Active 允许清单外不合格候选没有 gate/quality refs，要求清单内每个候选的全部资产。Transport schema 要求观测模型等于请求候选；观测 effort 只能是请求值或显式 `UNKNOWN`。
- 保持 Issue 08 的受控本机入口和 `EVALUATION_ONLY` 生产拒绝；该入口生成的采证文件不会自动变为生产报告。已测 CLI 实际生成相对路径与原字节摘要，并由正式 validator 接受。验证通过：Issue 19 定向测试 14/14、启动目录绑定测试 1/1、`npm test` 210/210、`npm run typecheck`、`git diff --check`。
- **证据缺口：** SHA-256 证明文件字节与评估输入的绑定，不证明资产来源真实性；结构校验也不执行人工质量评审。定向通过用例是合成数据，不是真实 caller-edge、Jev、Codex 会话或独立评审证据；这些仍需 Issue 21/22/25 提供。
