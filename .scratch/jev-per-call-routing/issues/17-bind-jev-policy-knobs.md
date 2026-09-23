# 17 — 将 Jev 信心门槛与截止时间绑定到 Active 证据

**What to build:** 正式 Active 只在当前信心下限和 Jev 热路径截止时间与配对评估时完全一致时启动；改动任一门槛都要求新的 Shadow/评估证据。

Blocked by: None — can start immediately.

Blocks: 06 — 真实 Codex 证据；07 — 配对质量与成本决定。

Status: resolved

Related: `src/index.ts` 的 `JEV_CONFIDENCE_FLOOR`、`JEV_DEADLINE_MS`；`bench/config.ts`、`bench/paired-evaluation.ts`；`src/active-evidence.ts`。

## Problem

运行时允许修改信心下限和截止时间，但评估配置及 Active 启动校验不包含两者。保持同一个 Jev/策略版本但改变门槛，可能改变路由分布、失败率和延迟，而旧报告仍可通过。

## Solution

1. 在冻结的评估配置中记录精确信心下限和毫秒截止时间，并加入报告配置/评估数据摘要。运行时 Active 绑定必须比较这两个值；不匹配、缺失、`NaN`、无穷、越界均在任何请求前拒绝。
2. 让 Shadow 与受控评估入口明确记录实际生效的两项值，便于证据审核。生产执行继续使用同一 `JevPolicy` 对象；不要在报告校验和真正请求间重新从环境读取而造成漂移。
3. 对旧版未含这两项的报告采取 fail closed；提供重新生成报告的迁移说明，不以默认 `0.55/2000` 补填旧证据。
4. 用一个合格报告分别更改信心下限与截止时间，验证 Active 启动拒绝；再验证精确匹配通过、低信心执行一次基线、超时执行一次基线。

## Acceptance criteria

- [x] 报告和运行配置绑定精确两项 Jev 策略参数；改变任一值必须拒绝正式 Active 启动。
- [x] 无效参数或旧报告不能通过默认值隐式补齐。
- [x] 实际路由的低信心/超时行为与报告绑定的配置一致，完整 HTTP 测试覆盖。

## Boundaries and verification

不新增在线调参器或按任务动态门槛。运行配置、评估器、Active 证据和 HTTP 定向测试，再运行 `npm test`、`npm run typecheck`。

## Answer

- Active 现在要求显式提供有限、在范围内的 `JEV_CONFIDENCE_FLOOR` 与 `JEV_DEADLINE_MS`，并与评估报告中的 `configuration.runtimePolicy` 精确相等。生产启动校验和请求执行共用同一份 `JevPolicy` 配置对象。
- 评估摘要覆盖冻结配置、每次 Jev 调用与候选证据绑定；缺失或不匹配会关闭 Active。Shadow 调用记录生效值。迁移说明要求旧报告重新生成，禁止补填默认值。
- 定向 HTTP/启动测试覆盖低信心与 Jev 超时各一次回退到基线、参数/报告不匹配启动拒绝；配置测试覆盖缺失、非数值、NaN、无穷与越界值。
- 验证通过：`npm test`（182 项）、`npm run typecheck`、`git diff --check`。
- 此处验证使用本地合成 Jev 和 caller-edge stub；真实 Jev 凭据与生产 caller-edge 证据仍不可用，未据此宣称真实运行 PASS。
