# Triage 标签

每个 issue 带一个分类标签和一个状态标签，状态标签的名字就是 triage 的状态名，没有改名。

## 分类

- `bug`：功能不对。
- `enhancement`：新功能或改进。
- `documentation`：只改文档。

## 状态

- `needs-triage`：维护者要评估这个 issue。
- `needs-info`：等提交者补充信息。
- `ready-for-agent`：规格完整，可以交给代理独立完成。
- `ready-for-human`：需要人来实现。
- `wontfix`：不处理。

## 路线图

路线图的 issue 在分类和状态之外加 `roadmap`：工作在 `dev` 上做，PR 以 `dev` 为目标（规则见 [branching-and-release.md](./branching-and-release.md)「`dev`（强制）」）。

- `roadmap`：路线图的 issue。
- `needs-decision`：要团队讨论、负责人决定后才能动手。决定写进这个 issue 的评论。
- `merged-to-dev`：PR 已合入 `dev`、issue 已关闭，改动还没到 `main`。
