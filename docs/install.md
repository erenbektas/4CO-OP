# 4CO-OP Install And Layout

## Source Of Truth

- Canonical skill source: `skill/4co-op/`
- Source-repo wrappers:
  - `node scripts/install-4coop.mjs --global`
  - `node scripts/install-4coop.mjs --project D:/work/my-app`
  - `node scripts/4coop.mjs <command>`

This GitHub repo is the source/distribution project. It should normally not keep a live local install in its own root.

See also:

- `docs/commands.md` for the command reference
- `docs/config.md` for config keys and examples
- `docs/runtime.md` for generated local files
- `docs/troubleshooting.md` for common failures
- `docs/privacy.md` for nightly logging behavior

## Project Layout

- Per-project runtime and local install data: `.4co-op/`
- Project-local installed bundle: `.4co-op/install/4co-op/`
- Project-local model/tag override config: `.4co-op/config.json`
- Project-local build/test/lint config: `.4co-op/project.config.json`
- Claude-compatible project shim: `.claude/skills/4co-op/`

The important boundary is:

- `skill/4co-op/` is committed source code.
- `.4co-op/` is local generated state and install output.
- `.claude/skills/4co-op/` is only a thin host shim, not the real source tree.
- `.claude/` is treated as a local host folder and is gitignored for project-local installs.

## Source Repo Hygiene

This repo should normally contain only source files under `skill/`, `scripts/`, and `docs/`.

If you ever see these in the repo root, they are generated local test/install artifacts and can be deleted before commit:

- `.4co-op/`
- `.claude/`

## Global Install

Install to both Codex and Claude global skill directories:

```bash
node scripts/install-4coop.mjs --global
```

Optional host filter:

```bash
node scripts/install-4coop.mjs --global --host codex
node scripts/install-4coop.mjs --global --host claude
```

Global targets:

- Codex: `~/.codex/skills/4co-op/`
- Claude: `~/.claude/skills/4co-op/`

These global and project-local paths work the same way on Windows, macOS, and Linux. `~` resolves to the current user's home directory on each platform.

## Project Install

Install a project-local bundle plus the Claude shim:

```bash
node scripts/install-4coop.mjs --project D:/work/my-app
```

Use a real target project path. Do not point `--project` at this source repo unless you intentionally want a temporary self-test install.

This creates:

- `.4co-op/install/4co-op/`
- `.4co-op/config.json` if missing
- `.4co-op/project.config.json` if missing
- `.claude/skills/4co-op/SKILL.md`
- `.claude/skills/4co-op/clean.md`

It also removes the old legacy 4CO-OP runtime folders from `.claude/` so Claude's own project data is no longer mixed with 4CO-OP runtime state, and it stops generating the older `.claude/settings.local.json` footprint.

## Editing Models

Edit `.4co-op/config.json` for project-specific model and tag changes.

Do not edit `.4co-op/install/4co-op/config.json` unless you intentionally want to modify only that generated install copy.

## Cross-Platform Notes

- The orchestrator and tracker are intended to run on Windows, macOS, and Linux.
- `monitor_window.browser` defaults to `auto`.
- With `auto`, 4CO-OP tries to open the tracker in an app-style browser window when it finds a supported browser on the current OS, then falls back to the system default URL opener if needed.
- You can override `monitor_window.browser` with a platform-specific browser name such as `edge`, `chrome`, `brave`, or an explicit executable path.

## Runtime Data

These paths are generated and should stay local:

- `.4co-op/runs/`
- `.4co-op/logs/`
- `.4co-op/worktrees/`
- `.4co-op/4coop-active.json`
- `.4co-op/pipeline.lock`
- `.4co-op/pipeline-queue.json`
- `.4co-op/monitor.port`

They are ignored by `.gitignore`.
