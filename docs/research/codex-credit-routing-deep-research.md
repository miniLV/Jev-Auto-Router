# 固定 Sol Root 下的 Codex Credit 路由：最小可行研究结论

日期：2026-07-31。范围是「公司环境把当前 Root 固定为 Sol，目标是让共享 Credit 用到周期末而不牺牲必要质量」。本文没有安装或调用候选 Skill，也没有把第三方 Skill 的模型价格主张当作账单事实。

## 结论

**V1 应采用“Sol Root 直接完成为默认；仅对一个已切分、低风险、可独立验收的长尾执行包，派一个 Terra 子任务”的影子建议策略。** Terra 的 effort 取已验证的最低可行值，而不是预设 `high`。不自动派 Luna，不启用 Planner/Advisor 流程，不并发扇出，不重试升级。Root 仍做意图澄清、任务切分、关键判断、集成和最终验证。

原因很直接：固定 Sol Root 的既有上下文、判断和收尾无法被子任务抵消；每个子任务还会引入启动、任务包、输出回读和集成。官方子代理文档进一步说明，每个 subagent 都会做自己的模型和工具工作，所以相对可比的单 Agent run 会消耗更多 token。官方当前计费按输入、缓存输入和输出 token 计 Credit，且实际消耗取决于 token mix。即使官方公布了模型单位费率，也不能把模型费率差直接当成“任务净节省”：子代理的重复输入、工具、失败和 Root 集成仍须计入。故只用相同任务阶段的 A/B 数据决定是否扩大路由。

## 证实的事实

1. OpenAI 当前 Codex rate card 说明：Credit 是按每百万输入、缓存输入、输出 token 计；实际消耗取决于三者组合。该卡也列出了 GPT-5.6 Sol/Terra/Luna 的单位 Credit rate；这说明模型选择是重要变量，但不构成每个 agent task 的固定节省比例。官方还明确说，较大代码库、长运行任务、扩展会话和任务运行位置都会影响用量。[Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)；[Codex plan usage](https://help.openai.com/en/articles/11369540-codex-in-chatgpt)。
2. OpenAI 的 Codex subagent 手册明确：每个 subagent 都做独立模型和工具工作，因此比可比 single-agent run 消耗更多 token；不 pin model/effort 时，Codex 才能在 intelligence、speed、price 间平衡。手册同时把 Terra 列为 fast scan/light worker 的合适选择。[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)。
3. OpenAI 模型指南将 Sol 定位为 complex/open-ended，Terra 为日常工作马/能力与成本平衡，Luna 为明确、可重复、高频工作；并要求从最低可行 effort 开始，在代表性任务上比较配置，而非假设最高 effort 最优。[Models](https://learn.chatgpt.com/docs/models.md)；[GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)。
4. 本仓库已定义官方当前周期 aggregate Credit 为权威数据；本地 token/model 记录只能作归因估计，不能声称为每模型或每任务的官方账单。[项目的 Credit 边界 ADR](../adr/0002-personal-dashboard-credit-boundary.md)；[项目 V1 决策](../adr/0005-v1-deterministic-shadow-router-and-calibration-boundary.md)。
5. `codex-model-routing-team` 的原始 Skill 本身把简单问答、单文件小改和强顺序任务留在主任务；它要求子任务使用完整、受限任务包，并把 Root 留作整合与验证。其深度研究默认预算却是 2–4 个 researcher、1 verifier、1 reviewer、2 个 retry reserve，因此是吞吐/质量治理方案而非本项目的最小 Credit 路径。[Skill](https://github.com/zjp1997720/codex-model-routing-team/blob/8a3eda4276f2d297f22f478598fb962b88a7140e/skills/codex-model-routing-team/SKILL.md)；[routing policy](https://github.com/zjp1997720/codex-model-routing-team/blob/8a3eda4276f2d297f22f478598fb962b88a7140e/skills/codex-model-routing-team/references/routing-policy.md)。

## 候选 Skill 审计

| 候选 | 已证实的作用 | 对本次深度研究的适配性 | 对 Codex Credit 路由的结论 |
| --- | --- | --- | --- |
| `firecrawl-deep-research` | 明确面向正式、带引用的复杂主题报告；要求 `FIRECRAWL_API_KEY`，并建议按研究角度并行收集。 | **最适合报告形态。** 本任务正是有边界的正式深度研究，且要求一手来源和书面报告。 | 不应作为日常省 Credit 路由：它增加 Firecrawl 调用成本，且其并行建议会增加 Codex 子任务开销。这里仅借鉴其“来源、反例、未知项”报告质量栏。 [原始 SKILL.md](https://github.com/firecrawl/firecrawl-workflows/blob/1a6b302731139d6de6117d205efd8198d3775cc3/skills/firecrawl-deep-research/SKILL.md) |
| `parallel-deep-research` | 要求 `parallel-cli`，自己明确标为比普通 web search 慢且贵 10–100 倍，并以远端 research processor 产出报告。 | 能做深研，但不是本任务的成本优先选择。 | **不推荐运行。** 它转移/新增的是 Parallel 的外部消费，不能证明减少 Codex Credit；长报告也会反向扩展 Root 的阅读上下文。 [原始 SKILL.md](https://github.com/parallel-web/parallel-agent-skills/blob/c5b253a9b5d88ae7fd86a6272540a30150c1b122/skills/parallel-deep-research/SKILL.md) |
| `codex-model-routing-team` | 为复杂、独立切片创建显式模型/推理强度的后台任务；策略默认 Sol/Luna、Terra 默认关闭，并承认协调成本。 | 适合以后验证“有多个真正独立切片”的吞吐实验。 | **最相关的路由参考，不是 V1 默认执行器。** 它的多 Worker 深研预算与本项目的「月末续航」目标冲突；可复用的最小原则是：Root 决定、独立切片、受限任务包、无全历史 fork、Root 验收。 [原始 README](https://github.com/zjp1997720/codex-model-routing-team/blob/8a3eda4276f2d297f22f478598fb962b88a7140e/README.md) |
| `cost-latency-optimizer` | 提供 GPT-4/GPT-3.5/Claude API 价格样例、缓存、batch、prompt 优化和 API 调用计数。 | 不是研究工作流。 | **通用 API 成本建议，不能直接用于 Codex Credit。** 它没有 Codex App/ChatGPT Credit 帐单、Root/child 上下文或公司模型映射。可采纳的只有普适原则：小包、少输出、避免重复读取。 [原始 SKILL.md](https://github.com/patricio0312rev/skills/blob/79ea6af485698b31060b63f0066f712560757b29/ai-engineering/cost-latency-optimizer/SKILL.md) |
| `llm-cost-optimization` | 面向自建/API LLM 平台的模型选择、prompt caching、batching、量化、自托管、团队预算和 cost-aware routing。 | 不是 Codex 产品研究工作流。 | **通用 LLM API/基础设施成本治理，不理解 Codex workspace Credit 或 Root/child 上下文。** 其中的预算、缓存和 A/B 原则可参考，但不能直接作为本项目路由器。 [原始仓库](https://github.com/bagelhole/devops-security-agent-skills) |
| `token-optimization` | 面向 MCP/tool 请求：lazy load、最小输出、分页、精确字段和缓存已有上下文；自身明确不是基础设施成本/提示词优化 Skill。 | 对本次资料收集有用。 | **不是 Credit 定价或模型路由器。** 但它的“先窄查、限制输出、不重复取数”应成为所有 Root/child 任务包的执行约束。 [原始 SKILL.md](https://github.com/claude-dev-suite/claude-dev-suite/blob/feb48b75aef7fc43ff354cdc34fa5742170bb465/skills/best-practices/token-optimization/SKILL.md) |

### 最适合本次深度研究的 Skill

若只按“完成一份有来源、反例和开放问题的深度研究报告”的能力选，选 **`firecrawl-deep-research`**；它的任务定义与交付结构最贴合。若把“不得增加外部付费调用、只用官方和仓库一手资料”也算硬约束，则本次的更优操作是**不运行任何候选深研 Skill**，而是采用它的报告质量框架进行定向一手资料检索——这正是本文采取的方式。

## Codex-Orchestration：是不是以省 token 为目标？

**部分是，但不能把它定义成“省 token Skill”。** 其原始文档把主要目的写为：把高端容量留给判断，把较高效编码模型用于合适执行量；同时明确禁止“为了达到一个百分比而创建 agent”。它还要求 `fork_turns = "none"`，理由之一是减少重复上下文，并警告 Advisor、重复上下文、重试、工具、Fast service tier 和多余 worker 可抹掉收益。[保持节省表述诚实的原始段落](https://github.com/Cjbuilds/Codex-Orchestration/blob/2c0a4b83f1d12618c5452333962393ab6412dedc/plugins/codex-orchestration/skills/codex-orchestration/SKILL.md#L687-L695)。

该仓库 README 的“较少触发 premium-model limits”或示例百分比，是该项目的目标/计算假设，不是 OpenAI 对本公司工作区的价格承诺。对本项目而言，应把它视为**治理与显式模型路由工具**；只有本地 A/B 证明某一类任务在质量合格下的 Credit 下降后，才把它视为节省工具。

## 固定 Sol Root 时的盈亏边界

这里的“盈”指相同或更好的可接受结果下，周期 Credit 消耗（及必要时人工返工）降低；不是仅仅子任务 token 较少。

| 选择 | 什么时候才可能划算 | 什么时候几乎必亏或不应以省钱为由采用 |
| --- | --- | --- |
| Sol Root 直做 | 短任务；强顺序；需要不断从既有 Root 上下文判断；一次修改/一次验证；任务包本身快接近原任务大小。 | 不适用；这是 V1 的基线，不需为了“有路由”而绕开。 |
| 一个 Terra 子任务 | Root 已经把剩余工作切成低/中风险、可独立验收的较长执行包；输入可压成小任务包；输出有明确格式；Root 只需一次验收。Terra 是官方明确的低成本/轻量工作候选；从当前环境中**最低可行 effort**起测，必须验证运行时身份。 | 需要 Root 在执行中反复解释、child 需读大量相同仓库/日志、或失败后还要 Sol 重做。官方已说明 subagent 的独立模型/工具工作会额外耗 token；此时启动、重复输入和整合更不可能回本。 |
| 一个 Luna 子任务 | **待验证假设。** 官方定位是明确、可重复、高频工作；仅限机械提取、格式转换、窄范围检索/摘要，且 Terra A/B 已经显示仍有可压缩空间；同样需身份、质量和 Credit 数据。 | 当前 V1 不把 Luna 作为正式建议。无法独立验收、需工程判断、会触发升级/retry，或公司路由能力未证实时，一律不用。 |
| Planner + Advisor + Executor | 只有 HIGH 风险、错误返工/事故代价显著高于多次规划与审查、且独立计划审查能实测提高首轮通过率时才有质量经济性。 | 不是省 Credit 默认路径。至少增加计划和审查上下文，还可能多轮 revise；固定 Sol Root 下又保留 Root 的统筹成本。普通任务和预算紧张期一律禁用。 |

**推论：** 在固定 Sol Root 的前提下，最先要消除的是“可避免的 Root 长尾工作”和重复/过大工具输出，而不是用多个 agent 替换 Root。单个、边界清楚的 Terra 子任务是唯一值得先测的变量；Luna 与 Planner/Advisor 都应在后续有证据时再开。

## 推荐的 V1 最小路由策略

1. **影子建议而非自动执行。** 每次仅记录建议与结果；用户显式模型、推理强度和“不要子代理”始终覆盖。
2. **默认 `ROOT_DIRECT`。** Root 用 Sol 处理 intake、风险判断、复杂诊断、计划、集成、最终验证；不因预算压力降低 HIGH 风险工作。
3. **唯一可试验路线为 `TERRA_LIGHT_WORKER_MIN_EFFORT`。** 同一根任务最多一个 child、一个不可重叠工作包、`fork_turns = none`、无 Plan/Advisor、无自动重试。由当前可用 effort 中的最低可行值开始（不得猜测固定值），包只含目标、最少必要事实、唯一读/写范围、验收检查与短输出格式。
4. **排除条件。** 任务短、强顺序、需共享 Root 隐含上下文、工作区状态脏且无法隔离、需要多轮澄清、或 child 运行时模型不可验证时，退回 `ROOT_DIRECT`。
5. **Luna 与 Planner/Advisor 暂停。** 不写入正式推荐；只有满足下述 A/B gate 才新增一个非常窄的 Luna 类别或 HIGH 治理例外。
6. **按周期管理。** 固定一个策略版本至 reset；Credit Runway 只提示“停止可选实验/收紧 eligibility”，不能把高风险任务降级。官方 aggregate Credit 是月末续航判断的唯一帐单源。

这与仓库现有的 Shadow Router、Terra 默认和 Luna 延后原则一致，但本文将“固定 Sol Root”的额外约束明确为：**不把 Planner/Advisor 当作默认的 Sol 降费方案。**

## 必须先收集的 A/B 数据与放行门槛

### 设计

- 建一个小型、冻结的、按“任务阶段”分层的样本：例如机械检索/摘要、常规实现、确定性验证；不要把同一 live ticket 先 Sol 再 Terra 重跑。
- 对每一类，以相同输入规模、仓库范围、验收命令和成功定义，比较 `ROOT_DIRECT` 与单个 `TERRA_LIGHT_WORKER_MIN_EFFORT`；随机或交替分配，避免把较难任务全部给一边。Terra 通过后，才对机械类试 Luna；每个模型都比较最低可行 effort 与相邻更高一档，不能默认 `high` 或 `xhigh`。
- 实验期间禁止并发的无关 Codex 消耗，分别在任务前后读官方周期 Credit snapshot；若无法隔离，只将该 delta 标记为不可归因，不作节省结论。

### 每个样本必须记录

| 维度 | 证据/用途 |
| --- | --- |
| 路由事实 | Root 与 child 的实际 model、effort、service tier、是否 `fork_turns=none`；只承认可观测的运行时身份。 |
| Credit 与 token | 官方周期 Credit 前/后快照及时间窗；本地输入/缓存/输出 token 仅作诊断和覆盖检查，不能变成“每任务官方 Credit”。 |
| 质量 | 首轮验收是否通过、测试/人工审查结果、缺陷回流、升级到 Sol、返工次数。 |
| 协调开销 | child 启动、任务包 token、Root 回读/集成 token、等待时间、重复工具读取和重试。 |
| 适用性 | 任务阶段、风险等级、是否独立、输入/输出大小级别；不保留 prompt、代码、日志正文。 |

### Gate（不使用虚构百分比）

- **Terra 放行：** 在某个明确任务阶段的多个匹配样本中，首轮验收和返工不劣于基线，且官方 Credit 可隔离地显示净下降（child、Root 整合和重试全部计入）。
- **Luna 探索：** 先满足 Terra gate，再只对机械类别做同样比较；任何质量下降、频繁升级或不可归因，即撤回类别。
- **Planner/Advisor 例外：** 仅以 HIGH 风险类的“避免返工/遗漏”证据放行，绝不以 token 少为先决理由；必须限制为单次 plan/review，不跑无界 revise loop。
- **停止条件：** 信号不足、runtime identity 不可证、官方 Credit 时间窗被其他用量污染、或质量失败时，不自动扩大；保持 Root 直做。

## 待验证假设

1. 公司工作区里 Terra/Luna 是否真的可作为 Sol Root 的可调用 child，以及工具是否能提供实际 model/effort 身份。
2. 本公司 Credit 计划是否已使用官方 token-based rate card，抑或仍处于 legacy/合同例外；这由 workspace 管理员/Usage 数据确认，不能凭本文决定。
3. 单个 Terra child 在各目标任务阶段是否能减少**净** Credit；公开资料和候选仓库都不能替代该 A/B。
4. Luna 的可用性、质量下限及其相对 Terra 的 Credit 关系；在得到上述数据前，Luna 不是 V1 路线。
5. “让额度坚持到月底”是否由 Sol Root 长会话主导；需要按天的 official snapshot 和任务阶段结果，不能只看本地 token 比例。

## 一手来源清单

- OpenAI：[Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)、[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-in-chatgpt)。
- Firecrawl：[firecrawl-deep-research 原始 Skill](https://github.com/firecrawl/firecrawl-workflows/blob/1a6b302731139d6de6117d205efd8198d3775cc3/skills/firecrawl-deep-research/SKILL.md)。
- Parallel：[parallel-deep-research 原始 Skill](https://github.com/parallel-web/parallel-agent-skills/blob/c5b253a9b5d88ae7fd86a6272540a30150c1b122/skills/parallel-deep-research/SKILL.md)。
- zjp1997720：[codex-model-routing-team 原始 Skill](https://github.com/zjp1997720/codex-model-routing-team/blob/8a3eda4276f2d297f22f478598fb962b88a7140e/skills/codex-model-routing-team/SKILL.md)、[routing policy](https://github.com/zjp1997720/codex-model-routing-team/blob/8a3eda4276f2d297f22f478598fb962b88a7140e/skills/codex-model-routing-team/references/routing-policy.md)。
- patricio0312rev：[cost-latency-optimizer 原始 Skill](https://github.com/patricio0312rev/skills/blob/79ea6af485698b31060b63f0066f712560757b29/ai-engineering/cost-latency-optimizer/SKILL.md)。
- bagelhole：[DevOps Security Agent Skills 原始仓库](https://github.com/bagelhole/devops-security-agent-skills)。
- claude-dev-suite：[token-optimization 原始 Skill](https://github.com/claude-dev-suite/claude-dev-suite/blob/feb48b75aef7fc43ff354cdc34fa5742170bb465/skills/best-practices/token-optimization/SKILL.md)。
- Cjbuilds：[Codex-Orchestration README](https://github.com/Cjbuilds/Codex-Orchestration/blob/2c0a4b83f1d12618c5452333962393ab6412dedc/README.md)、[原始 Skill](https://github.com/Cjbuilds/Codex-Orchestration/blob/2c0a4b83f1d12618c5452333962393ab6412dedc/plugins/codex-orchestration/skills/codex-orchestration/SKILL.md)。
- OpenAI 模型与子代理：[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)、[Models](https://learn.chatgpt.com/docs/models.md)、[GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)。
