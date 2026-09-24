# 26 — 将真实工具延续与压缩证据绑定到正式 transport gate

**What to build:** 正式 Active 报告只有引用可核对的真实 Codex A→B→A、认证 caller edge、SSE/JSON、工具结果延续和压缩后新 Choice 证据时，才允许某个精确 Candidate Pair 的 transport gate 为 PASS；旧的四字段 transport 资产不得继续批准发布。

Blocked by: 19 — 正式 Active 已能读取并重算保存的 bundle/证据资产。无需真实 Jev 凭据即可先完成 schema 与拒绝测试。

Blocks: 21 — 新采证须按当前资产契约归档；23 — 压缩资产须可进入发布 gate；25 — 正式发布决定。

Status: resolved

Related: `spec.md` §7–9；`tech-design.html` 03、06/R1；Issue 08、21、23；正式 Active 证据验证器与配对评估器。

## 当前缺口与设计决定

当前 `jev-transport-evidence-v1` 的 `facts` 只包含 `requested_pair`、`observed_model`、`observed_effort` 和 `first_event_before_completion`。这可证明字段自洽，却无法把 A→B→A 的同会话调用、认证/不递归、工具结果 ID、JSON 保真或真实压缩后新 Jev Choice 连接到正式 transport PASS。Issue 23 即使完成真实试验，也没有可被当前发布门禁读取的压缩事实。

采用**一个版本化的 transport 资产 v2** 扩充现有门禁，不增加独立的发布控制系统或第二套评估器。v2 的结构化事实至少绑定：

Issue 21 与 23 可先各自归档对应阶段的真实脱敏源资产；**不要求 21 单独证明压缩，也不要求 23 重跑完整 A→B→A**。Issue 25 才把两票同一发布配置的来源关联成每个候选可校验的完整 v2 transport 资产。每个拟发布候选恰有一个完整的复合 transport v2 资产，沿用现有 `<candidate_id>:gate:transport` association ID；它嵌入受限的 21/23 结构化事实及各源文件的相对路径/字节摘要/运行 ID。验证器对源文件同样执行路径围栏、字节摘要和 release/config/运行关联核对；Root 再独立核查真实来源。候选必须出现在 A→B→A 和压缩后调用的权威上游观测中，不能仅出现在候选目录或 Jev 提议里。

- release、候选 pair、caller-edge/派生目录、Jev 请求与实际固定版本、policy/question schema、受控运行 ID 与证据来源；
- 同一会话三个 Model Call 的顺序与不可逆关联摘要、预冻结 A/B（不同真实模型）、每次 proposed/applied/observed pair 与请求 effort、HTTP 状态/终态、物理请求计数；
- 工具调用与下一次请求的工具结果 ID 摘要的两次延续；至少一条 SSE 的首增量早于完成及事件终态，一条 JSON 的状态/相关头部/body 摘要核对；
- caller edge 已认证且对真实模型不递归的可复核来源标识；真实 Codex 压缩事件、压缩后同会话新工具结果引用、新 Jev Choice 和上游调用的关联摘要；
- 每类事实引用的受限脱敏源资产摘要/路径或等价独立可审计来源。固定长度摘要和时间戳可记录，原始 input、工具输出、完整会话、认证信息不可记录。

必须的会话、工具、认证、JSON、SSE 或压缩来源无法权威证明时，事实保留 `UNKNOWN` / 缺失并令 transport gate 不通过。**上游不权威报告 effort 是允许的例外：`observed_effort: UNKNOWN` 可与已证明请求 effort 并列，不从其他列推断。**单纯把字段写成 `true` 或填一个自算哈希不能当作真实 provenance；自动校验负责结构、关联和内容一致性，Root 另做来源审查。

## 实施步骤

1. 先写失败行为测试：旧 v1 四字段资产即使报告声称所有 gate PASS 也不能启动生产 Active；缺会话/工具/JSON/压缩/认证任一必需关联，错误 candidate/release/config、重复或越界路径同样拒绝。保留现有反手改报告和资产字节校验。
2. 在现有 bundle/manifest/验证器边界加入 transport v2，写清完整 v2 manifest/facts/source 结构并使用限定枚举、数量、长度、摘要格式、时间顺序与交叉关联校验。至少检验 A→B→A 的模型变化、工具结果链、SSE 首增量先于完成、JSON 核对、压缩事件先于新 Choice、真实模型请求不递归，以及来源与 candidate/config/release/association 的精确绑定。每个 candidate 的一个复合资产必须同时引用对应 21 和 23 的真实来源；缺任一来源不能通过。
3. 若现有受控入口的脱敏 observations 缺少必要字段，只补**最小**旁路采集/转换接口，使真实运行可生成上述受限资产；不得让采集阻塞首个 SSE，不保存正文、原始工具 ID 或密钥。用户自行提供的 Jev/edge 审计资产须在 manifest 中可关联，不能凭本地代理记录推断远端认证或停工。
4. 只保留一个正式 transport gate；配对评估器的 PASS 仍受该 gate 和 Issue 19 的完整资产校验共同约束。**默认仅把 `ASSET_SCHEMAS.transport` 从 `jev-transport-evidence-v1` 升到 v2**，保留当前 report v2 与 bundle v1 外壳，因为二者已有 versioned manifest；若实现必须改外壳形状，先显式升各自版本并同步生成器/校验器/文档/测试，旧外壳 fail closed。更新所有合成夹具和 `bench/README.md`，不要为兼容旧 PASS 静默填默认值。
5. 运行 HTTP 链路与证据校验定向测试、`npm test`、`npm run typecheck`、`git diff --check`。测试用合成完整资产只证明门禁机制，不能将其引用到 Issue 21/23/25 的实机 PASS。

## Acceptance criteria

- [x] 仅有旧 transport v1 的报告或缺真实压缩/工具/认证/JSON 关联的 v2 报告不能批准任何正式 Active Candidate Pair。
- [x] 完整且内部一致的 v2 脱敏资产可由现有 bundle/manifest 读取、校验字节与绑定并重算；交叉 candidate、release、运行配置、会话或顺序的资产被拒绝。
- [x] v2 可承载 Issue 21 与 23 的真实证据索引，不泄露原始文本/工具输出/凭据，不改变原生 SSE/JSON 或生产路由路径。
- [x] 合成 PASS 测试仅验证代码；无独立真实来源和 Root 复审时，Issue 21/23/25 及原 06/07 继续未完成。

## Root review

Luna Max 先做最小失败测试，再改共同验证边界；一个聚焦提交。Root 对照 `spec.md`、唯一运行时策略和 Issue 19 检查旧报告 fail closed、摘要/路径/关联校验、隐私与流式旁路，运行全量测试。若 v2 无法从真实服务取得可验证的某项来源，应在数据中留 `UNKNOWN` 并阻止发布，不发明“证明”。

## Answer

正式 transport 资产升为 `jev-transport-evidence-v2`，保留 report v2 与 bundle v1 外壳。每个拟发布候选的复合资产须绑定当前 release、配置、候选和 association，并引用各一份受限的 A→B→A 与压缩来源文件；验证器检查相对路径、原始字节摘要、来源字段和事实一致性。A→B→A 检查不同真实模型的完整 pair 顺序、每次 Jev 固定版本及 Guard 接受、同一原生工具 ID 的两次延续、SSE 时间顺序和独立 JSON 核对；压缩来源可与 A→B→A 分开运行，但须证明其内部同会话的新 Choice、工具结果延续和实际候选观测。观测 effort 可为 `UNKNOWN`。旧四字段 v1 资产在正式 Active 入口拒绝。

Root 复核差异并独立运行 `npm test`（226/226）、`npm run typecheck` 和 `git diff --check`，均通过。通过用例仅用合成数据证明门禁机制；尚无真实 Jev、认证 caller edge 或 Codex 来源，Issue 08、21–25 及父验收未因此获得 PASS。
