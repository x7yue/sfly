# Triage 标签

每个 issue 带一个分类标签和一个状态标签，状态标签的名字就是 triage 的状态名，没有改名。带 `later` 的 issue 例外，见下面的「以后再做」。
标签靠人打和摘，没有检查：选哪一个要读懂 issue。

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
- `merged-to-dev`：PR 已合入 `dev`、issue 已关闭，改动还没到 `main`。合入 `dev` 之后，关闭 issue 的人在关闭时加上它（命令见 [issue-tracker.md](./issue-tracker.md)「用 PR 关闭 issue」）；`dev` 合入 `main` 之后，由做那次合入的人把带这个标签的 issue 批量摘掉（issue 保持关闭）。

## 以后再做

- `later`：以后再做。审查和实现时带出来、这一轮不做的事：加固、边界情况、偶发失败的测试、措辞和收尾。它们不进当前的队列，也不归到哪个路线图阶段。
- **谁打**：开这种 issue 的人在开的时候打。一般是审查的人、或者做 PR 时发现了顺手不改的人；负责人整理审查结果时也会打。
- **和状态标签的关系**：`later` 代替状态标签。带 `later` 的 issue 不再要 `needs-triage`、`ready-for-agent` 这些，triage 时不要把它们当成漏打了状态。要排进队列时摘掉 `later`，按上面的规则打上状态标签；是路线图的工作，再加 `roadmap`。
- **安全问题不打 `later`**：凭据、访问控制、打码这类问题照常打状态标签进队列，不留到以后。
