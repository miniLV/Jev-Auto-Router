# 方案 A：review 后修复与验收路线图

本地图用于派发 [方案 A spec](spec.md) 的后续工作。原 Issue 01–07 保持原文和原状态；新增 Issue 08–25 把 2026-09-23 架构 review 的缺陷与尚缺的真实证据拆成可独立执行的小票。单张票的 `Blocks:` 是对原票或后续票的反向索引；不要只看原 Issue 06/07 文件中的旧 `Blocked by:` 就提前结项。

## 代码与协议修复

| 票 | 交付 | 直接前置 | 回填原验收 |
| --- | --- | --- | --- |
| [08](issues/08-controlled-active-evaluation.md) | 本机专用受控 Active 评估入口，正式门禁不绕过 | 无 | 06、07 |
| [09](issues/09-production-upstream-cancellation.md) | 正式入口的取消传播 | 无 | 02、05、06 |
| [10](issues/10-proved-model-effort-pairs.md) | 当前 caller edge 的精确 pair 实测证明 | 无 | 02、03、06 |
| [11](issues/11-routing-state-identifier-boundary.md) | Jev 状态不含任意任务 ID | 无 | 03、06 |
| [12](issues/12-allowlisted-tool-facts.md) | 不信任伪造的工具事实头 | 无 | 03、06 |
| [13](issues/13-compressed-response-fidelity.md) | 压缩响应头/体一致 | 无 | 02、06 |
| [14](issues/14-jev-resolved-version-gate.md) | 实际 Jev 版本未知时 Active 关闭 | 无 | 03、04、06 |
| [15](issues/15-shadow-failure-attribution.md) | Shadow 的失败原因可统计 | 无 | 03、07 |
| [16](issues/16-sse-terminal-failure-status.md) | 失败 SSE 不记为成功 | 无 | 05、06 |
| [17](issues/17-bind-jev-policy-knobs.md) | Active 绑定信心下限与截止时间 | 无 | 06、07 |
| [18](issues/18-derived-candidate-catalog-identity.md) | 已证明 pair 派生目录 ID | 10 | 06、07 |
| [19](issues/19-verify-active-evidence-artifacts.md) | 核验报告输入与实际证据资产 | 17、18 | 07 |
| [20](issues/20-unify-paired-metric-aggregation.md) | 统一逐候选与总体指标计算 | 无 | 07 |

## 真实证据与发布决定

| 票 | 交付 | 直接前置 | 回填原验收 |
| --- | --- | --- | --- |
| [21](issues/21-real-codex-aba-stream-loop.md) | 可重跑 A→B→A、SSE/JSON、工具结果 ID | 08–14、16–18 | 06 |
| [22](issues/22-real-codex-cancellation-evidence.md) | Jev 与上游的独立实机取消证据 | 08、09–11、16–18 | 06 |
| [23](issues/23-real-compaction-continuation.md) | 真实压缩后同会话续跑证据 | 08、10–12、14、16–18 | 06 |
| [24](issues/24-preregister-paired-evaluation.md) | 配对任务、顺序、评审和门槛预注册 | 无；须先于 25 的第一轮运行 | 07 |
| [25](issues/25-real-paired-release-decision.md) | 真实配对质量/成本与发布决定 | 06、15、19、20、24 | 07 |

Issue 06 只有在 08–14、16–18、21–23 都满足其相关验收后才能关闭；Issue 07 还要有 15、19、20 的实现验收、24 的预注册和 25 的真实结果。08 的评估输出只能用于采证，不能当正式 Active 发布报告。没有真实 Jev 凭据、认证 caller edge、可重跑 Codex 会话或独立质量评审时，相关证据票必须保持未完成。

## 派发与收尾

每次只向一个新上下文派发一张票，先读该票、根目录 `AGENTS.md`、`spec.md` 和唯一运行时策略。按票内验收做最小行为测试，运行适用的 `npm test` 与 `npm run typecheck`，完成一票后按仓库规则作一个聚焦提交；未获得真实证据的进度提交不得把票标为 `resolved`。证据只能保存脱敏摘要和版本/关联 ID，不能保存提示词、工具原文或密钥。历史 `3e51665` 合并了 02–05 进度，这个事实不通过新票改写历史；后续遵守逐票提交。

### 已完成

- [Issue 09](issues/09-production-upstream-cancellation.md)：正式入口与 HTTP 测试共用取消接线；本地 stub 验证 Jev 等待和上游生成中取消、无重放及 `cancelled` 终态。真实 caller-edge 取消证据仍由 Issue 22 提供。
- [Issue 20](issues/20-unify-paired-metric-aggregation.md)：整体、逐候选及 Shadow 指标共用一次运行汇总规则；合成样例验证物理调用计费和 `UNKNOWN` 保留。
- [Issue 15](issues/15-shadow-failure-attribution.md)：Shadow 固定基线的执行原因与 Jev Choice、Guard 结果分列，失败子原因限制为受控枚举；实机 Shadow 证据仍待取得。
- [Issue 11](issues/11-routing-state-identifier-boundary.md)：本地任务 ID 不再进入 Jev Routing State；入口拒绝超长、非法或密钥样式 ID，连续调用仍可本地关联。
- [Issue 10](issues/10-proved-model-effort-pairs.md)：精确 pair 仅从当前 caller edge 的有效脱敏实测证明与目录交集进入基线或候选；真实证明资产仍待提供。
- [Issue 12](issues/12-allowlisted-tool-facts.md)：移除不可信工具事实头；有限验证步类型、模型与布尔控制值，无获准事实时跳过 Jev；HTTP 测试证明候选集、Active 资格及原生工具结果保真。
- [Issue 14](issues/14-jev-resolved-version-gate.md)：Jev 请求与响应版本独立记录；未知、漂移或别名版本不能进入 Active Apply，真实固定版本回报仍待实证。
- [Issue 18](issues/18-derived-candidate-catalog-identity.md)：候选目录 ID 由当前有效证明 pair、证明版本和 caller edge 派生；正式 Active 在目录发现后校验报告，评估器重算同一 ID。
- [Issue 13](issues/13-compressed-response-fidelity.md)：标准 `fetch` 解压后清理压缩表示头，保留有效缓存/Vary 字段；本地 HTTP gzip JSON/SSE 和未压缩 SSE 测试通过，真实 caller-edge 证据仍待 Issue 21。
- [Issue 17](issues/17-bind-jev-policy-knobs.md)：冻结并校验精确 confidence floor 与 Jev deadline；每次 Jev 调用、候选证据、报告摘要和 Active 启动绑定同一策略值。合成 HTTP/启动测试通过，真实 Jev 与生产 caller-edge 证据仍未取得。
- [Issue 16](issues/16-sse-terminal-failure-status.md)：共享 SSE 观察器识别明确失败/不完整与异常 EOF，失败优先于完成；原始事件顺序保留且输出后不会重放。scanner 和本地 HTTP stub 验证通过，真实 caller-edge/Codex 证据仍待 Issue 21/22。
- [Issue 19](issues/19-verify-active-evidence-artifacts.md)：正式 Active 读取受限目录下的脱敏 bundle 与资产、验证字节摘要和关联，再重算配对报告；共享 baseline 资产支持多候选，清单外不合格候选缺 refs 不会阻断合格候选。CLI 端到端与合成门禁测试通过；哈希不证明来源真实性，自动校验不等于真人质量评审或实机证据，真实结果仍待 Issue 21/22/25。

### 已实现，待实机验收

- [Issue 08](issues/08-controlled-active-evaluation.md)：独立本机 Active 采证入口、冻结任务与证明目录校验、回环监听及脱敏运行记录已实现；正式 Active 门禁保持关闭。真实 Jev、认证 caller edge 和 Codex A→B→A 会话仍缺，首项验收未完成。
