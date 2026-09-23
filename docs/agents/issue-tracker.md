# Issue tracker: Local Markdown

本仓库的 spec 和实施 ticket 保存在本地 `.scratch/`，不发布到 GitHub Issues。

## Conventions

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- Spec 位于 `.scratch/<feature-slug>/spec.md`。
- 实施 ticket 分别放在 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号；不要合并成一个 ticket 文件。
- 文件开头附近用 `Status:` 记录 triage 状态，状态名称见 `triage-labels.md`。
- 如需记录讨论，在文件末尾的 `## Comments` 下追加。

## Skill operations

- “Publish to the issue tracker”：创建或更新功能目录中的本地 Markdown 文件。
- “Fetch the relevant ticket”：读取用户给出的 ticket 路径或编号对应的本地文件。
- `/to-spec` 发布到本地 `spec.md` 并标记 `Status: ready-for-agent`；不调用 `gh issue create`。

## Wayfinding

- Map 位于 `.scratch/<effort>/map.md`；子 ticket 位于 `.scratch/<effort>/issues/NN-<slug>.md`。
- 子 ticket 用 `Type:` 表示 `research`、`prototype`、`grilling` 或 `task`，用 `Status:` 表示 `claimed` 或 `resolved`。
- 用 `Blocked by: NN, NN` 记录阻塞关系；所有阻塞 ticket 都为 `resolved` 后才可领取。
- 领取时先写 `Status: claimed`；解决时追加 `## Answer`、写 `Status: resolved`，再把摘要和链接加入 map。
