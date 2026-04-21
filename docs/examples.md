# 4CO-OP Examples

## Example 1: First Project-Local Install

Command:

```bash
node scripts/install-4coop.mjs --project D:/work/my-app
```

What gets created:

- `.4co-op/install/4co-op/`
- `.4co-op/config.json`
- `.4co-op/project.config.json`
- `.claude/skills/4co-op/`

## Example 2: First Run In A Project

Command:

```bash
node scripts/4coop.mjs start --feature "add dark mode toggle"
```

Typical flow:

1. 4CO-OP checks required CLIs and GitHub access.
2. If project files are missing, it asks:

```text
[4CO-OP]: necessary files are not in the project folder, do you want me to scaffold?
```

3. If the project commands are not confirmed yet, it proposes build/test/lint commands and waits for a reply.
4. If no feature text was provided, it asks:

```text
[4CO-OP]: What's in your mind?
```

5. Planner runs, produces a summary, and 4CO-OP asks:

```text
[4CO-OP]: Is this plan good or do you want to edit/cancel?
```

6. After approval, the implementation and review stages continue.

## Example 3: Confirming Project Commands

The project command confirmation step accepts replies like these:

Accept all:

```text
ok
```

Skip tests:

```text
no tests
```

Edit commands:

```text
edit: build=pnpm build test=pnpm test lint=pnpm lint
```

Cancel:

```text
cancel
```

## Example 4: Plan Approval

After the planner stage, the normal approval replies are:

- `go`
- `yes`
- `approve`
- `continue`
- `ok`

Typical rejection replies:

- `no`
- `reject`
- `cancel`

## Example 5: Merge-Ready Handoff

After the pipeline finishes and a PR is ready, 4CO-OP adds this hint:

```text
[4CO-OP]: If you get new manual PR comments before merging, run "/4co-op check comment" and I will review them and continue.
```

That means the run is waiting for the user to review and merge unless new PR comments arrive first.

## Example 6: Manual PR Comment Check

Command:

```bash
node scripts/4coop.mjs check-comment
```

Possible outcomes:

- no new comments were found
- new comments were found but none were clearly actionable
- actionable comments were found, so 4CO-OP resumed fixer and gatekeeper work

## Example 7: Cleanup

Preview cleanup:

```bash
node scripts/4coop.mjs clean -- --dry-run
```

Delete old runs:

```bash
node scripts/4coop.mjs clean -- --older-than 30d
```

Keep only the newest 20 runs:

```bash
node scripts/4coop.mjs clean -- --keep-last 20
```
