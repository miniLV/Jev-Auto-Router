<h1 align="center">Jev Auto Router</h1>

<p align="center">
  <strong>Codex 一轮对话，一次模型选择。</strong>
</p>

<p align="center">
  <code>jev-codex</code> 启动真实 Codex CLI，在 model picker 里加入 <code>Jev Auto Router</code>；每个新 user turn 问一次 TypeSafe Jev，模型固定跑完整个 tool loop，effort 用 cache-preserving 的 <code>configuration_update</code> 调整。
</p>

<p align="center">
  <a href="https://github.com/miniLV/Jev-Auto-Router/tags">Releases</a> ·
  <a href="https://minilv.github.io/Jev-Auto-Router/">Homepage</a> ·
  <strong>简体中文</strong> ·
  <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/miniLV/Jev-Auto-Router/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/miniLV/Jev-Auto-Router/actions/workflows/ci.yml/badge.svg" />
  </a>
  <img alt="Release v0.1.0" src="https://img.shields.io/badge/release-v0.1.0-blue" />
  <a href="./LICENSE">
    <img alt="License" src="https://img.shields.io/github/license/miniLV/Jev-Auto-Router" />
  </a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-339933" />
  <img alt="npm publish pending" src="https://img.shields.io/badge/npm-publish%20pending-lightgrey" />
</p>

<p align="center">
  <img src="docs/assets/model-picker-jev-auto.png" alt="Codex model picker with Jev Auto Router" width="860" />
</p>

---

## 30 秒看懂

如果你用 Codex，并且经常用 `frontier + high effort` 处理本来很简单的 turn，这个项目解决的就是这件事：

- **一个 user turn 只问一次 Jev**，不是每次 model call 都问；
- **模型固定**到这一轮的整个 tool loop，避免反复重建 prompt cache；
- **effort 单独调整**，用 `configuration_update` 保留 cache；
- 价格 break-even、缓存热度、session 稳定和升级触发都由本地 policy 决定；
- 支持 **Codex CLI** 和 **Codex app**。

> **当前状态：** `v0.1.0` alpha；64 个确定性测试通过；真实 GPT cache/质量评测还在补。effort routing 默认关闭。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| Turn-pinned routing | 一个 user turn 一次 Jev 决策；tool loop 内模型不变 |
| Effort routing | 模型不变，按 turn 调整 low/medium/high/xhigh/max |
| Cache-aware gates | 价格 break-even、cache 热度、大上下文和 session 稳定保护 |
| Codex CLI | `jev-codex` 启动真实 Codex，并注入 `Jev Auto Router` |
| Codex app | `jev-codex setup-app` 配置本地 provider 和 model catalog |
| Evidence | 64 个确定性测试；真实收益评测计划已落地 |

- 设计文档：[docs/codex-turn-router.md](docs/codex-turn-router.md)
- 评测计划：[docs/evaluation-plan.md](docs/evaluation-plan.md)
- 发布说明：[docs/releasing.md](docs/releasing.md)


## 安装

> [!IMPORTANT]
> npm registry 版本还没有发布；当前请从源码安装。npm 命令在首次发布后可用。

### 从源码（当前可用）

```sh
git clone https://github.com/miniLV/Jev-Auto-Router.git
cd Jev-Auto-Router
npm ci
npm run build
npm link
jev-codex
```

### npm（发布后可用）

```sh
npm install -g jev-auto-router
jev-codex
```

或者：

```sh
npx -y jev-auto-router
```

### Codex app

```sh
jev-codex setup-app
```

然后完全退出并重开 ChatGPT/Codex app，新建 task，选择 `Jev Auto Router`。详见下面的 [Codex app](#codex-app) 和 [发布说明](docs/releasing.md)。

## 结果：model list 里多一个 `jev-auto`

`jev-codex` 不需要 fork Codex。它启动真实的 Codex CLI，注入一个临时 provider；默认启动时，在 Codex CLI 的 model picker / `/model` 里会多出一个虚拟模型：

```text
Jev Auto Router
GPT-6.1-Sol
GPT-6-Astra
GPT-6-Sol
GPT-6-Luna
...
```

选中 `jev-auto` 才会自动路由；直接选真实模型会绕过路由。这是这个项目最直观的集成结果：**model list 里多一个 entry，而不是一套新的 agent。**

注意：

- 需要 `JEV_API_KEY` / `TYPESAFE_API_KEY`。没有 key 时 `jev-codex` 会启动 Codex 但不启用路由，model list 里不会出现 `jev-auto`。
- Codex app 通过同一套本地 provider 接入；用 `jev-codex setup-app` 配置。
- 实际列表取决于你的账号目录；上例展示最新的 GPT-6 阵容，旧账号可能只看到其中一部分。

### Codex app

![Codex app model picker with Jev Auto Router](docs/assets/codex-app-model-picker.png)

Codex app：新建 task 后选择 Jev Auto Router；已有 task 会保留原来的 provider。

配置 Codex app（macOS 的 ChatGPT/Codex app）：

```sh
jev-codex setup-app
```

这个命令会：

- 备份 `~/.codex/config.toml`；
- 写入 `model_provider = "jev"` 和本地 provider；
- 生成包含 `Jev Auto Router` 的 model catalog；
- 启动本地 proxy。

然后**完全退出** ChatGPT/Codex app（`Cmd+Q`），重新打开，**新建一个 task**，在 model picker 里选择 `Jev Auto Router`。


## 为什么是 turn，而不是每次 model call

```text
Session
└─ Turn：你发一句话 -> 最终回答
   ├─ Model Call 1
   ├─ Tool Call / Tool Result
   ├─ Model Call 2
   └─ ...
```

- **Model Call**：模型被请求一次。工具结果回来后再请求一次，就是新的 Model Call。
- **Tool Loop**：模型 → 工具 → 模型 的来回。
- **Turn**：你发一句话，到它最后答完。

每次切模型都会让新模型重建 prompt prefix。把决策放在 turn 开头、把模型固定在 tool loop 内，能把切换成本压到“每个 user turn 最多一次”，也避免模型在任务中途反复变化。

模型固定之后，effort 可以独立调整：用 `configuration_update` 改变思考档位，保持 request-level effort 不变，并把历史 update 原地重放。当前实现是 **per-turn effort**，不是 per-step；这样不需要额外的逐调用分类器，也不会为了 effort 切模型。

![Turn Router 主流程](docs/assets/codex-turn-router-flow.png)

![Turn Router 控制回路](docs/assets/codex-turn-router-control-plane.png)

主流程：新 turn → Jev 一次 → 政策闸门 → 固定模型 → tool loop。控制回路：选 → 闸 → 跑 → 学。

## 价值：先降 effort，再降 model

同一个 5-turn 任务，三种花法：

- **A**：永远 frontier + high，最贵；
- **B**：每次调用换 model，省单价，但多出一块 prefix 重建；
- **C**：模型固定、按 turn 调 effort，cache 保留，routine turn 少烧 reasoning。

![同一个 5-turn 任务，三种花法](docs/assets/codex-turn-router-tradeoffs.png)

这是示意，不是实测账单。真实收益取决于 cache 命中率、output/reasoning 占比和质量。它解释了这个项目最核心的取舍：**effort 是第一杠杆，模型切换要等 break-even。**

> [!WARNING]
> Alpha：effort routing 默认关闭，且 `configuration_update` 的实机 cache 行为还没有在真实 Codex + GPT 会话中验证。先设 `JEV_CODEX_EFFORT_ROUTING=turn` 做一次小任务 smoke，再长期开启。

## 运行

需要 Node.js 22+、已登录的 Codex CLI、TypeSafe Jev key。

```sh
npm ci
npm run build
export JEV_API_KEY="<your-typesafe-jev-key>"
node bin/jev-codex.mjs
```

也可以：

```sh
npm run codex      # 构建并启动包装器
npm link && jev-codex
```

所有参数原样转交给 Codex：

```sh
jev-codex resume --last
jev-codex exec "fix the failing test"
```

没有 `JEV_API_KEY` 时，`jev-codex` 会正常启动 Codex，只是不启用路由。

## 一轮里发生什么

```text
你发一句话
  -> jev-codex 包装器启动真实 Codex，注入临时 provider
  -> 代理识别 fresh user turn
  -> 问 Jev 一次：prompt + 当前模型 + 上下文大小 + 候选模型
  -> 政策闸门：用户指定 / 低置信 / 不可用 / 价格 break-even / 稳定保护
  -> 固定本轮模型 + 选择 effort
  -> effort 用 configuration_update；模型不变
  -> tool loop 全部复用该模型，不再问 Jev
  -> 下一个 user turn 再判断
```

用户显式选择具体模型时，请求原样透传，暂停自动路由；重新选择 `jev-auto` 恢复。

## 政策

- 用户说 `use <tier>` / `use <model>`：用户优先。
- Jev 失败、超时、答案非法或低置信：保持当前模型。
- 低置信不降级；升级最多到 balanced。
- 上下文超过阈值时，拒绝降级；升级仍可能。阈值是启发式，两个方向都要重建缓存。
- 会话稳定保护：超过 12 个 fresh turn 后停止自动切换；每次切换后至少稳定 1 个 turn；可选切换次数上限。
- 会话空闲超过 30 分钟后，稳定保护重置；模型仍保持，但下一轮可以重新评估。
- 配了价格表时，降级改算 break-even；没配价格表才回退到固定上下文阈值。
- 缓存热度从响应 usage 观测；冷缓存时降级可以绕过重建门槛。
- 升级默认需要触发条件：近期失败、Jev 高复杂度信号，或用户显式指定。
- 目标 tier 不可用：升到最近的可用 tier。
- long tier 默认关闭，需要 `JEV_CODEX_ALLOW_LONG=1`。
- 用户显式 `use ...` 永远绕过上述稳定保护。

## 配置

完整配置见 [docs/codex-turn-router.md](docs/codex-turn-router.md)。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | 路由时必填 | Jev 密钥 |
| `JEV_MODEL` | `jev-1.13.0` | Jev 模型 |
| `JEV_CODEX_FAST_MODEL` | `gpt-6-luna` | fast tier |
| `JEV_CODEX_BALANCED_MODEL` | `gpt-6-sol` | balanced tier |
| `JEV_CODEX_STRONG_MODEL` | `gpt-6.1-sol` | strong tier |
| `JEV_CODEX_LONG_MODEL` | `gpt-6-astra` | long tier（默认关闭） |
| `JEV_CODEX_DOWNGRADE_MAX_CONTEXT_TOKENS` | `20000` | 大上下文降级闸门 |
| `JEV_CODEX_LOCK_AFTER_TURNS` | `12` | 超过 N 个 turn 后停止自动切换（0 = 关闭） |
| `JEV_CODEX_MAX_SWITCHES` | `0` | 每个 session 最多切换次数（0 = 不限） |
| `JEV_CODEX_SWITCH_COOLDOWN_TURNS` | `1` | 切换后至少稳定几个 turn |
| `JEV_CODEX_CACHE_TTL_MS` | `1800000` | 空闲多久后重置稳定保护 |
| `JEV_CODEX_EFFORT_ROUTING` | `off` | 设为 `turn` 才启用每轮 effort |
| `JEV_CODEX_EFFORT_CAP` | `high` | effort 上限 |
| `JEV_CODEX_EFFORT_FALLBACK` | `high` | 没有评分时的回退档位 |
| `JEV_CODEX_PRICES` | 未设置 | 每个模型的价格 JSON，用于 break-even |
| `JEV_CODEX_TASK_TURN_BUDGET` | `0` | 预估任务总 turn 数（0 = 关闭） |
| `JEV_CODEX_UPGRADE_MODE` | `triggered` | 升级触发模式 |
| `JEV_CODEX_SESSION_FILE` | `~/.codex-router/sessions.json` | 持久化 session pin |
| `JEV_CODEX_STRIP_ENCRYPTED_REASONING` | off | 跨模型时移除 encrypted reasoning |
| `JEV_CODEX_COMMENTARY` | `1` | 在 Codex 中显示路由结果 |
| `JEV_CODEX_LOG_FILE` | `~/.codex-router/decisions.jsonl` | 脱敏决策日志 |

决策日志只保存 prompt hash、长度、模型、tier、置信度、原因、上下文大小和 Jev 分数，不保存 prompt 原文。

## 开发

```sh
npm run typecheck
npm test
npm start          # 只启动代理，便于调试
```

代码结构：

```text
src/codex-router/
├─ cli.ts       启动真实 Codex，注入临时 provider
├─ proxy.ts     /models 注入、turn 识别、模型固定、流式转发
├─ policy.ts    用户覆盖、置信度、可用性、缓存降级闸门
├─ turn.ts      fresh user turn 识别与 conversation key
├─ jev.ts       Jev 请求构造、超时、重试、响应解析
├─ config.ts    tier、环境变量、候选模型
├─ cache.ts     价格 break-even 与动态锁
├─ effort.ts    effort 映射、configuration_update 重放
├─ usage.ts     响应 usage / 缓存热度扫描
├─ session-store.ts  持久化 session pin
├─ log.ts       脱敏 JSONL 决策日志
└─ types.ts     共享类型
```

## 已知边界

- 上下文大小是 input 序列化长度的估算，不包含 tools；阈值是启发式，不是精确 token 数。
- 价格 break-even 需要自己提供价格表；没有价格表时回退到固定上下文阈值。
- session pin 已持久化，但只在本机/本用户生效；跨机器仍会重新判断。
- break-even 使用输出估算和剩余 turn 估算，不是供应商账单。
- encrypted reasoning 清理是 opt-in，压缩行为仍需要实机验证。
- commentary 会修改 Codex 事件流；需要字节级原样转发时设 `JEV_CODEX_COMMENTARY=0`。

## 发布与版本

- 当前版本：`0.1.0`
- Git tag：`v0.1.0`
- npm registry：**尚未发布**
- 发布流程：[docs/releasing.md](docs/releasing.md)
- CI：`.github/workflows/ci.yml`
- Release workflow：`.github/workflows/release.yml`（tag `v*` 或手动触发）

## License

[Apache License 2.0](LICENSE)
