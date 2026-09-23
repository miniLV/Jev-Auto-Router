# Domain Docs

本仓库采用 single-context 结构。工程技能探索代码前，先读根目录 `CONTEXT.md`，再读当前主题相关的 `docs/adr/` 决策记录；缺失的文档无需预先创建。

描述领域概念时沿用 `CONTEXT.md` 的术语，如 Main Task、Model Call、Routing State、Candidate Pair 和 Route Decision。若新方案与已接受的 ADR 冲突，应在 spec 中明确指出并在实施前更新决策，不要默默覆盖。

当前产品规范及唯一运行时策略分别由根目录的产品 spec 和路由策略文档承担。
方案 A 已于 2026-09-23 迁移为正式契约；本地草稿、旧 SDD 和原型行为不能
与它混合作为运行时依据。
