# 4CO-OP Troubleshooting

## `gh` Is Missing Or Not Working

Symptoms:

- startup halts before the pipeline begins
- GitHub checks fail
- PR creation or comment checking does not work

What to check:

- `gh --version`
- `gh auth status`

What to do:

- install GitHub CLI
- sign in with `gh auth login`
- make sure `gh repo view` works in the target repo

## `codex` Or `claude` Is Missing

Symptoms:

- 4CO-OP stops early with a missing dependency message

What to check:

- `codex --version`
- `claude --version`

What to do:

- install the missing CLI
- make sure it is available on your shell `PATH`
- on Windows, reopen the terminal after installation if needed

## The Project Is Not Connected To GitHub

Expected message:

```text
[4CO-OP]: This project is not connected to a GitHub repository yet. Connect the repo and make sure gh can view it, then try again.
```

What to check:

- `git remote -v`
- `git remote get-url origin`
- `gh repo view`

What to do:

- add an `origin` remote
- make sure it points to a real GitHub repository
- make sure `gh` can access that repository

## The Project Keeps Asking To Scaffold

Symptoms:

- you keep getting the scaffold question on startup

What to check:

- `.4co-op/install/4co-op/`
- `.claude/skills/4co-op/SKILL.md`
- `.4co-op/config.json`
- `.4co-op/project.config.json`

What to do:

- reinstall the project-local bundle with `node scripts/install-4coop.mjs --project <path>`
- check that the local install files were actually created

## The Project Keeps Asking For Build/Test/Lint Confirmation

Symptoms:

- every run returns to command confirmation

What to check:

- `.4co-op/project.config.json`

What to do:

- confirm the commands with `ok`
- or set them explicitly with `edit: build=... test=... lint=...`
- make sure `.4co-op/project.config.json` exists and has `"confirmed": true`

## The Tracker Window Does Not Open

What to check:

- `monitor_window.enabled` in `.4co-op/config.json`
- `monitor_window.auto_launch` in `.4co-op/config.json`
- `monitor_window.browser` in `.4co-op/config.json`

What to try:

- keep `browser` as `system` to use the OS default browser
- try `browser: "auto"` (or a specific name like `chrome`/`edge`/`brave`) if you prefer an app-style tracker window
- check whether a browser opener exists on the machine

Cross-platform launcher behavior:

- Windows: app-capable browser or system URL opener
- macOS: `open`
- Linux: app-capable browser command or `xdg-open`

## The Tracker Window Opens But Looks Empty

What to check:

- whether the run actually started
- whether logging and monitor are enabled
- whether the stage is still idle

What to do:

- start a real feature run, not only the install step
- click a stage row that already has a completed or running call

## `check-comment` Does Nothing Useful

Possible reasons:

- there is no previous PR-backed run
- there are no new PR comments since the last check
- new comments exist but none are clearly actionable

What to do:

- make sure the previous run actually created a PR
- add the PR comments first, then run `check-comment`
- if the comments are vague, make them concrete enough to turn into fix tasks

## A Run Seems Stuck

What to check:

- `.4co-op/4coop-active.json`
- `.4co-op/pipeline.lock`
- `.4co-op/pipeline-queue.json`

What to do:

- if there is a pending approval/config/scaffold step, answer it instead of starting a fresh run
- if a stale lock remains after a crash, rerun the command and let 4CO-OP clear the stale lock
- if needed, remove only the stale active/lock file after confirming no run is still active

## Cleanup Is Refused

Expected cause:

- a run is still active and the lock is fresh

What to do:

- wait for the run to finish
- or stop dealing with the active run first
- then rerun:

```bash
node scripts/4coop.mjs clean -- --dry-run
```

## Config File Validation Fails

Symptoms:

- startup throws a config validation error

Common causes:

- missing stage keys
- invalid `cli` value
- empty `model` or `tag_display`
- invalid `monitor_window.port`
- invalid logging intervals

What to do:

- compare your file against `docs/config.md`
- remove the broken override and let 4CO-OP fall back to defaults if needed
