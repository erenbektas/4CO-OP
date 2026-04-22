# 4CO-OP Commands

This file is the command reference for the 4CO-OP source repo.

Use it for three different cases:

- installing the skill globally or into a project
- running the pipeline from the source repo wrapper
- understanding the internal continuation commands the skill uses between user replies

## Normal User Commands

These are the commands a normal user is expected to run directly.

### Install Globally

Install into the global Codex and Claude skill folders:

```bash
node scripts/install-4coop.mjs --global
```

Install only for one host:

```bash
node scripts/install-4coop.mjs --global --host codex
node scripts/install-4coop.mjs --global --host claude
```

Preview only:

```bash
node scripts/install-4coop.mjs --global --dry-run
```

### Install Per Project

Install 4CO-OP into a target project:

```bash
node scripts/install-4coop.mjs --project D:/work/my-app
```

Preview only:

```bash
node scripts/install-4coop.mjs --project D:/work/my-app --dry-run
```

Install both globally and into a project in one call:

```bash
node scripts/install-4coop.mjs --global --project D:/work/my-app
```

### Start A Run

Run the pipeline from this source repo:

```bash
node scripts/4coop.mjs start --feature "add dark mode toggle"
```

What it does:

- checks scaffold/runtime prerequisites
- checks the repo has a GitHub remote
- opens the nightly tracker window if enabled
- runs the planner and then the rest of the pipeline

### Check Manual PR Comments

Use this after 4CO-OP has already opened a PR and the user added comments manually:

```bash
node scripts/4coop.mjs check-comment
```

Accepted aliases:

- `check-comments`
- `check comment`
- `check comments`

What it does:

- finds the latest PR-backed run
- reads new human PR comments and review comments
- resumes fixer and gatekeeper work if the comments are actionable

### Clean Old Runtime Data

```bash
node scripts/4coop.mjs clean -- --dry-run
node scripts/4coop.mjs clean -- --all
node scripts/4coop.mjs clean -- --older-than 30d
node scripts/4coop.mjs clean -- --keep-last 20
node scripts/4coop.mjs clean -- --force
```

Supported clean flags:

- `--dry-run`: show what would be cleaned without deleting anything
- `--all`: delete all saved run folders
- `--older-than <Nd>`: delete run folders older than a day count such as `30d`
- `--keep-last <N>`: keep the newest `N` run folders, delete older ones
- `--force`: force worktree removal when sweeping merged or closed PR worktrees

## Skill-Level User Actions

When 4CO-OP is installed into Codex or Claude, the normal user flow is not to type the internal subcommands manually.

The installed skill handles these interaction patterns:

- start a feature request
- answer the scaffold question with `yes` or `no`
- confirm proposed build/test/lint commands with `ok`, `no tests`, `edit: build=... test=... lint=...`, or `cancel`
- approve a plan with `go`, `yes`, `approve`, `continue`, or `ok`
- reject/cancel when needed
- use `check comment` after merge-ready handoff to inspect new manual PR feedback

## Internal Continuation Commands

> These commands are invoked by `SKILL.md` during slash-command handling. You should not type them manually. They are documented here only so `SKILL.md` authors and contributors can read the contract between the skill and the orchestrator.

### `continue-active`

Continue the current active session.

Used when:

- scaffold was approved
- a plan was approved and the run should continue

### `reject-active`

Reject or cancel the current active session.

Used when:

- scaffold was declined
- the plan/run was rejected

### `provide-feature --feature "..."`

Provide the feature text after 4CO-OP asked `What's in your mind?`

### `config-confirm --answer "..."`

Confirm or edit the proposed project commands.

Examples:

```bash
node scripts/4coop.mjs config-confirm --answer "ok"
node scripts/4coop.mjs config-confirm --answer "no tests"
node scripts/4coop.mjs config-confirm --answer "edit: build=npm run build test=npm test lint=npm run lint"
```

## Status Flow

The orchestrator returns a `status` in its JSON output. These are the main ones:

- `awaiting_scaffold`: project files are missing and scaffold approval is needed
- `awaiting_config_confirm`: proposed build/test/lint commands need confirmation
- `awaiting_prompt`: the user has not provided the feature yet
- `awaiting_approval`: the plan is ready and waiting for user approval
- `merge_ready`: the PR is ready for the user to review and merge
- `cleaned`: cleanup finished
- `halted`: the run stopped because of an error, invalid step, or missing prerequisite
