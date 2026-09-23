# 仓库指南

## 项目结构与模块组织

`src/` 存放 TypeScript 路由器、代理、策略检查和仪表板入口（`src/index.ts`）。相关测试放在 `test/`，文件名采用 `*.test.ts`；共享测试数据位于 `test/routing-fixtures.ts`。`bench/` 存放基准测试夹具和运行程序。设计说明与决策记录分别位于 `docs/sdd/` 和 `docs/adr/`；面向用户的图片位于 `assets/` 和 `docs/assets/`。`skills/jev-auto-router/` 包含可分发的技能文件。`dist/` 是生成目录，不要直接编辑或提交其中内容。

## 构建、测试与开发命令

请使用 Node.js 22 或更高版本。运行 `npm ci` 安装锁定版本的依赖。`npm run typecheck` 检查 TypeScript，不生成文件。`npm run build` 会清理并重新生成 `dist/`。`npm test` 会先构建，再通过 Node 测试运行器执行全部 `test/*.test.ts` 测试。构建后运行 `npm start` 可启动本地代理和仪表板，地址为 `http://127.0.0.1:8787`。运行时配置要求请参阅 `README.md`。

## 编码风格与命名约定

遵循现有 TypeScript 风格：缩进为两个空格，字符串使用双引号，以分号结尾，并在公共接口处明确标注类型。文件名使用 kebab-case（例如 `policy-guard.ts`），函数和变量使用 camelCase，类型和接口使用 PascalCase。为兼容 NodeNext，TypeScript 文件中的本地导入路径使用 `.js` 扩展名。项目未配置格式化或 lint 工具；请保持代码风格与相邻代码一致，并运行 `npm run typecheck`。

## 测试要求

使用 `node:test` 和 `node:assert/strict` 编写行为测试。新增测试文件命名为 `test/<模块名>.test.ts`，测试描述应明确说明预期行为。更改路由决策、隐私检查、代理行为或发布逻辑时，补充或更新相应测试。项目未设置数值化覆盖率门槛；提交变更前请运行 `npm test`。

## 提交与拉取请求规范

近期提交使用简短前缀，例如 `feat:`、`fix:`、`docs(readme):`、`style:` 和 `misc:`，后接简洁的祈使式说明。每个提交聚焦于一项改动。拉取请求应说明行为变化，关联相关 issue 或设计记录，并列出已运行的命令。涉及仪表板的改动请附截图，并说明对配置或发布的影响。

### 任务提交节奏

- 多 ticket 工作中，每完成一个 ticket/task 并通过适用验证后，立即为该任务创建一个聚焦提交，再开始下一项。
- 只提交属于该任务的变更。按用户要求提交未完成进度时，提交说明应标明进度，且不得将 ticket 标记为 `resolved`。

## 安全与配置

启用路由时，代理会读取 `JEV_API_KEY`。不要将密钥写入提交、测试夹具或日志。维护 `src/route-plan.ts` 中的路由状态白名单边界；不要向路由服务发送原始用户文本或工具输出。

## 项目背景与规范

项目背景、目标和代码导览见 [CONTEXT.md](CONTEXT.md)。改动产品行为前，查阅 [spec.md](spec.md) 和唯一运行时策略 [routing-policy.md](skills/jev-auto-router/references/routing-policy.md)；详细方案见 [docs/solution.md](docs/solution.md)。

## Agent skills

### Issue tracker

需求和实施 ticket 保存在本地 `.scratch/`，不发布到 GitHub Issues。见 `docs/agents/issue-tracker.md`。

### Triage labels

本地文件用 `Status:` 记录默认五种 triage 状态。见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用 single-context 结构，以根目录 `CONTEXT.md` 和 `docs/adr/` 为领域文档。见 `docs/agents/domain.md`。
