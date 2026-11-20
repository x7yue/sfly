# Parallel work in sfly

How every subagent sets up its worktree, runs heavy commands and pushes when several run at once. Machine-specific values (which short directory to use, how much memory there is) come from memory, not from here.

## Worktree setup

- Run `pnpm bootstrap` in each new worktree: dependencies live per worktree, and the pre-push hook rejects a push from a worktree without them.
- Create worktrees side by side under one parent directory.
- After merging the integration branch or a ticket branch, check whether `pnpm-lock.yaml`, `uv.lock` or `Cargo.lock` changed (`git diff --name-only <commit before the merge> HEAD`). If one did, rerun `pnpm bootstrap` before typecheck or tests: without it typecheck reports the newly added dependency as not found. The pre-push hook stops a push on the same mismatch, but only at push time.

## Heavy commands

The full test suite, `pnpm test:e2e*` and `pnpm perf` slow each other down when they overlap. That produces timing flakes, and `pnpm perf` numbers go wrong (a 4-minute soak once reported a backlog that wasn't there). Run one at a time, queued on a single lock file that all subagents share. `pnpm heavy` does this, and sets the temporary paths below:

```bash
pnpm heavy pnpm test
pnpm heavy --pg pnpm --filter @sfly/server test   # this run gets its own PostgreSQL container
```

It runs the command in the foreground under `flock -o`. `-o` keeps the lock out of the command's child processes; without it, a process a test leaves behind holds the lock and every queued command hangs. It does not lock on CI (`CI` is set). On macOS `flock` comes from Homebrew (`brew install flock`). Defaults: lock `~/.t/sfly-heavy.lock`, short directories under `~/.t`. The lock stays at that fixed path so every worktree queues on the same one; only `SFLY_HEAVY_LOCK` moves it (`none` skips the lock). `SFLY_HEAVY_TMP_ROOT` moves only the short directories.

Run `pnpm perf` and `pnpm perf:soak` only when no other heavy command is running.

The shared `sfly-pg` accepts 100 connections, and every control-plane test run opens many. Several worktrees testing at once fail with `too many clients`. `--pg` starts a `postgres:18` container just for that run (random port, removed when the command ends) and points `DATABASE_URL` at it. The test support code already creates one random database per test file from `DATABASE_URL`, so nothing else changes. Use it when more than one worktree runs control-plane tests or e2e. `pnpm linux` has its own `sfly-linux-pg` and ignores it.

## End-to-end tests

- Run a single end-to-end file as `pnpm test:e2e <file>`. A `--` before the file makes it run the whole suite.
- Visual regression screenshots (`apps/web/e2e/__screenshots__/`) that conflict in a merge are regenerated rather than taken from either side. Merge the source files first, then run `pnpm test:e2e:docker e2e/visual.spec.ts --update-snapshots` in the Playwright image, and open the diff images. Done when every changed screenshot's difference traces to a change made on one of the two merged sides.

## Shared files

Several tickets often add commands to the same command group or the same registry. Give each ticket its own new module (and its own new test file) and let the shared entry point gain only its one registration line; merges then conflict only on those lines.

Keep one list of the helpers already merged (module, function, one-line purpose) in the shared notes every subagent reads, and update it after each merge. A ticket that needs a formatter, lookup or client call imports it from that list rather than writing a sibling copy.

## Finishing a turn

Stop every `Monitor` and background command you started before the final report. One left running wakes the orchestrator again later with nothing new.

## Temporary paths

Tests create Unix sockets, and a socket path longer than 108 bytes fails with `AF_UNIX path too long`. `pnpm heavy` handles both cases below, with one pair of directories per worktree (named after the worktree directory): `~/.t/<worktree>` and `~/.t/<worktree>-target`. `pnpm heavy --clean` removes them, unless a `pnpm heavy` of that worktree is still running (it also removes this worktree's leftover `--pg` containers whose run has ended). Two checkouts with the same directory name in different places share one pair of directories and one container label, so give each checkout a different directory name. Outside `pnpm heavy`, do it by hand:

- Point `TMPDIR` at a short directory; pytest and the control-plane tests use it.
- Agent tests put sockets under `target/tmp/`, as deep as the worktree path. In a deep worktree, point `CARGO_TARGET_DIR` at a short directory too.

## Pushing

- A push from a worktree runs the pre-push hook: the target branch name must have an agreed prefix (`docs/agents/branching-and-release.md`, "分支命名"; push a `cindy/<name>` branch as `git push origin HEAD:<prefix>/<description>`), then version, generated code, lint and typecheck. It does not run tests; CI does, on branches that have a PR (a draft counts).
- When the pre-push check already passed and only the network dropped, retry with `--no-verify`.

## CI and merging

- Wait for a PR's checks with `gh pr checks <number> --watch`.
- Read a failed CI run with `scripts/ci-failures.sh <run id>`: it prints only the failing tests and their assertion diffs.
- A branch started on top of another unmerged branch conflicts with `main` once the base is squash-merged. Confirm that `main` matches the base branch for those files, then keep this branch's side.
