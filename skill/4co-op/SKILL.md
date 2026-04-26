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

All user-visible lines already come pre-tagged by the orchestrator. Print them verbatim, then route based on the returned `status`. Use `AskUserQuestion` (not plain-text "yes/no" polling) so the user gets structured, clickable options in chat — matching the cockpit window.

The cockpit window is the primary surface once a pipeline starts. Whenever the orchestrator is doing real work (Planner, Builder, Spec Check, Reviewer, Fixer, Gatekeeper), tell the user the window is the live view and don't wait in chat.

### `status=awaiting_scaffold`
Call `AskUserQuestion` with:
- question: `"This project isn't scaffolded for 4CO-OP. Scaffold it now?"`
- header: `"Scaffold"`
- options: `[{label: "Scaffold project", description: "Creates .4co-op/ and continues the run"}, {label: "Cancel", description: "Leave the project untouched"}]`

On "Scaffold project" run `node "$SCRIPT" continue-active`. On "Cancel" run `node "$SCRIPT" reject-active`.

### `status=awaiting_config_confirm`
Call `AskUserQuestion` with:
- question: `"The setup assistant proposed build/test/lint commands. How do you want to proceed?"`
- header: `"Commands"`
- options: `[{label: "Accept proposed"}, {label: "Skip all"}, {label: "No tests"}, {label: "Cancel"}]`

Map the selection → `node "$SCRIPT" config-confirm --answer "<ok|skip|no tests|cancel>"`. If the user chooses "Other" and types an edit string, pass it verbatim.

### `status=awaiting_prompt`
Take the next free-text reply and run `node "$SCRIPT" provide-feature --feature "<reply>"`. No `AskUserQuestion` — this is free-text.

### `status=awaiting_approval`
Call `AskUserQuestion` with:
- question: `"The planner finished. How do you want to proceed?"`
- header: `"Plan ready"`
- options:
  - `{label: "Approve plan", description: "Run Builder → Spec → Review → Gatekeeper (watch the cockpit window)"}`
  - `{label: "Reject", description: "Cancel the run and release the lock"}`
  - `{label: "Let me review", description: "Exit — I'll re-run /4co-op continue after editing the plan"}`

- **Approve plan**: dispatch detached so chat doesn't block on the long pipeline:
  ```bash
  nohup node "$SCRIPT" continue-active >/tmp/4coop-continue.log 2>&1 </dev/null & disown
  ```
  Then print `[4CO-OP]: pipeline is running — watch the cockpit window for progress.` and exit the turn.
- **Reject**: run `node "$SCRIPT" reject-active` foreground and print the result.
- **Let me review**: print `[4CO-OP]: Plan is at <plan_path> — edit it if you want, then run /4co-op continue to approve.` and exit.

### `status=queued`
Just print messages. The user's run is queued behind another and will start when the lock releases.

### `status=halted` / `status=rejected` / `status=approved` / `status=handed_off`
Print messages verbatim. No follow-up action unless the user invokes a new command.

### `check comment`
When the user says "check comment" or the skill is invoked with that argument, run `node "$SCRIPT" check-comment` and print the result. This may transition into an active run; treat the resulting status like the rules above.

## Output rules

- Never show raw JSON unless the user explicitly asks.
- Never strip the tags added by the orchestrator.
- Messages about agent work stay stage-tagged.
- Cross-cutting or hardcoded system messages use the `[4CO-OP]:` tag.
- After dispatching a long-running command (`continue-active` post-approval), do not poll or `sleep`. The cockpit window is now the driver; exit and let the user come back to chat when they want to act again.
