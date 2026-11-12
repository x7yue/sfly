---
name: sfly-implement-spec
description: "Implement an sfly spec and its tickets in parallel on one integration branch: the user-level implement-spec, adapted to this repo."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec. The issue tracker is described in `docs/agents/issue-tracker.md`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Start every subagent with a fresh context window.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, previous commits, and [references/parallel-work.md](references/parallel-work.md), which every subagent follows for worktree setup, heavy commands and pushing. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph. Find **shared helpers**: code that several frontier tickets would each need (process handling, parameter validation, polling). Have the first of those tickets build them and hold its siblings until it merges; parallel implementers otherwise each write their own copy, and code review sends the duplicates back. Done when every formatter, lookup or client call that two or more tickets will use has a named owning ticket, and the siblings' briefs point at it.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch (`spec/<issue>-<description>`, see `docs/agents/branching-and-release.md`). Open a draft PR after the first merge in step 5 (a branch with no commits ahead of main can't open one), marked as closing the spec and tickets.

4. Use a fresh **implementer subagent** for each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - writes a failing test for each acceptance criterion before the code that makes it pass, at the seam the spec's Testing Decisions name;
   - runs long checks (full test suites, e2e, `pnpm perf`) in the foreground and ends its turn only with its final report: every early stop wakes the orchestrator with nothing to act on;
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its work to the integration branch with a **merger subagent**. Push the integration branch after a batch of merges rather than after each one: every push runs the full pre-push check.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, call the Skill tool with `code-review` on the integration branch. The Standards axis covers `CODING_STANDARDS.md` and the terms in `GLOSSARY.md`: user-facing text (docs, UI copy, log and error messages, PR titles) uses the glossary term and avoids its `_Avoid_` wording for that concept. Fix all issues raised by the code review in a single fresh **implementer subagent**.

8. Mark the draft PR ready for review once its checks pass. Merging into `main` waits for the user.

9. Clean up all **implementer subagent** worktrees.
