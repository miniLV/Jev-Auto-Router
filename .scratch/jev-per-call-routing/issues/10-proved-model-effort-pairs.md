# 10 — 只接纳当前 caller edge 已实测可请求的模型与 effort 组合

**What to build:** 固定基线和 Jev Candidate Pair 都有当前认证入口的实际请求成功证据；仅出现在 `/models` 列表的组合不能进入候选，也不能被宣称为可用。

Blocked by: None — can start immediately.

Blocks: 02 — 固定基线路径；03 — Shadow Jev Choice；06 — 真实 Codex 证据；18 — 候选目录身份绑定。

Status: resolved

Related: `spec.md` §3、§5；`skills/jev-auto-router/references/routing-policy.md` §5；`src/discovery.ts`、`src/catalog.ts`、`src/index.ts`。

## Problem

目前 `/models` 的 `supported_efforts` 一经读取就被标为 `requestable: true`。列表表示发现能力，不能证明当前 caller edge 实际接受这一精确 `(model, effort)` 请求；基线也因此可能在发起调用后才失败。

## Solution

1. 将“目录发现”与“请求成功证明”分开。目录继续用于展示/能力交集，但 `requestable` 只能来自同一 caller edge 的受控实测。优先使用可审计的证明清单，而非服务启动时自动发送付费探针。
2. 证明清单逐项记录精确 model、请求 effort、caller-edge 配置 ID、请求时间、HTTP/Responses 结果、观测 model（缺失保留 `UNKNOWN`）和脱敏原始证据摘要。只有真实请求通过且没有模型错配的项可标为已证明；effort 无权威回报时记录证据缺口，不伪称已观测 effort。
3. 启动时按当前 caller-edge ID 将证明清单与 `/models` 求交集；不匹配、失效、失败、仅列出未实测的 pair 都排除。基线缺证明时在自动请求发上游前明确失败，Active 候选缺证明时拒绝启动。不得退回到任意首个可见模型。
4. 在 `/health` 或等价只读记录中区分 `discovered` 与 `proved`，给出目录/证明版本或摘要，不暴露认证材料或测试输入。
5. 用一个“列表包含但请求被拒绝”的 caller-edge 替身验证排除行为；再覆盖成功、换 edge ID、过期/缺失证明、基线不可用和候选集合变化。

## Acceptance criteria

- [x] `/models` 单独列出的 pair 不会被当作固定基线或 Jev 候选。
- [x] 成功实测证明只对精确 pair 和对应 caller-edge 配置生效；边界变化会使旧证明失效。
- [x] 无已证明基线时明确失败；无候选时不向 Jev 请求 Choice，按规范处理 fallback。
- [x] 测试证明“不支持 effort 的列表项”无法到达实际 Apply，且未知观测不被补写为成功。

## Boundaries and verification

不在常规启动时对所有模型做昂贵探测，不把 UI 模型目录或配置文件中的布尔值当证据。运行目录、配置、HTTP 行为测试，再运行 `npm test` 和 `npm run typecheck`。真实 pair 的证明资产仍需人工审核。

## Answer

- 已新增 `JEV_PAIR_PROOFS_FILE` 的严格、脱敏证明清单解析。`/models` 只提供发现能力；只有精确 model/effort、当前 caller-edge ID、有效时间窗、成功 HTTP/Responses 完成状态以及匹配的观测 model 才能证明 pair。无法权威观测 effort 时保留 `UNKNOWN` 并记录证据缺口。清单不接受请求体、提示词、凭据或任意证据文本。
- 生产启动只读取 `/models` 和本地证明清单，不发送付费探针。基线证明缺失或过期时自动请求在 Jev Choice 前 fail closed；Choice 等待期间重新检查基线和候选有效期，候选过期不会进入 Apply。`/health` 与路由共用当前 pair / 基线解析规则，分别显示 discovered 与 proved 状态。
- `fetchModelList` 作为现有 caller-edge `/models` 适配器导出供 Issue 08 本机受控评估入口复用；仅开放该共享接口，不增加或改变生产目录发现流程。
- 验证通过：定向 discovery/catalog/config/HTTP/proxy 测试 74/74，`npm test` 156/156，`npm run typecheck` 和 `git diff --check` 通过。
- **外部证据缺口：** 当前没有真实 caller-edge pair 证明资产。测试 fixture 是显式合成数据，仅验证机制；不得视作实机证据。部署前仍需人工审核真实脱敏证据并提供有效清单。
