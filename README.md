# 4CO-OP

4CO-OP is a multi-stage coding skill that splits work between Codex and Claude-style model stages. Type `/4co-op "<what you want>"` inside Claude Code and it plans, builds, reviews, and opens a PR for you.

## Getting Started (3 steps)

### 1. Install the prerequisites

You need these four CLIs on your PATH:

| Tool | Install |
|---|---|
| `git` | macOS: `brew install git` · Ubuntu: `sudo apt install git` · https://git-scm.com/downloads |
| `gh` (GitHub CLI) | `brew install gh`, then `gh auth login` · https://cli.github.com |
| `claude` (Claude Code) | `npm install -g @anthropic-ai/claude-code` · https://docs.claude.com/en/docs/claude-code |
| `codex` | `npm install -g @openai/codex` or `brew install codex` · https://github.com/openai/codex |

### 2. Install 4CO-OP

Clone this repo, then run:

```bash
node scripts/install-4coop.mjs
```

That's it — with no flags it installs globally for both Claude and Codex and prints a checklist of which prerequisites it found.

Other options if you want them:

```bash
node scripts/install-4coop.mjs --host claude           # only Claude Code
node scripts/install-4coop.mjs --host codex            # only Codex
node scripts/install-4coop.mjs --project ~/my-app      # project-local install
node scripts/install-4coop.mjs --dry-run               # preview without writing
```

### 3. Use it

Open any GitHub-connected project in Claude Code and type:

```
/4co-op add dark mode toggle
```

First run in a project: 4CO-OP will ask to scaffold (say `yes`), then confirm build/test/lint commands. You can reply `ok` to accept the detected values, `skip` to use none at all, or `edit: build=... test=... lint=...` to set them.

After that, just `/4co-op <what you want>` any time.

## Topology

For details, please check: [Architecture](./docs/architecture.md)

```
User (Claude Code (by default))
      │
      ▼
 /coop "add dark mode toggle"        ◄── user types this
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Orchestrator   (Source: skill/4co-op/SKILL.md)            │
│  Reads/writes  .4co-op/runs/<run_id>/state.json            │
└─────┬───────────────────────────────────────────────────────┘
      │
      ▼
  ① Planner         claude-opus-4-7[1m], permissionMode:plan
        └── writes plan.md + acceptance_checklist[]
      │
      ▼
  ② Builder         codex exec -m gpt-5.4   ◄── external CLI
        │           sandbox workspace-write, --cd <worktree>
        │           stdin: plan.md
        └── commits to feat/<slug> branch in git worktree
      │
      ▼
  ③ Spec Checker    claude-sonnet-4-6 (strict prompt, read-only)
        │           evaluates each checklist item PASS/FAIL/UNCLEAR
        └── writes spec_check_result.json
      │
      ├─► any UNCLEAR?  ─► ④ Escalation  claude-opus-4-7
      │                         resolves to PASS/FAIL (no UNCLEAR allowed)
      │
      ▼   all PASS: gh pr create
  ⑤ PR Reviewer     claude-opus-4-7
        └── posts review comment on the PR (≤10 issues, 🔴🟡🔵)
      │
      ▼   issues found?
  ⑥ Fixer           codex exec resume <builder_session_id>
        │           -m gpt-5.4
        └── commits per-issue fixes to the same branch
      │
      ▼
  ⑦ Gatekeeper      codex exec -m gpt-5.4
        └── verdict: APPROVE | REJECT + severity
      │
      ├─► REJECT (CRITICAL)   → back to ⑥
      ├─► REJECT (IMPORTANT)  → one more iteration allowed, else notify user
      └─► APPROVE             → Narrator: "ready to merge" + PR link
```

## Uninstall

There is no dedicated uninstall command yet.

### Remove The Global Install

Delete these folders if they exist:

- `~/.codex/skills/4co-op/`
- `~/.claude/skills/4co-op/`

Remove only the host you no longer want if you installed for a single host.

### Remove The Project-Local Install

In the target project, delete:

- `.4co-op/`
- `.claude/skills/4co-op/`

## Day-to-day Usage

Inside Claude Code, in any GitHub-connected project:

```
/4co-op add dark mode toggle                 # start a new feature
/4co-op check comment                        # re-review after you left manual PR comments
/4co-op clean -- --older-than 30d            # sweep old run data
/4co-op set-base develop                     # pin a preferred base branch for future runs
```

CLI equivalents (if you want to run without the slash command):

```bash
node scripts/4coop.mjs start --feature "add dark mode toggle"
node scripts/4coop.mjs start --feature "..." --base develop   # one-off base override
node scripts/4coop.mjs check-comment
node scripts/4coop.mjs clean -- --dry-run
node scripts/4coop.mjs set-base develop
```

## Monitor Cockpit

Every run writes live events (model turns, file reads, edits, bash calls) under
`.4co-op/events/` and streams them to a local monitor UI. Open the cockpit URL
printed at the start of the run to watch stages progress in real time, inspect
per-stage token usage, browse git status and diffs, and replay any tool call.
The default browser is the OS default — set `monitor.browser` in config if you
want a specific one.

## Docs

- [Architecture](./docs/architecture.md)
- [Install and layout](./docs/install.md)
- [Commands](./docs/commands.md)
- [Config](./docs/config.md)
- [Runtime files](./docs/runtime.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Privacy and logging](./docs/privacy.md)
- [Examples](./docs/examples.md)

## License

Licensed under the [MIT License](./LICENSE). Free to use, modify, and
distribute; please keep the copyright notice intact to credit the original
project.
