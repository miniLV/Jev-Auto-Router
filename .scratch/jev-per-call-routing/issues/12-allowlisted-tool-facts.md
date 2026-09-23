# 12 — 校验外部路由事实并忽略伪造工具头

**What to build:** 发给 Jev 的外部路由事实都经过有限词汇和来源校验；客户端伪造的工具头或任意字符串不能改变工具身份、路由资格或 Active 选择。

Blocked by: None — can start immediately.

Blocks: 03 — Shadow Jev Choice；06 — 真实 Codex 证据。

Status: resolved

Related: `src/index.ts` 的 `x-jev-tool-facts`、`x-jev-step`、`x-jev-current-model` 等控制头解析；`src/route-plan.ts` 的 `ToolFacts` 与 `checkSendEligibility()`；策略 §4。

## Problem

当前入口只检查 `tool_name` 是字符串，随后把它和 `error_codes.map(String)` 直接装入 Routing State。头部内容由请求方控制，允许任意长度和词汇；`x-jev-current-model` 也是未经核对的字符串。敏感检查主要覆盖用户输入，不能保证这些字段安全。

## Solution

1. 停止把 `x-jev-tool-facts` 当作工具事实来源。当前代理没有可证明可信的本地工具名称、退出状态或错误码来源；先从 Jev 状态中省略这些字段，不新增认证或签名协议，也不猜测工具执行结果。
2. 在唯一的 Routing State 构造边界保持有限 schema：将来只有经既有可信本地观察产生、且属于明确允许词汇与大小上限的事实才能外发。原始 stderr、工具输出、路径、命令行和任意错误描述始终留在本地。
3. 逐项验证其余外部控制事实：`step_type` 必须是既定枚举；`current_model` 必须是当前已知的真实模型 ID；`forced_model` 不得是任意提示文字。未知或非法值不能直接进入 Jev 状态或改变候选约束。布尔头只接受明确定义的值。
4. 工具事实缺失时可继续使用其他足够的获准事实；若没有其他决策事实，按 `insufficient_routing_facts` 执行基线。不要把工具结果 ID 摘要误作工具成功或失败证据。
5. 用受控 transport 捕获外发请求，测试正常工具结果请求、伪造敏感头、畸形 JSON、超长列表、任意 `current_model` 文本及无事实回退。确认这些头不能改变工具身份、候选集合或 Active 资格，而原生工具结果和 ID 仍原样传给 caller edge。

## Acceptance criteria

- [x] 当前没有可信工具事实来源时，Jev 载荷不含 `x-jev-tool-facts` 提供的值；任意头部文本不能原样出站。
- [x] `step_type`、`current_model`、`forced_model` 与布尔控制头经各自有限取值校验，未知字符串不进入 Jev 载荷或候选硬约束。
- [x] 无合格工具事实时不据其发起 Choice；本地固定基线与原生工具结果转发不受影响。
- [x] 测试覆盖对象/数组、敏感标记和超长输入，并证明伪造头不能改变 Active 资格或候选集。

## Boundaries and verification

不增加读取原始工具输出的新通道，也不把普通文本截短后当作获准事实。先运行隐私/HTTP 定向测试，再运行 `npm test` 和 `npm run typecheck`。

## Answer

- HTTP 入口不再解析 `x-jev-tool-facts`；没有可信工具事实来源时，Routing State 不定义或携带工具事实。Routing State 与 Choice schema 已升至 `/2`。
- `step_type` 只接受既定枚举；`current_model` 必须是有界且 catalog 已知的真实模型 ID；`forced_model` 还须对应当前 requestable、允许的候选 pair。上下文桶只接受 `small`、`medium`、`large`；布尔控制头只识别 `1`/`0`。非法值被忽略或归为 `other`，不进入 Jev 或改变候选集。
- 没有获准 Routing State 事实时跳过 Jev，记录 `insufficient_routing_facts` 并执行固定基线。工具结果正文和调用 ID 仍按原样传给 caller edge。
- HTTP transport 测试捕获了完整 Jev 请求，并覆盖 JSON 对象、数组、畸形 JSON、敏感标记、200 项错误码列表和约 9.6 KB 文本；也验证无事实回退、Active 候选集不变和原生工具结果保真。
- 验证通过：定向隐私/HTTP/Route Plan 测试 33 项；`npm test` 156 项；`npm run typecheck`；`git diff --check`。
- 外部证据缺口：本票用本机 Jev 和 caller-edge stubs 验证 HTTP 行为；未运行真实认证 caller edge、真实 Jev 服务或真实 Codex 会话。当前没有可信工具事实观察器，故工具事实仍为空。
