# 4CO-OP Runtime Files

This file explains what 4CO-OP writes into a project and what is safe to delete.

## Project-Local Runtime Root

Most local runtime data lives under:

```text
.4co-op/
```

Common contents:

- `.4co-op/install/4co-op/`
- `.4co-op/config.json`
- `.4co-op/runs/`
- `.4co-op/logs/`
- `.4co-op/worktrees/`
- `.4co-op/4coop-active.json`
- `.4co-op/4coop-pending-config.json`
- `.4co-op/pipeline.lock`
- `.4co-op/pipeline-queue.json`
- `.4co-op/monitor.port`

## What Each Path Does

### `.4co-op/install/4co-op/`

The copied project-local install bundle.

Safe to delete:

- yes, but only if you want to remove the project-local install

What happens if deleted:

- the project-local install stops working until you reinstall

### `.4co-op/config.json`

Project-local config override for models, tags, monitor, and logging.

Safe to delete:

- yes

What happens if deleted:

- 4CO-OP falls back to the bundled defaults on the next run

### `.4co-op/runs/`

Saved run folders. Each run gets its own directory.

Typical contents inside a run folder:

- `state.json`
- `plan.md`
- `review.md`
- `reviewer-input.md`
- `relay/`
- `raw/`

Safe to delete:

- yes

What happens if deleted:

- previous run history and saved artifacts are gone
- `check-comment` may no longer be able to continue from that deleted run

### `.4co-op/logs/`

Nightly performance logs.

Safe to delete:

- yes

What happens if deleted:

- previous nightly log history is gone

### `.4co-op/worktrees/`

Scaffolded placeholder directory. Managed git worktrees are currently created
as project siblings at `../<repo-name>-wt-<slug>` (see `buildWorktreeInfo` in
`skill/4co-op/scripts/4coop-worktree.mjs`), not inside this directory. The real
path used for a given run is stored in `state.worktree.path` inside that run's
`state.json`, and the `clean` command sweeps based on that value.

Safe to delete:

- yes; scaffold recreates it on the next install/run

### `.4co-op/4coop-active.json`

The current active session state.

Safe to delete:

- yes, if you want to drop the current pending interaction

What happens if deleted:

- pending scaffold/config/approval state is lost

### `.4co-op/4coop-pending-config.json`

Temporary helper state used during config confirmation.

Safe to delete:

- yes

### `.4co-op/pipeline.lock`

Lock file preventing overlapping runs.

Safe to delete:

- only when no run is actually active

What happens if deleted:

- if a real active run exists, you can allow conflicting runs by mistake

### `.4co-op/pipeline-queue.json`

Queued feature requests waiting behind the active run.

Safe to delete:

- yes

What happens if deleted:

- queued requests are lost

### `.4co-op/monitor.port`

The current monitor server port file.

Safe to delete:

- yes

What happens if deleted:

- the current tracker window can lose its saved port reference

## Project Files Outside `.4co-op`

### `.claude/skills/4co-op/`

This is the thin Claude-compatible project shim created by the project install.

Safe to delete:

- yes, if you want to remove the Claude project shim

## Safe Cleanup Shortcuts

### Remove Old History But Keep The Install

Delete:

- `.4co-op/runs/`
- `.4co-op/logs/`
- stale `../<repo-name>-wt-<slug>` sibling directories (the actual worktrees) if the matching run's PR is already merged or closed; prefer `clean` for this

Or use:

```bash
node scripts/4coop.mjs clean -- --dry-run
node scripts/4coop.mjs clean -- --older-than 30d
```

### Remove The Project-Local Install

Delete:

- `.4co-op/`
- `.claude/skills/4co-op/`

## Git Hygiene

Project-local installs add ignore rules for:

- `.4co-op/`
- `.claude/`

These are local install/runtime artifacts and should not be committed from a normal target project.
