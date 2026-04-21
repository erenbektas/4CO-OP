# 4CO-OP

4CO-OP is a source repo for a multi-stage coding skill that splits work between Codex and Claude-style model stages.

This README stays intentionally short. Use the docs folder for the full details:

- [Architecture](./docs/architecture.md)
- [Install and layout](./docs/install.md)
- [Commands](./docs/commands.md)
- [Config](./docs/config.md)
- [Runtime files](./docs/runtime.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Privacy and logging](./docs/privacy.md)
- [Examples](./docs/examples.md)

## Install

### Global Install

Install to the global Codex and Claude skill folders:

```bash
node scripts/install-4coop.mjs --global
```

Install only one host:

```bash
node scripts/install-4coop.mjs --global --host codex
node scripts/install-4coop.mjs --global --host claude
```

### Project-Local Install

Install into a target project:

```bash
node scripts/install-4coop.mjs --project D:/work/my-app
```

You can also install globally and locally in one call:

```bash
node scripts/install-4coop.mjs --global --project D:/work/my-app
```

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
  ② Builder         codex exec -m gpt-5.3-codex   ◄── external CLI
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
        │           -m gpt-5.3-codex
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

## Basic Usage

Run a feature request from the source wrapper:

```bash
node scripts/4coop.mjs start --feature "add dark mode toggle"
```

If the PR already exists and you added manual review comments before merging:

```bash
node scripts/4coop.mjs check-comment
```

For cleanup:

```bash
node scripts/4coop.mjs clean -- --dry-run
```
