# 18 — 从已验证组合派生候选目录身份

**What to build:** Active 报告所绑定的候选目录 ID 由当前 caller edge 上已证明可请求的精确组合生成；换 edge、增删 effort 或改变可请求性后，旧报告自动失效。

Blocked by: 10 — 只接纳当前 caller edge 已实测可请求的模型与 effort 组合。

Blocks: 06 — 真实 Codex 证据；07 — 配对质量与成本决定。

Status: resolved

Related: `src/discovery.ts` 的 `session_binding_digest`；`src/index.ts` 的 `JEV_CANDIDATE_CATALOG_ID` 与 Active 启动顺序；`src/active-evidence.ts`。

## Problem

当前目录 ID 来自可手填的环境变量；报告先于实际目录发现被校验。即使当前 caller edge 或支持的 effort 已改变，只要填写旧字符串，Active 仍可能通过。现有目录摘要只含模型名和 session/source，不表达已证明的 pair 集合。

## Solution

1. 以 Issue 10 的已证明 pair 集合作权威输入，规范化排序后计算目录摘要。摘要必须绑定 caller-edge 配置 ID、精确 model/effort、证明有效性或版本；不能依赖迭代顺序、临时 session 名称或未证明的列表项。
2. 调整启动顺序：先取得并验证当前目录/证明，再计算 ID，最后与评估报告的目录绑定比较，之后才允许 Active 服务监听。环境变量可以作为额外的预期值，但不能自行定义真实目录 ID。
3. Shadow、受控评估、`/health` 和报告生成使用同一种派生规则。不要让各处复制一套不同的散列序列化方式。
4. 测试目录顺序改变摘要不变；新增/删除 effort、pair 证明失效或 edge ID 改变摘要变化；旧报告在启动时被拒绝。

## Acceptance criteria

- [x] 当前目录 ID 由已验证 pair、各 pair 证明版本和 edge 绑定派生；环境变量只能作预期值。
- [x] Active 校验发生在当前目录发现与证明之后，目录变更使旧证据失效。
- [x] Shadow 启动、评估报告和 `/health` 使用同一确定性目录身份规则。

## Boundaries and verification

不把模型列表顺序、启动时间或随机 session ID 混进稳定目录身份。运行目录、配置、报告和启动测试，再运行 `npm test`、`npm run typecheck`。

## Answer

- `deriveCandidateCatalogId` 从当前仍有效且经验证的精确 pair、每个 pair 的证明版本和 caller-edge ID 派生 `proved-pairs-v1-<sha256>`。pair 规范排序；/models 顺序、proof 项顺序、manifest ID、session 名称和启动时间不参与 ID。Discovery 为每项接受的 pair 记录证明版本摘要；证明过期后它会从当前集合退出。
- 正式启动现在先读取 caller-edge `/models` 与证明清单、验证当前 pair 并派生 ID，再检查 Active 候选和报告，最后才启动监听。`JEV_CANDIDATE_CATALOG_ID` 可省略；若填写，只会作为派生值的预期绑定。Active 报告必须匹配当前派生 ID。`/health` 每次按当前有效证明计算 ID，因此证明到期后仍可显示更新后的目录身份。
- 受控评估输入的 `HarnessConfig` 包含当前脱敏 `candidateCatalog` 快照。报告生成器使用相同 helper 重算目录 ID；缺少快照或手填 ID 不匹配时 pairing gate 为 `FAIL`，报告不会获得 Active 资格。报告结构保持原样，不输出完整 catalog 快照。
- 验证通过：启动顺序、目录/证明身份、顺序稳定性、edge/pair/证明版本/过期变更、旧 Active 报告拒绝及评估缺 catalog/手填 ID 的行为测试；`npm test` 168/168，`npm run typecheck`、`git diff --check` 均通过。
- **外部证据缺口：** 本仓库仍没有真实 caller-edge pair 证明资产。测试中带有清楚标注的合成 fixture 只验证派生和门禁逻辑；没有创建或宣称任何实机证明。
