Agents must communicate with the user in Chinese.

## Agent skills

Each skill lives in `.agents/skills/<name>/` (Codex reads that directory); `.claude/skills/<name>` is a symlink to it (Claude Code reads that one). Edit files under `.agents/skills/`. A new skill is a directory there plus `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.

- `sfly-implement-spec`: implement a spec and its tickets in parallel on one integration branch. Use it instead of the user-level `/implement-spec`.
- `verify-sfly`: drive a real control plane, Agent and Web console to prove a change works, when tests alone are not enough evidence. Use it after changing the frontend, control plane, Agent or SDK. Runs on Linux only.
- `verify-task-dispatch`: model-check the task dispatch protocol with TLC. Use it after changing dispatch, result, heartbeat, lease or retry logic in `apps/server/src/engine/`, the Hello/Welcome handling, `serve` loop or task ledger in `agent/src/`, or the matching messages in `proto/sfly/agent/v1/agent.proto`.

Done when `ls .agents/skills/*/SKILL.md .claude/skills/*/SKILL.md` lists all three skills under both directories and `git ls-files -s .claude/skills` shows mode `120000` for each.

### Issue tracker

Issues are tracked in GitHub Issues for `x7yue/sfly`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five triage labels, the roadmap labels `roadmap`, `merged-to-dev` and `needs-decision`, and `later` for deferred work (it replaces the status label). See `docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Branches, PRs and releases

Read it before creating a branch, opening or merging a PR, or closing an issue: roadmap issues go through `dev`, everything else through `main`; each branch's section says when a PR may be merged and by whom. See `docs/agents/branching-and-release.md`.
