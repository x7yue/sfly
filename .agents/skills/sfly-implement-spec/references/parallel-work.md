# Parallel work in sfly

How every subagent sets up its worktree, runs heavy commands and pushes when several run at once.

## Worktree setup

- Run `pnpm bootstrap` in each new worktree: dependencies live per worktree, and the pre-push hook rejects a push from a worktree without them.
- Create worktrees side by side under one parent directory, each with a different directory name: `pnpm heavy` keys its short directories on it.
- After merging the integration branch or a ticket branch, check whether `pnpm-lock.yaml`, `uv.lock` or `Cargo.lock` changed (`git diff --name-only <commit before the merge> HEAD`). If one did, rerun `pnpm bootstrap` before typecheck or tests: without it typecheck reports the newly added dependency as not found. The pre-push hook stops a push on the same mismatch, but only at push time.

## Heavy commands

Run the full test suite, `pnpm test:e2e*`, `pnpm perf*` and a whole `pnpm linux` run as `pnpm heavy <command>`, in the foreground. Overlapping heavy commands cause timing flakes and wrong `pnpm perf` numbers; `pnpm heavy` queues them on one lock shared by every worktree.

- Control-plane tests or e2e in more than one worktree at once: `pnpm heavy --pg <command>`. The shared `sfly-pg` stops accepting connections at 100 (`too many clients`); `--pg` gives the run its own PostgreSQL.
- Done with a worktree: `pnpm heavy --clean`.
- A command you run outside `pnpm heavy` (a single test file, say): set `TMPDIR` and `CARGO_TARGET_DIR` to short directories yourself, because a Unix socket path over 108 bytes fails (`AF_UNIX path too long`).
- What `pnpm heavy` does and its environment variables: the header of `scripts/heavy.sh`.

## End-to-end tests

- Run a single end-to-end file as `pnpm test:e2e <file>`. A `--` before the file makes it run the whole suite.
- Visual regression screenshots (`apps/web/e2e/__screenshots__/`) that conflict in a merge are regenerated rather than taken from either side. Merge the source files first, then run `pnpm test:e2e:docker e2e/visual.spec.ts --update-snapshots` in the Playwright image, and open the diff images. Done when every changed screenshot's difference traces to a change made on one of the two merged sides.

## Shared files

Several tickets often add commands to the same command group or the same registry. Give each ticket its own new module (and its own new test file) and let the shared entry point gain only its one registration line; merges then conflict only on those lines.

Keep one list of the helpers already merged (module, function, one-line purpose) in the shared notes every subagent reads, and update it after each merge. A ticket that needs a formatter, lookup or client call imports it from that list rather than writing a sibling copy.

## Finishing a turn

Stop every `Monitor` and background command you started before the final report. One left running wakes the orchestrator again later with nothing new.

## Pushing

- A push from a worktree runs the pre-push hook: the target branch name must have an agreed prefix (`docs/agents/branching-and-release.md`, "分支命名"; push a `cindy/<name>` branch as `git push origin HEAD:<prefix>/<description>`), then version, generated code, lint and typecheck. It does not run tests; CI does, on branches that have a PR (a draft counts).
- When the pre-push check already passed and only the network dropped, retry with `--no-verify`.

## CI and merging

- Wait for a PR's checks with `gh pr checks <number> --watch`.
- Read a failed CI run with `pnpm ci:failures <run id>`: it prints only the failing tests and their assertion diffs.
- A branch started on top of another unmerged branch conflicts with the PR's target branch (`dev` or `main`) once the base is squash-merged. Confirm that the target branch matches the base branch for those files, then keep this branch's side.
