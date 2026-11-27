# Issue 跟踪：GitHub

issue 和规格在 `x7yue/sfly` 的 GitHub Issues 里，操作都用 `gh`（在仓库里运行时它自己推断仓库）。标签的含义见 [triage-labels.md](./triage-labels.md)。

## Conventions（操作）

这些操作在 GitHub 上做，不经过仓库，没有检查。

- **创建 issue**：`gh issue create --title "…" --body "…"`，多行正文用 heredoc。
- **读 issue**：`gh issue view <编号> --json number,title,body,labels,comments`。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label`、`--state`。
- **评论**：`gh issue comment <编号> --body "…"`。
- **加、去标签**：`gh issue edit <编号> --add-label "…"` / `--remove-label "…"`。
- **子 issue**：`gh issue create --parent <父编号> …`，或事后 `gh issue edit <父编号> --add-sub-issue <子编号>`。没有挂成子 issue 时，子 issue 正文第一行写 `Part of #<父编号>`。
- **阻塞关系**：用 GitHub 原生的依赖：`gh issue create --blocked-by <编号>,<编号> …`，或 `gh issue edit <子编号> --add-blocked-by <阻塞者编号>`。阻塞者全部关闭，这张票才能开工。
- **还有几个阻塞者没关**：`gh api repos/x7yue/sfly/issues/<编号> --jq .issue_dependencies_summary.blocked_by`，0 表示能开工。
- **关闭**：先 `gh issue comment` 写明原因，再 `gh issue close <编号>`。对已经关闭的 issue 用 `gh issue close --comment`，评论会丢，退出码仍是 0。
- **编号**：issue 和 PR 共用一个编号空间，裸 `#42` 可能是任何一个：先 `gh pr view 42`，失败再 `gh issue view 42`。
- **读 PR**：`gh pr view <编号> --json title,body,labels,comments`、`gh pr diff <编号>`。不在终端里时 `gh pr view --comments` 只打印评论、不打印正文，要正文用 `--json body`。

## 用 PR 关闭 issue

靠判断：PR 是做完了 issue 还是只做了一部分要看范围；关闭和加标签在合入之后手动做，CI 管不到。

- PR 合入 `main`：正文写 `Closes #<编号>`，合入后自动关闭。
- PR 合入 `dev`（带 `roadmap` 标签的 issue）：正文第一行写 `Part of #<编号>`。`Closes` 只在合入默认分支时生效，所以合入后手动关闭 issue，评论的写法见 [branching-and-release.md](./branching-and-release.md)「`dev`（强制）」。关闭时同时加标签 `merged-to-dev`：

  ```sh
  gh issue comment <编号> --body "已合入 \`dev\`（#<PR 编号>），随 \`dev\` 进 \`main\`"
  gh issue edit <编号> --add-label merged-to-dev
  gh issue close <编号>
  ```

## Pull requests as a triage surface（PR 不进 triage）

**PRs as a request surface: no.** 外部 PR 不当作需求，不走 triage 的标签和状态。靠判断：要看提交者是谁、改动是什么。

## skill 里的说法

- 「发布到 issue 跟踪器」（publish to the issue tracker）：创建一个 GitHub issue。
- 「取相关工单」（fetch the relevant ticket）：按上面的「读 issue」读。
