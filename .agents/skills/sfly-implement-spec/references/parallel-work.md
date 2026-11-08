# Parallel work in sfly

How every subagent sets up its worktree, runs heavy commands and pushes when several run at once. Machine-specific values (which short directory to use, how much memory there is) come from memory, not from here.

## Worktree setup

- Run `pnpm bootstrap` in each new worktree: dependencies live per worktree, and the pre-push hook rejects a push from a worktree without them.
- Create worktrees side by side under one parent directory.

## Heavy commands

The full test suite, the pre-push hook, `pnpm test:e2e*` and `pnpm perf` slow each other down when they overlap. That produces timing flakes, and `pnpm perf` numbers go wrong (a 4-minute soak once reported a backlog that wasn't there). Run one at a time, queued on a single lock file that all subagents share:

```bash
flock -o <lock file> git push -u origin <branch>
flock -o <lock file> pnpm test
```

`-o` keeps the lock out of the command's child processes. Without it, a process a test leaves behind holds the lock and every queued command hangs.

Run `pnpm perf` and `pnpm perf:soak` only when no other heavy command is running.

## Temporary paths

Tests create Unix sockets, and a socket path longer than 108 bytes fails with `AF_UNIX path too long`:

- Point `TMPDIR` at a short directory; pytest and the control-plane tests use it.
- Agent tests put sockets under `target/tmp/`, as deep as the worktree path. In a deep worktree, point `CARGO_TARGET_DIR` at a short directory too.

## Pushing

- A push from a worktree runs the full check (about 5 minutes).
- Save each push attempt to its own log (`git push … 2>&1 | tee <log>`). A flaky failure needs the first attempt's assertion diff, and a retry replaces what the terminal shows.
- When the pre-push check already passed and only the network dropped, retry with `--no-verify`; CI runs the full check again.

## CI and merging

- Wait for a PR's checks with `gh pr checks <number> --watch`.
- A branch started on top of another unmerged branch conflicts with `main` once the base is squash-merged. Confirm that `main` matches the base branch for those files, then keep this branch's side.
