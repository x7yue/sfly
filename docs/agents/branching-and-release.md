# 分支、PR 与发版

GitHub 上的规则集（`gh api repos/x7yue/sfly/rulesets`）强制执行下面带「强制」的条目；改动规则集时同步更新本文。

## `main`（强制）

- 只能经 PR 以 squash 方式合入，必须通过 CI 的 `check` 与 `e2e`；不能直接推送、强制推送或删除。
- 没有任何人可以绕过，包括代理：代理用的是维护者自己的 GitHub 身份，给维护者留的绕过权限代理也能用。
  紧急情况下由维护者在仓库设置里临时停用规则集 `main`，处理完立即恢复。
- 不要求 PR 基于最新的 `main`：合入后 `main` 上的 CI 仍会运行，发版前要求它通过。

## 分支命名

| 前缀 | 用途 |
|---|---|
| `spec/<issue>-<描述>` | 大功能的规格与实现（推送时也运行 CI） |
| `impl/<描述>` | 大功能拆出的实现分支（推送时也运行 CI，供合并前验证） |
| `design/<描述>` | 设计文档、原型、ADR |
| `fix/<issue>-<描述>` | 修复缺陷 |
| `chore/<描述>` | 工具链、CI、开发环境、文档 |
| `release/X.Y.Z` | 只改版本号，为发版做准备 |

Cindy worktree 自动生成的 `cindy/<名字>` 分支，推送前改成上面的前缀：`git push -u origin HEAD:<前缀>/<描述>`。

## PR

- 标题用祈使句：squash 合入后它就是 `main` 上的提交标题（GitHub 自动追加 ` (#编号)`），各提交的信息成为正文。
- 加上分类标签，Release 说明按它分组（`.github/release.yml`）：`enhancement` 新功能、`bug` 修复、`documentation` 文档；其余归入「其他」。
- 用 `gh pr merge <编号> --auto --squash` 合入：CI 通过后自动合入并删除分支，不用守着 CI。

## 发版

1. 从 `main` 新建 `release/X.Y.Z`，运行 `pnpm release:version set X.Y.Z`，提交并开 PR 合入。
2. 等 `main` 上这个提交的 CI 通过，在它上面打 tag 并推送：`git tag vX.Y.Z <提交> && git push origin vX.Y.Z`。
3. `.github/workflows/release.yml` 接手：校验版本号、确认提交在 `main` 上且 CI 已通过，构建并发布（产物见 README「发布」）。

- 版本号：0.x 阶段新功能升次版本号，修复升补丁版本号；只支持 `X.Y.Z`（ADR 0010）。
- 只发布 `main` 上的提交，不维护旧版本的修复分支：有问题就修复后发新的补丁版本。
- `v*` tag 推送后不能更新或删除（强制），Release 发布后附件与 tag 都不能修改（Immutable releases）。发错版本时，发一个新的补丁版本。
