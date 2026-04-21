---
name: 4co-op
description: Run the 4CO-OP multi-stage coding pipeline for a feature request, including the nightly monitor window and performance logging.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Agent
---

# 4CO-OP

Use this skill to orchestrate the 4CO-OP pipeline from the current project.

## Entry point

Probe for the project-local install first, then the source tree, then the global install:

```bash
if [ -f ".4co-op/install/4co-op/scripts/4coop-orchestrator.mjs" ]; then
  SCRIPT=".4co-op/install/4co-op/scripts/4coop-orchestrator.mjs"
elif [ -f "skill/4co-op/scripts/4coop-orchestrator.mjs" ]; then
  SCRIPT="skill/4co-op/scripts/4coop-orchestrator.mjs"
elif [ -f "$HOME/.codex/skills/4co-op/scripts/4coop-orchestrator.mjs" ]; then
  SCRIPT="$HOME/.codex/skills/4co-op/scripts/4coop-orchestrator.mjs"
elif [ -f "$HOME/.claude/skills/4co-op/scripts/4coop-orchestrator.mjs" ]; then
  SCRIPT="$HOME/.claude/skills/4co-op/scripts/4coop-orchestrator.mjs"
else
  echo "[4CO-OP]: orchestrator script not found in project-local install, source tree, or global install"
  exit 1
fi
```

Invoke the orchestrator with:

```bash
node "$SCRIPT" start --feature "$ARGUMENTS"
```

If the user invoked `clean`, route to:

```bash
node "$SCRIPT" clean -- "$ARGUMENTS"
```

If the user invoked `check comment`, route to:

```bash
node "$SCRIPT" check-comment
```

## Reply routing

All user-visible lines already come pre-tagged by the orchestrator. Print them verbatim.

- `status=awaiting_scaffold`: wait for `yes` or `no`, then call `continue-active` or `reject-active`.
- `status=awaiting_config_confirm`: wait for `ok`, `no tests`, `edit: ...`, or `cancel`, then call `config-confirm --answer "<reply>"`.
- `status=awaiting_prompt`: take the next free-text reply and call `provide-feature --feature "<reply>"`.
- `status=awaiting_approval`: `go` / `yes` / `approve` / `continue` / `ok` call `continue-active`; `no` / `reject` / `cancel` call `reject-active`.
- After a run reaches merge-ready handoff, `check comment` should inspect new manual PR comments and continue the workflow if they are actionable.

## Output rules

- Never show raw JSON unless the user explicitly asks.
- Never strip the tags added by the orchestrator.
- Messages about agent work stay stage-tagged.
- Cross-cutting or hardcoded system messages use the `[4CO-OP]:` tag.
