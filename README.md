# Jev Auto Router

**一个 Codex 会话，每次模型调用重新选档。** [TypeSafe 的 Jev](https://docs.typesafe.ai/introduction) 从当前可用的 GPT 模型与推理档位中做一次选择；任务结束后再独立验收。这是 Jev Auto Router（Jev Router）的验证原型。

架构中，Jev 负责每次调用的模型与推理档位选择；本地 Responses 代理负责保持 Codex 会话和工具循环连续；任务结束后独立验收。Router Compass 把选路、实际用量和验收结果放在一起，回答一个问题：**少用旗舰模型之后，任务是否仍然正确完成，整体开销是否真的下降？**

当前模型阵容为 **GPT-6 三档**：`gpt-6-luna`（Luna Max，高强度推理）、`gpt-6-sol`（常规主力，并承担固定回退基线角色）、`gpt-6-astra`（默认不在候选中，仅在证据或用户指令准入时进入）。

> [!IMPORTANT]
> **当前状态：方案 A 运行时已实现，真实实机证据仍在补齐。** 固定基线
> 链路、Shadow、受控 Active、取消传播、pair 证明目录与配对评估门禁已
> 落地并通过确定性 HTTP 测试；可重跑的实机 A→B→A、独立取消、压缩续跑
> 与真实配对评估发布结论（本地 ticket 21–25）尚未完成。请勿把下面的
> 说明当作已经可投入生产的安装指南。

[English](README.en.md) · [架构方案](docs/solution.md) · [架构决策 ADR 0017](docs/adr/0017-per-call-responses-routing.md) · [中文文章](https://minilv.github.io/2026/09/18/codex-auto-router/) · [许可证](LICENSE)

## 前置条件

- **TypeSafe 账号与 Jev API key。** 按 [TypeSafe Quick Start](https://docs.typesafe.ai/introduction/quickstart) 从控制台获取密钥。当前代理调用 Jev 时读取环境变量 `JEV_API_KEY`；TypeSafe 官方示例使用 `TYPESAFE_API_KEY`，两者可以设置为同一密钥。不要将密钥提交到仓库。
- **Node.js 22+、已登录的 Codex CLI，以及宿主实际可请求的模型与推理档位。** 仅有 Jev 密钥不足以运行真实的逐调用路由。
- **目前是验证原型。** 运行时已按方案 A 实现并通过确定性测试，但真实
  caller-edge 证明资产、可重跑实机会话与配对评估结论仍待补齐；尚无
  开箱即用的生产安装流程。

本地运行代理前，把 TypeSafe 控制台获取的密钥放进当前 shell：

```sh
export JEV_API_KEY="<your-typesafe-jev-api-key>"
```

## 为什么是逐调用路由

一个编码任务既有理解需求、排查复杂故障的高强度推理，也有读取文件、执行已知修改、跟进工具结果的常规调用。整段任务固定使用旗舰模型，会让简单调用占用昂贵能力；整段任务固定使用轻量模型，又可能拖累困难环节。

Jev Auto Router 把选择点放在**每次有意义的模型调用**上，而不是为每个任务启动一个新 worker。例如，同一个会话可以由 Sol 理清问题，Luna Max 处理高强度推理，Sol 继续常规实现与工具跟进，Astra 只在出现经验证的推理阻碍时经一次性准入进入。这个序列仅用于说明路由粒度，不代表实测效果。

## 核心闭环

```text
Codex Responses(model=jev/auto)
   │
   ▼
Codex Router ── 真实模型请求 → 正常通道（绕过 Jev）
   │
   ▼
本地 Jev Router ── OFF / 隐私拒绝 / 信息不足 → 固定 Fallback Baseline
   │
   ▼
白名单 Routing State + caller edge 已实测可请求的 Candidate Pair
   │
   ▼
固定版本 Jev 一次 Choice ── Guard ── Apply 只改 model 与 reasoning.effort
   │                         失败/Shadow ──► 同一个固定 Fallback Baseline
   ▼
已认证且不递归的 caller edge ──► 原生 SSE / JSON 立即返回 Codex
```

### 系统拓扑

<p align="center">
  <img src="docs/assets/jev-topology.png" alt="系统拓扑：Codex CLI、Codex Router、Jev Router、认证 caller edge 与 GPT 模型的主链路，TypeSafe Jev 作为路由决策支线" width="880">
</p>

主线只处理 Codex 原生 Responses 请求；Jev 是路由决策支线，只接收白名单事实与候选组合，不接触上游认证凭据。虚拟模型入口（`jev/auto`）与认证 caller edge 必须分开，避免递归转发；用户内容只通过本地代理到达原本要调用的 GPT 上游。完整设计见[方案 A 可视化技术设计](tech-design.html)。

### 交互时序

<p align="center">
  <img src="docs/assets/jev-sequence.png" alt="Codex、Codex Router、Jev Router、TypeSafe Jev 与 caller edge 的逐调用交互时序图" width="880">
</p>

Jev 不成为 Codex 的执行模型：它只在上游模型调用之前给本地路由器一个受约束的选择。响应不等待整段生成完成即回传；观测模块旁路读取完成事件，观测失败不阻断或改写 Codex 收到的响应。回退只在发出上游请求之前决定；上游已经开始输出后的故障如实上报，不在同一调用上自动换模重放。

### 六个模块

| 模块 | 职责 | 输出 |
| --- | --- | --- |
| M1 · 请求接入 | 接收 Responses 请求，识别会话、调用类型、用户指定模型与基础设施调用 | CallContext + 原生请求 |
| M2 · 候选与隐私 | 从实测可请求清单生成候选组合；应用用户硬约束；只提取白名单路由事实 | RoutingFacts + CandidatePairs |
| M3 · 一次 Jev Choice | 固定版本、固定问题模板，一次有截止时间的调用 | ProposedPair 或失败原因 |
| M4 · Guard + Apply | 校验候选成员、可用性、约束与置信度；只改 `model` 与 `reasoning.effort` | AppliedRequest + RouteSource |
| M5 · 认证与流转发 | 调用已验证 caller edge；响应字节边到边转发；取消同步传上游 | 原生 SSE / JSON 响应 |
| M6 · 被动观测 | 分列记录提议、应用与上游实际组合；缺失值标 UNKNOWN，不记录原文 | 每次调用的审计记录 |

### Jev 做什么

- 路由器只构建当前认证 caller edge **已经实测可请求**的
  `(模型, reasoning effort)` 组合。Jev 对这些组合做**一次 Choice**；
  本地代码不添加任务类型表或第二个语义选路器。
- 发给 Jev 的是经过发送资格检查的紧凑状态，例如当前步骤、工具错误摘要和当前模型。完整会话仍走 Codex 原生模型调用；原始 prompt 和工具输出默认不写入路由日志。
- 生产路由使用经过验证的 Jev 固定版本。OFF、隐私拒绝、信息不足、
  超时、低置信或无效回答都使用同一个已实测固定基线，并留下各自原因；
  没有产品级默认组合。用户选择真实模型时始终绕过 Jev。
- **Astra 准入是稀缺资源。** `gpt-6-astra` 默认不在候选中；只有经验证
  的推理阻碍证据开启的一次性资格（用后即耗尽），或用户明确指令
  （`x-jev-astra-mandate`）才让它进入本次调用。普通失败不产生持久资格。

### 候选组合

候选项是精确的 `(model, reasoning_effort)` 对，不是品牌档位。只有在
当前 caller edge 上实际请求成功、满足能力与用户硬约束的组合才能进入
Choice；模型选择器或目录中可见不等于可执行。当前 tier 为
`luna_max` / `sol` / `astra`。增加或变更候选需要重新走 Shadow 与传输验证。

## 什么数据去哪里

- **发给 Jev 的**只有通过发送资格检查的紧凑状态：步骤类型、当前模型、工具名、退出码、定长错误摘要。完整会话永不因路由外发。
- **上游模型调用**携带原生会话内容，与未安装代理时相同；代理不改写响应事件流。
- **本地日志**默认不保存原始 prompt 与工具输出；敏感内容直接拒发（不是截断），无发送资格的调用跳过 Jev 走基线。

## 路由正确，还不等于任务完成

任务边界对照原始需求检查改动、测试、运行结果和必要的语义结论；执行
模型自报成功不算证据。路由提议与最终交付分开评价。

Router Compass 记录每次调用的 Jev 选择、实际模型与档位、用量、缓存、延迟和回退原因，再关联任务的验收结果。未知用量保持 `UNKNOWN`，不能当成零。模型切换可能损失 prompt cache，因此 V1 先测量切换的真实代价，不声称路由天然省钱。

| 证据 | 可以回答的问题 |
| --- | --- |
| 生产观察 | 实际用了哪些模型、花了多少、任务是否通过验收 |
| 历史回放 | 在明确假设下，**估算**其他路线可能的价格；属于反事实，不证明质量 |
| 固定 Fallback Baseline 对照 | 在同等验收、完整计入 Jev、缓存、失败和验证开销后，是否真的节省并保持质量 |

## 当前进度与体验

方案 A 运行时已在当前仓库落地：固定基线链路、Shadow/Active 双模式、
pair 证明目录与派生目录 ID、Jev 版本与策略绑定、SSE 终态归因、取消
传播、受控 Active 采证入口与配对评估门禁均实现并通过确定性 HTTP 测试
（本地 ticket 09–20 已完成，08 已实现待实机验收）。仍开放的是真实证据
与发布决定（ticket 21–25）：可重跑的实机 A→B→A 会话、独立取消与压缩
续跑证据、预注册配对评估及真实质量/成本结论。通过这些验证前，项目不
宣称普遍节省，也不提供“安装后即可自动路由”的承诺。

仓库的 [skills/jev-auto-router/SKILL.md](skills/jev-auto-router/SKILL.md) 是安装与运行的操作说明；Skill 本身不拦截模型调用，路由发生在本地代理中。

### 试运行（原型）

需要 Node.js 22+。以下命令启动本地代理并验证当前代码，不会建立 Codex 的生产代理连接：

```sh
npm ci
npm run build
JEV_API_KEY="<your-key>" \
# Replace with a pair you have successfully requested through this caller edge,
# e.g. gpt-6-sol/medium
JEV_BASELINE="<verified-model>/<verified-effort>" \
JEV_UPSTREAM_BASE_URL="<authenticated-caller-edge-url>" npm start
curl -s localhost:8787/health          # 路由状态、基线档位、模型目录
npm test                               # 构建并运行全部测试
npm run typecheck
```

评估与采证工具：

```sh
npm run bench:jev-smoke             # 合成 Jev 集成冒烟（不评执行质量）
npm run bench:active-evaluation     # 本机受控 Active 采证入口（仅采证，非发布报告）
npm run bench:evaluate              # 汇总配对评估 JSON 报告（Active 门禁输入）
```

### 本地 HTTP 接口

| 方法与路径 | 作用 |
| --- | --- |
| `POST /v1/responses` | Responses 入口；`model=jev/auto` 触发逐调用路由，真实模型直接透传 |
| `GET /health` | 路由状态、基线可请求性、已证明 pair、目录 ID 与证明排除原因 |
| `GET /decisions` | 每次调用与任务的审计记录（无提示词或工具原文） |
| `POST /__jev/task/<id>/verification` | 回报任务边界验收结果，关联路由记录 |

控制信号通过 `x-jev-*` 请求头传入，不进入转发体：`x-jev-task-id`（必填）、`x-jev-step`（步骤类型）、`x-jev-current-model`、`x-jev-context-size-bucket`、`x-jev-forced-model`（硬约束单模型）、`x-jev-astra-mandate`（明确要求使用 Astra）、`x-jev-competing-authority`（存在其他路由权威时跳过 Jev）。每次调用的路由结果通过响应头 `x-jev-route`（`model:effort`）与 `x-jev-route-source` 返回。用户输入只在本地做敏感检查与长度分桶，仅分桶结果可进入路由状态。

### 配置

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `JEV_API_KEY` | TypeSafe Jev API 密钥 | 启用路由时必填 |
| `JEV_ROUTER_OFF` | `1` = OFF：不调用 Jev，`jev/auto` 使用固定基线 | 未设置 |
| `JEV_MODE` | `active` \| `shadow`（shadow 只记录 would-be 路线，执行用基线） | `shadow` |
| `JEV_ACTIVE_CANDIDATES` | 精确候选组合白名单，逗号分隔 `<model>/<effort>`；设置后 Shadow 也只向 Jev 提供这些组合，Active 无白名单拒绝启动 | Active 时必须显式配置 |
| `JEV_ACTIVE_EVIDENCE_FILE` | `bench:evaluate` 生成的配对评估 JSON 报告；Active 会校验通过门槛及版本绑定 | Active 时必须显式配置 |
| `JEV_PAIR_PROOFS_FILE` | 经审核的 caller-edge 精确模型/effort 请求成功证明清单；不做启动探测 | 未设置即无 pair 证明 |
| `JEV_RELEASE_ID` | 与配对评估报告相同的运行版本标识 | Active 时必须显式配置 |
| `JEV_VERSION` | 生产 pin 的 Jev 版本 | `jev-1.13.0` |
| `JEV_BASELINE` | 当前 caller edge 已实测可请求的固定回退组合 | 必须显式配置；没有通用默认值 |
| `JEV_CONFIDENCE_FLOOR` | 置信度下限（低于即回退基线）；Active 必须显式设置并匹配评估报告 | Shadow 默认 `0.55` |
| `JEV_DEADLINE_MS` | 热路径 Jev 超时（按 Shadow 延迟数据调校）；Active 必须显式设置并匹配评估报告 | Shadow 默认 `2000` |
| `JEV_PORT` | 本地代理监听端口 | `8787` |
| `JEV_UPSTREAM_BASE_URL` | 负责上游认证且不会递归回到本路由器的 caller edge 地址；路由器不持有上游凭据 | 必须显式配置 |
| `JEV_CALLER_EDGE_ID` | `/health` 证据中的非密钥 caller-edge 版本或配置标识 | `UNKNOWN` |
| `JEV_CANDIDATE_CATALOG_ID` | 可选的预期目录 ID；实际 ID 由当前 caller edge 的有效 pair 证明派生，启动时不匹配即拒绝 | 未设置 |
| `JEV_ENDPOINT` | Jev API 接口地址 | TypeSafe 端点 |

Active 的置信度下限必须是 0 到 1 的有限数字，截止时间必须是 1 到
2147483647 毫秒的整数。改动任一数值都要重新生成 Shadow 与配对评估；旧报告缺少这两个字段时会拒绝启动。

pair 证明清单为版本 1 JSON：清单头含 `version`、`id`、`caller_edge_id` 和 `proofs`；每项含精确 `model`/`effort`、caller-edge ID、请求和过期时间、HTTP 与 Responses 结果、观测 model/effort，以及脱敏证据 artifact ID、SHA-256 和固定枚举摘要。只有当前 edge 上成功完成、观测 model 精确匹配且未过期的 pair 才能进入候选；`observed_effort: "UNKNOWN"` 会保留为观测缺口。清单不接受请求体、prompt、工具输出或凭据字段。启动先读取 `/models` 和清单，再按 edge、有效 pair 及各 pair 证明版本的规范化摘要派生目录 ID，然后校验 Active 报告；模型/证明顺序、session 名称和启动时间不参与 ID。启动不发送付费探针；没有已证明基线时，自动请求会在上游调用前失败，Active 配置中的任一候选未证明时拒绝启动。真实证明资产需要人工审核，本仓库没有提供伪造样例。

本地代理入口见 [src/index.ts](src/index.ts)。

## License

[Apache License 2.0](LICENSE)
