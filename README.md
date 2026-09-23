# Jev Auto Router

**一个 Codex 会话，每次模型调用重新选档。** [TypeSafe 的 Jev](https://docs.typesafe.ai/introduction) 从当前可用的 GPT 模型与推理档位中做一次选择；任务结束后再独立验收。这是 Jev Auto Router（Jev Router）的验证原型。

架构中，Jev 负责每次调用的模型与推理档位选择；本地 Responses 代理负责保持 Codex 会话和工具循环连续；任务结束后独立验收。Router Compass 把选路、实际用量和验收结果放在一起，回答一个问题：**少用旗舰模型之后，任务是否仍然正确完成，整体开销是否真的下降？**

> [!IMPORTANT]
> **当前状态：方案 A 契约已定，运行时正在迁移。** 已有真实 Codex
> A→B→A 摘要支持跨模型延续、认证、工具结果 ID 延续和完成前的 HTTP
> 流式输出；effort 一致性、取消、压缩、版本归档和可重跑记录仍待补齐。
> 请勿把下面的设计当作已经可投入生产的安装说明。

[English](README.en.md) · [架构方案](docs/solution.md) · [架构决策 ADR 0017](docs/adr/0017-per-call-responses-routing.md) · [中文文章](https://minilv.github.io/2026/09/18/codex-auto-router/) · [许可证](LICENSE)

## 前置条件

- **TypeSafe 账号与 Jev API key。** 按 [TypeSafe Quick Start](https://docs.typesafe.ai/introduction/quickstart) 从控制台获取密钥。当前代理调用 Jev 时读取环境变量 `JEV_API_KEY`；TypeSafe 官方示例使用 `TYPESAFE_API_KEY`，两者可以设置为同一密钥。不要将密钥提交到仓库。
- **Node.js 22+、已登录的 Codex CLI，以及宿主实际可请求的模型与推理档位。** 仅有 Jev 密钥不足以运行真实的逐调用路由。
- **目前是验证原型。** 现有摘要仍须补成可重跑的实机证据，且运行时代码
  尚待后续 ticket 迁移到方案 A；尚无开箱即用的生产安装流程。

本地运行代理前，把 TypeSafe 控制台获取的密钥放进当前 shell：

```sh
export JEV_API_KEY="<your-typesafe-jev-api-key>"
```

## 为什么是逐调用路由

一个编码任务既有理解需求、排查复杂故障的高强度推理，也有读取文件、执行已知修改、跟进工具结果的常规调用。整段任务固定使用旗舰模型，会让简单调用占用昂贵能力；整段任务固定使用轻量模型，又可能拖累困难环节。

Jev Auto Router 把选择点放在**每次有意义的模型调用**上，而不是为每个任务启动一个新 worker。例如，同一个会话可以由 Sol 理清问题，Luna Max 执行明确的后续步骤，Terra 处理一般实现问题，再由 Sol 分析失败测试。这个序列仅用于说明路由粒度，不代表实测效果。

## 核心闭环

[方案 A 可视化技术设计](tech-design.html)

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

### Jev 做什么

- 路由器只构建当前认证 caller edge **已经实测可请求**的
  `(模型, reasoning effort)` 组合。Jev 对这些组合做**一次 Choice**；
  本地代码不添加任务类型表或第二个语义选路器。
- 发给 Jev 的是经过发送资格检查的紧凑状态，例如当前步骤、工具错误摘要和当前模型。完整会话仍走 Codex 原生模型调用；原始 prompt 和工具输出默认不写入路由日志。
- 生产路由使用经过验证的 Jev 固定版本。OFF、隐私拒绝、信息不足、
  超时、低置信或无效回答都使用同一个已实测固定基线，并留下各自原因；
  没有产品级 `Terra/medium` 默认值。用户选择真实模型时始终绕过 Jev。

### 候选组合

候选项是精确的 `(model, reasoning_effort)` 对，不是品牌档位。只有在
当前 caller edge 上实际请求成功、满足能力与用户硬约束的组合才能进入
Choice；模型选择器或目录中可见不等于可执行。增加或变更候选需要重新走
Shadow 与传输验证。

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

当前仓库提供旧代理实现与测试。方案 A 的文档契约已迁移；后续 ticket
会依次实现固定基线链路、Shadow、Active、故障/取消、可重跑实机证据和
配对评估。通过这些验证前，项目不宣称普遍节省，也不提供“安装后即可
自动路由”的承诺。

仓库的 [skills/jev-auto-router/SKILL.md](skills/jev-auto-router/SKILL.md) 是安装与运行的操作说明；Skill 本身不拦截模型调用，路由发生在本地代理中。

### 试运行（原型）

需要 Node.js 22+。以下命令启动本地代理并验证当前代码，不会建立 Codex 的生产代理连接：

```sh
npm ci
npm run build
JEV_API_KEY="<your-key>" \
# Replace with a pair you have successfully requested through this caller edge.
JEV_BASELINE="<verified-model>/<verified-effort>" \
JEV_UPSTREAM_BASE_URL="<authenticated-caller-edge-url>" npm start
curl -s localhost:8787/health          # 路由状态、基线档位、模型目录
npm test                               # 构建并运行全部测试
npm run typecheck
```

把 Codex 的 Responses 流量指向本地代理后，每次调用的路由标签通过响应头 `x-jev-route` / `x-jev-route-source` 返回，`GET /decisions` 查看调用与任务记录。记录包含上游状态、SSE 首个输出增量和完成时间，以及仅供续接核对的工具 ID 摘要；不会保存提示词或工具原文。控制信号（任务 ID、步骤类型、强制模型）通过 `x-jev-*` 请求头传入，不进入转发体。

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
