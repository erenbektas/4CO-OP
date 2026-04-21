---
name: 4co-op-clean
description: Sweep merged worktrees, old 4CO-OP runs, and other runtime artifacts.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash
---

# 4CO-OP Clean

Resolve the orchestrator path the same way as `SKILL.md`, then run:

```bash
node "$SCRIPT" clean -- "$ARGUMENTS"
```

Supported flags:

- `--dry-run`
- `--all`
- `--older-than 30d`
- `--keep-last 20`
- `--force`

Print the orchestrator's tagged output verbatim.
