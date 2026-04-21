# 4CO-OP Architecture

## 1. Goal

Automate the coding workflow inside Claude Code. The user types a natural-language feature description and gets back a merge-ready PR, with specialized models doing each step of the work. User sees a clean chat thread with brief status updates; no terminal, no IDE, no context-switching.

## 2. Topology

```
User (Claude Desktop ▸ Code tab)
      │
      ▼
 /4co-op "add dark mode toggle"      ◄── user types this
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

Between stages, a **Narrator** subagent (`claude-haiku-4-5`) emits a one-to-two-sentence status line to the user. That message, plus any PR link, is what the user sees in chat.

## 3. Shared state — `.4co-op/runs/<run_id>/state.json`

Per-run file that every stage reads + updates for the active run. Schema:

```jsonc
{
  "run_id": "coop-2026-04-19-1430-auth",
  "feature_request": "add dark mode toggle",
  "created_at": "2026-04-19T14:30:00Z",

  "plan": {
    "path": ".4co-op/runs/<run_id>/plan.md",
    "acceptance_checklist": [
      { "id": "AC-001", "text": "Toggle persists across reloads", "status": "pending" },
      { "id": "AC-002", "text": "Keyboard shortcut ⌘+Shift+D flips the theme", "status": "pending" }
    ],
    "file_structure_hint": ["src/theme/ThemeProvider.tsx", "src/theme/useTheme.ts"],
    "definition_of_done": "..."
  },

  "worktree": {
    "path": "../<repo-name>-wt-<slug>",
    "branch": "feat/<slug>",
    "base": "main"
  },

  "builder": {
    "codex_session_id": "…",      // from thread.started event
    "commit_sha": "…",
    "files_changed": ["…"],
    "tests_added": ["…"],
    "build": "passed",
    "tests": "passed",
    "lint": "passed"
  },

  "spec_check": {
    "results": [ { "id": "AC-001", "status": "PASS", "evidence": "src/theme/useTheme.ts:42" } ],
    "escalated_ids": ["AC-003"]
  },

  "pr": { "number": 14, "url": "https://github.com/owner/repo/pull/14" },

  "reviewer": { "issues": [ { "severity": "important", "file": "…", "line": 87, "text": "…" } ] },

  "fixer": { "iterations": 1, "commits": ["sha1", "sha2"] },

  "gatekeeper": { "iteration": 1, "verdict": "APPROVE", "severity": "MINOR", "issues": [] },

  "narrator_log": []
}
```

`<repo-name>` is `path.basename(projectRoot)` and `<slug>` is `slugify(feature)` (the slugified feature title); both resolved in `buildWorktreeInfo` in `skill/4co-op/scripts/4coop-worktree.mjs`.

`narrator_log` is a per-run array reserved for a future chat-transcript feature. The helper `appendNarratorEntry` in `skill/4co-op/scripts/4coop-state.mjs` exists but is not currently called by the orchestrator, so the array stays empty on every run. The live event stream (`run_start`, `run_end`, `stage_call`, `window_opened`, `window_closed`, `interruption`, `table_snapshot`, `comment_check_start`, `comment_check_end`) is written to the nightly log file, not to `state.json`; see `docs/privacy.md` and `skill/4co-op/scripts/4coop-logger.mjs`.

Why a file, not in-memory: subagents run in isolated contexts. The file is the contract between them.

## 4. Stage specs

Every stage is a subagent file in `.4co-op/install/4co-op/agents/`. Each reads the state file, does its job, writes results back, and returns a short summary to the orchestrator.

### ① Planner — `.4co-op/install/4co-op/agents/4coop-planner.md`
- **Model:** `claude-opus-4-7` with `[1m]` context
- **Permission:** `plan` (enforced read-only)
- **Input:** user's feature description + codebase (via Explore tools)
- **Output:** writes `plan.md` with: problem statement, proposed file structure, edge cases, definition-of-done, and an **atomic acceptance checklist** (one testable claim per line). Appends to `state.plan`.
- **Does NOT:** edit code, create branches, call Codex.
- **Handoff to user:** orchestrator shows the plan; user confirms "go" before stage ②.

### ② Builder — external, called via `codex exec`
- **Model:** `gpt-5.3-codex`, sandbox `workspace-write`
- **Pre-step (orchestrator):** `git worktree add ../<repo-name>-wt-<slug> -b feat/<slug>` then write worktree details into state.
- **Invocation:**
  ```
  codex exec \
    --cd ../<repo-name>-wt-<slug> \
    --model gpt-5.3-codex \
    --sandbox workspace-write \
    --output-schema .4co-op/install/4co-op/schemas/builder-result.json \
    --color never \
    --json \
    - < plan.md
  ```
- **Output schema** forces Codex to emit `{session_id, files_changed, tests_added, build, tests, lint, commit_sha, commit_message, notes}`. Orchestrator parses and writes to `state.builder`.
- **Session ID** captured from the `thread.started` NDJSON event on stdout.
- **Commit policy (in prompt):** TDD preferred, run project's build/test/lint, commit only when all green.

### ③ Spec Checker — `.4co-op/install/4co-op/agents/4coop-spec-checker.md`
- **Model:** `claude-sonnet-4-6`
- **Permission:** read-only (no Edit/Write/Bash-write)
- **Strict prompt:** for each `AC-NNN` in the checklist, return `{id, status ∈ {PASS,FAIL,UNCLEAR}, evidence_file, evidence_line, quote}`. Forbidden to suggest improvements, find extra bugs, or infer missing requirements. **UNCLEAR is preferred over guessing.**
- **Output:** writes `state.spec_check.results`. Fails fast if any item is FAIL.

### ④ Escalation — `.4co-op/install/4co-op/agents/4coop-escalation.md` (conditional)
- **Model:** `claude-opus-4-7`
- Only invoked if `state.spec_check.results` contains any UNCLEAR.
- Resolves each UNCLEAR to `PASS` or `FAIL` with deeper reasoning. UNCLEAR is rejected as an output.
- Merges back into `state.spec_check.results` before PR creation.

### ⑤ PR Reviewer — `.4co-op/install/4co-op/agents/4coop-pr-reviewer.md`
- **Model:** `claude-opus-4-7`
- Reads the PR diff (via `gh pr diff`) and the plan.
- Returns ≤10 issues categorized 🔴 Critical / 🟡 Important / 🔵 Minor, each with file:line + fix direction (not a patch).
- Orchestrator posts as a PR comment: `gh pr comment <n> --body-file review.md`.
- **Does NOT fix anything.**

### ⑥ Fixer — external, `codex exec resume`
- **Model:** `gpt-5.3-codex`
- **Key trick:** resume the Builder's session so Codex has full context: `codex exec resume <builder_session_id> --model gpt-5.3-codex -s workspace-write --output-schema .4co-op/install/4co-op/schemas/fixer-result.json -`.
- Scope-locked: prompt restricts edits to files referenced by the reviewer. Anything unrelated is logged to an "Observed (Out of Scope)" section, not fixed.
- Runs build/test/lint, commits per-issue when practical.

### ⑦ Gatekeeper — external, `codex exec`
- **Model:** `gpt-5.4` (different family — bias mitigation)
- Inputs: PR diff + reviewer comments + plan.
- Output schema (enforced):
  ```jsonc
  {
    "verdict": "APPROVE" | "REJECT",
    "severity": "CRITICAL" | "IMPORTANT" | "MINOR" | "NONE",
    "issues": [ "one-line issue text, max 5" ]
  }
  ```
- **Loop control:**
  - `CRITICAL` → re-run Fixer (⑥) with Gatekeeper's issues as input.
  - `IMPORTANT` → one more iteration allowed (tracked in `state.fixer.iterations`, cap = 2).
  - `MINOR` / `NONE` → APPROVE; Narrator tells user it's ready to merge.
- **Never** merges itself. Merging is always the user's click.

## 5. User-facing messaging & speaker attribution

Seven actors share one chat thread. The user has to know who's talking, at a glance. **Every message the user sees is tagged:**

```
[<emoji> <Role> | <Model>]: <content>
```

### Tag table

| Stage | Tag |
|---|---|
| Planner | `[🧠 Planner \| Opus 4.7 1M]` |
| Builder | `[🛠️ Builder \| 5.3-Codex]` |
| Spec Checker | `[✅ Spec Checker \| Sonnet 4.6]` |
| Escalation | `[🔎 Escalation \| Opus 4.7]` |
| PR Reviewer | `[👓 Reviewer \| Opus 4.7]` |
| Fixer | `[🔧 Fixer \| 5.3-Codex]` |
| Gatekeeper | `[⚖️ Gatekeeper \| 5.4]` |

### Who produces each message

- **Direct voice** (the stage's own model writes the message): Planner presenting the plan, Reviewer posting findings, Gatekeeper emitting the verdict, Escalation reporting UNCLEAR resolutions.
- **Haiku ghostwritten, stage-tagged** (the message is phrased by Haiku for token efficiency, but the tag credits the stage being reported on): Builder and Fixer progress pings, Spec Checker summaries when the underlying model's response is too long to show raw.
- **Orchestration-meta** (truly cross-cutting): "run started," "opening PR," "run halted — reason." These carry `[📣 Coop | Haiku 4.5]`.

The mental model: the tag identifies **whose work the message is about**, not which model typed the characters. That's what the user cares about.

### Narrator subagent

`.4co-op/install/4co-op/agents/4coop-narrator.md` using `claude-haiku-4-5`. Called whenever a ghostwritten or meta message is needed.

- **Input:** `{ speaker, stage_payload, state }`
  - `speaker` ∈ `planner | builder | spec-checker | escalation | reviewer | fixer | gatekeeper | coop-meta`
  - `stage_payload` = short raw data (commit sha, counts, PR url, verdict, etc.)
- **Prompt enforces:** first line is exactly the speaker tag from the table, then ≤2 sentences of plain English, no markdown headers, PR URL included when relevant.
- **Orchestrator prints the output verbatim to chat.** No post-processing.
- **Token cost:** 6–10 Haiku calls per run. Negligible.

### Example chat flow

```
user: /4co-op add dark mode toggle
[🧠 Planner | Opus 4.7 1M]: Plan ready — 6 acceptance criteria, touches 3 files. Approve to proceed?
user: go
[🛠️ Builder | 5.3-Codex]: Building on feat/dark-mode. I'll ping when the commit lands.
[🛠️ Builder | 5.3-Codex]: Commit 3a1f9c — 4 files changed, tests + lint green.
[✅ Spec Checker | Sonnet 4.6]: 5 of 6 criteria PASS, 1 UNCLEAR (AC-004) — escalating.
[🔎 Escalation | Opus 4.7]: AC-004 resolved to PASS.
[👓 Reviewer | Opus 4.7]: 2 issues on PR #14 (1 🟡, 1 🔵). https://github.com/username/repo/pull/14
[🔧 Fixer | 5.3-Codex]: Fixes applied in 2 commits — rerunning the gate.
[⚖️ Gatekeeper | 5.4]: APPROVE — severity MINOR. Ready to merge: https://github.com/username/repo/pull/14
```

All the messages above are created by Haiku (coop-narrator) using the info from the related agent's output. Tags before the message is to make it clear the stage and the responsible agent.

### Rules the orchestrator enforces

1. **No untagged messages.** If the orchestrator ever reaches a point where it'd print raw model output without a tag, it routes through the Narrator first. This is a hard invariant.
2. **Model in the tag must match the stage's actual model.** If a stage's model is swapped later (e.g., Sonnet → Opus for Spec Checker), the tag table in this doc is the source of truth and `4coop-narrator.md`'s prompt is regenerated from it.
3. **Tag format is byte-exact.** A downstream UI or log parser can split on `[` and `|` without surprise.

## 6. File layout

The skill lives in three places: the committed source tree, the per-project runtime
(and install bundle) under `.4co-op/`, and the thin host shim under `.claude/skills/`.
See `docs/install.md` and `docs/runtime.md` for the long-form version; this section
names the paths the rest of the doc references.

### Committed source — `skill/4co-op/`

```
skill/4co-op/
├── SKILL.md                   # /4co-op entry point + reply routing
├── clean.md                   # /4co-op clean subcommand (see §11)
├── config.json                # bundled default config (models, tags, monitor, logging)
├── config.schema.json
├── agents/
│   ├── 4coop-planner.md
│   ├── 4coop-spec-checker.md
│   ├── 4coop-escalation.md
│   ├── 4coop-pr-reviewer.md
│   └── 4coop-narrator.md
├── schemas/
│   ├── planner-result.json
│   ├── spec-check-result.json
│   ├── escalation-result.json
│   ├── reviewer-result.json
│   ├── narrator-result.json
│   ├── builder-result.json
│   ├── fixer-result.json
│   └── gatekeeper-verdict.json
└── scripts/
    ├── 4coop-orchestrator.mjs          # top-level start/continue/reject/check-comment/clean
    ├── 4coop-stage-claude.mjs          # runs a Claude subagent stage
    ├── 4coop-stage-codex.mjs           # runs a `codex exec` stage
    ├── 4coop-state.mjs                 # per-run state load/save helpers
    ├── 4coop-lock.mjs                  # pipeline.lock + queue helpers
    ├── 4coop-worktree.mjs              # worktree create/remove (see §3 footnote)
    ├── 4coop-paths.mjs                 # runtime path resolution
    ├── 4coop-config.mjs                # config load/merge + defaults
    ├── 4coop-schemas.mjs               # JSON-schema-backed stage output validation
    ├── 4coop-scaffolder.mjs            # project-local install bundle writer
    ├── 4coop-logger.mjs                # nightly event log writer (see docs/privacy.md)
    ├── 4coop-metrics.mjs               # per-stage token/duration tracking
    ├── 4coop-relay.mjs                 # stage-to-stage prompt relay builder
    ├── 4coop-canned.mjs                # hardcoded `[4CO-OP]:` replies
    ├── 4coop-tag-format.mjs            # stage-tag formatting helpers
    ├── 4coop-monitor-server.mjs        # local tracker HTTP server
    ├── 4coop-monitor-spawn.mjs         # browser window spawner
    ├── 4coop-monitor-client.html       # tracker UI page
    └── install.mjs                     # global + project install entry (see docs/install.md)
```

### Per-project runtime — `.4co-op/`

```
.4co-op/
├── install/4co-op/              # scaffolded copy of skill/4co-op/ (see 4coop-scaffolder.mjs)
├── config.json                  # project-local model/tag/monitor override
├── project.config.json          # project-local {build, test, lint} commands (required)
├── 4coop-active.json            # current awaiting-* session, if any
├── 4coop-pending-config.json    # transient state during config-confirm
├── runs/
│   └── <run_id>/
│       ├── state.json           # per-run state (see §3)
│       ├── plan.md
│       ├── review.md
│       ├── reviewer-input.md    # `gh pr diff` dump for the reviewer
│       ├── relay/               # stage-to-stage relay prompts (4coop-relay.mjs)
│       ├── raw/                 # created per run by ensureRuntimeDirs; currently unwritten
│       ├── <stage>-NN.ndjson          # codex stages only: raw --json stream per call
│       └── <stage>-NN-last-message.txt # codex stages only: last model message per call
├── logs/                        # nightly event log (see docs/privacy.md)
├── worktrees/                   # scaffolded placeholder dir; actual worktrees are
│                                # project siblings at ../<repo-name>-wt-<slug> (see §3)
├── monitor.port                 # port of the running tracker server, if any
├── pipeline.lock                # { run_id, feature, started_at } — presence = run active
└── pipeline-queue.json          # [{ feature, requested_at }, …]
```

### Host shim — `.claude/skills/4co-op/`

```
.claude/skills/4co-op/
├── SKILL.md                     # copied from skill/4co-op/SKILL.md
└── clean.md                     # copied from skill/4co-op/clean.md
```

Nothing else lives under `.claude/` for a normal project-local install; runs,
logs, worktrees, and agent files all live under `.4co-op/`.

### Source-repo wrappers — `scripts/`

```
scripts/
├── 4coop.mjs                    # thin wrapper: node scripts/4coop.mjs start|clean|check-comment
└── install-4coop.mjs            # thin wrapper: node scripts/install-4coop.mjs --global|--project
```

### Docs

```
docs/
├── architecture.md              # this file
├── install.md
├── commands.md
├── config.md
├── runtime.md
├── troubleshooting.md
├── privacy.md
└── examples.md
```

The runtime supports two install layouts: global (`~/.codex/skills/4co-op/` and
`~/.claude/skills/4co-op/`) and project-local (`.4co-op/install/4co-op/` plus the
`.claude/skills/4co-op/` shim). Runtime state always stays under the active project's
`.4co-op/` directory; bundled assets are resolved relative to the installed script
location. See `docs/install.md`.

## 7. Orchestration flow (`SKILL.md` pseudocode)

Every call to `say(...)` emits a tagged line to chat via the Narrator subagent (§5). The orchestrator **never** prints raw model output — it's either a direct-voice stage (Planner, Reviewer, Gatekeeper output whose prompt forces a tag) or it goes through `say(speaker, payload)`.

`runTrackedStage` in the pseudocode below is defined in `skill/4co-op/scripts/4coop-orchestrator.mjs`; it dispatches to `runCodexExec` / `runCodexResume` in `4coop-stage-codex.mjs` for codex stages (builder, fixer, gatekeeper) and to `runClaudeStage` in `4coop-stage-claude.mjs` for claude stages.

```
on /4co-op <feature>:
  # --- queue gate ---
  if lock_held() and lock_is_fresh(max_age=24h):
    append_to_queue({feature, requested_at: now})
    say("coop-meta", {event: "queued", behind: current_lock.feature, position: queue.length})
    return
  if lock_held() and not lock_is_fresh(24h):
    say("coop-meta", {event: "stale_lock_cleared", prev_run: current_lock.run_id})
    release_lock()

  acquire_lock({run_id: mkrunid(feature), feature})
  try:
    process_feature(feature)
    while queue.nonempty():
      next = queue.pop_oldest()
      say("coop-meta", {event: "starting_queued", feature: next.feature})
      process_feature(next.feature)
  finally:
    release_lock()

process_feature(feature):
  run_id = mkrunid(feature)
  init state.json
  say("coop-meta", {event: "run_started", feature})

  # Planner is direct-voice — its prompt enforces the [🧠 Planner | Opus 4.7 1M] prefix.
  plan_msg = Agent(planner, mode=plan).run({feature, repo_state})
  print_verbatim(plan_msg)                       # already tagged by the Planner
  state.plan = plan_msg.structured
  AskUserQuestion("Approve this plan?")
    → if no: say("coop-meta", {event: "halted", reason: "user_rejected_plan"}); end.

  git worktree add ../<repo-name>-wt-<slug> -b feat/<slug>
  state.worktree = {...}
  say("builder", {phase: "starting", branch: state.worktree.branch})

  builder_result = runTrackedStage("builder", plan.md, state.worktree.path)
  state.builder = builder_result
  say("builder", {phase: "done", commit: builder_result.commit_sha,
                   files: builder_result.files_changed.length,
                   tests: "green", lint: "green"})

  spec = Agent(spec-checker).run(state)              # direct-voice subagent
  state.spec_check = spec
  say("spec-checker", {pass: count(PASS), fail: count(FAIL), unclear: count(UNCLEAR)})

  if any spec.status == UNCLEAR:
    esc = Agent(escalation).run(state)               # direct-voice subagent
    merge esc into state.spec_check
    say("escalation", {resolved: esc.resolved_ids})

  if any spec.status == FAIL:
    say("coop-meta", {event: "halted", reason: "spec_fail"}); end.

  say("coop-meta", {event: "opening_pr"})
  pr = gh pr create ...
  state.pr = pr

  loop (max_iterations = 3):
    review = Agent(pr-reviewer).run(state)           # direct-voice; its own [👓 Reviewer | Opus 4.7] tag
    state.reviewer = review
    gh pr comment pr.number --body-file review.md
    say("reviewer", {count: review.issues.length, pr: pr.url})

    if review.issues == []: break

    runTrackedStage("fixer", state.builder.codex_session_id, review.issues)   # codex exec resume
    state.fixer.iterations += 1
    say("fixer", {commits: state.fixer.commits.length})

    verdict = runTrackedStage("gatekeeper", pr)
    state.gatekeeper = verdict
    say("gatekeeper", {verdict: verdict.verdict, severity: verdict.severity, pr: pr.url})

    if verdict.verdict == APPROVE: break
    if verdict.severity == IMPORTANT and state.fixer.iterations >= 2:
      say("coop-meta", {event: "handoff_to_user", reason: "important_persists"})
      break
    if verdict.severity == CRITICAL: continue  # another fix round

# --- lazy worktree sweep (runs at the top of every /4co-op) ---
sweep_merged_worktrees():
  for run_dir in glob(".4co-op/runs/*/state.json"):
    s = read_json(run_dir)
    if not s.pr: continue
    if not exists(s.worktree.path): continue
    pr_state = bash(f"gh pr view {s.pr.number} --json state --jq .state")
    if pr_state in ("MERGED", "CLOSED"):
      bash(f"git worktree remove --force {s.worktree.path}")
      say("coop-meta", {event: "worktree_cleaned", pr: s.pr.number})

# Call sweep_merged_worktrees() once at the top of the queue-gate in /4co-op, before acquire_lock.

# say(speaker, payload):
#   tagged_line = Agent(narrator).run({speaker, payload, state})
#   assert tagged_line.startswith(tag_for(speaker))   # hard invariant
#   print(tagged_line)
```

The `assert tagged_line.startswith(tag_for(speaker))` check is the enforcement mechanism: if Haiku ever drops the tag, the orchestrator halts rather than showing an untagged message.

## 8. Error handling

| Failure | Response |
|---|---|
| Planner asks unanswerable question | Bubble to user via `AskUserQuestion`, pause |
| Codex Builder exit ≠ 0 | Narrator reports; keep worktree for inspection; end |
| Build/test/lint fail in Builder | Builder retries internally; if still red, exits non-0 |
| Spec Checker returns FAIL (not UNCLEAR) | Halt — don't open a PR for a known-broken impl |
| Escalation can't decide | Shouldn't happen (prompt forbids UNCLEAR); if it does, treat as FAIL |
| Reviewer hits its 10-issue cap | Note in comment: "truncated at 10 — rerun review after fix round" |
| Gatekeeper ping-pongs on IMPORTANT | Cap at 2 iterations, hand off to user |
| `codex exec` rate-limited (ChatGPT sign-in) | Surface the error, suggest switching to API key |
| `/4co-op` invoked while another is running | Append to `pipeline-queue.json`, emit queued-at-position-N message, exit |
| Stale `pipeline.lock` (>24h old) | Assume crashed run, clear lock, proceed with current feature |
| PR merged but worktree still present | Lazy sweep at start of next `/4co-op` (and inside `/4co-op clean`) removes it |
| `.4co-op/project.config.json` missing or incomplete | Halt before Builder with `[📣 Coop \| Haiku 4.5]` error; link the exact template to copy |
| `git worktree remove` fails (e.g., dirty state) | Surface the error; leave worktree for user; `/4co-op clean --force` overrides |

## 9. Known constraints & open questions

**Constraints**
- **ChatGPT sign-in rate limits** will bite: GPT-5.4 is 20–100 msgs / 5hr, gpt-5.3-codex is 30–150 / 5hr on Plus. A full `/4co-op` run uses 3–5 Codex calls (Builder + Fixer×N + Gatekeeper×N). Two or three runs per day is realistic on Plus; dozens is not. Re-evaluate if this bites.
- **Worktree path is orchestrator-managed**, not Claude Code's built-in `isolation: worktree` (that one hides the path). We'll `git worktree add` ourselves so Codex and PR tooling can find it.
- **Strict mode is prompt-enforced**, not a model flag. Output is validated against the schema after the fact; malformed responses halt the pipeline.
- **Haiku narration ≠ silent**: each narration is a real API call, costs tokens. Cheap but not free.

**Resolved decisions**
- **Plan approval gate:** Always wait for user "go" before Builder starts.
- **Codex invocation:** `codex exec` with structured output schema for v1. `codex mcp-server` is a later refactor.
- **Worktree lifecycle:** Fresh throwaway worktree per run. Cleanup is **lazy**: at the start of every new `/4co-op` (and inside `/4co-op clean`), the orchestrator scans all previous runs' state files, asks `gh pr view <n> --json state` for each, and runs `git worktree remove` on any whose PR is MERGED or CLOSED. No background polling, no scheduled tasks — merges trigger cleanup on the next invocation.
- **Project config:** Explicit `.4co-op/project.config.json` with `build`, `test`, `lint` keys. Orchestrator refuses to start Builder if the file is missing or any key is empty — no inference, no guessing.
- **Concurrent `/4co-op`:** Queue. A lock file `.4co-op/pipeline.lock` marks the running run; a new `/4co-op` sees the lock and appends to `.4co-op/pipeline-queue.json` with a "[📣 Coop | Haiku 4.5]: Queued behind <feature> (position N)" reply, then exits. The running pipeline drains the queue at the end of each feature.
- **Runs history:** Keep forever by default. Deletion is manual via `/4co-op clean` (see §11).

## 10. First real run — verification checklist

Before the first `/4co-op <feature>`:
- [ ] `codex --version` works (confirmed: 0.121.0)
- [ ] `codex login` status is healthy
- [ ] `gh auth status` healthy (confirmed: <github-user>, `repo` scope)
- [ ] `.4co-op/project.config.json` exists with `build`, `test`, `lint` keys
- [ ] `.4co-op/install/4co-op/schemas/*.json` present and valid JSON Schema
- [ ] `.claude/agents/*.md` frontmatter validated (`model`, `permissionMode`, `tools`)
- [ ] Narrator smoke test: call it with each `speaker` value and confirm the output starts with the exact tag from §5
- [ ] Dry-run `/4co-op "rename README.md title"` — smallest change that exercises all 7 stages
- [ ] Queue test: invoke `/4co-op A` then `/4co-op B` before A finishes — confirm B is queued, then auto-starts when A completes
- [ ] Cleanup test: merge A's PR, run `/4co-op C` — confirm A's worktree is swept at the top of C
- [ ] `/4co-op clean --dry-run` lists what it would delete; `/4co-op clean --all` does delete

First real-feature suggestion: something with a real acceptance checklist but tiny surface area — e.g., "add a `scripts/verify-setup.sh` that checks codex/gh/git presence and exits 0/non-0 accordingly." Forces Builder to write a script + tests + lint, gives Spec Checker real checklist items, produces a small PR for Reviewer/Gatekeeper to exercise end-to-end.

## 11. `/4co-op clean` command

Manual cleanup for runs history and orphan worktrees. Packaged as a skill subcommand at `.claude/skills/4co-op/clean.md` (host shim) — the editable source lives at `skill/4co-op/clean.md` and is copied into the shim by the scaffolder.

**Usage:**
```
/4co-op clean                  # sweeps merged/closed worktrees, leaves run folders alone (safe default)
/4co-op clean --older-than 30d # also deletes .4co-op/runs/<id>/ older than 30 days
/4co-op clean --keep-last 20   # also keeps only the 20 most recent run folders
/4co-op clean --all            # nukes every run folder + every orphan worktree (asks for confirm)
/4co-op clean --dry-run        # prints what would be deleted without deleting
/4co-op clean --force          # also removes worktrees that fail `git worktree remove` cleanly
```

**What it does, in order:**
1. Scan `.4co-op/runs/*/state.json`. For each run:
   - If `state.pr` present → `gh pr view <n> --json state`. If MERGED or CLOSED, remove the worktree (unless already gone).
   - Regardless of PR state, apply the `--older-than` / `--keep-last` / `--all` filter to the run folder itself.
2. List orphan worktrees (exist on disk but no matching run_id in `.4co-op/runs/`) — offer to remove with `--force`.
3. Never touch an active run — if `pipeline.lock` exists and is fresh, refuse and emit `[📣 Coop | Haiku 4.5]: Run in progress, refusing to clean.`

**Output:** one tagged summary line per category, e.g.:
```
[📣 Coop | Haiku 4.5]: Swept 3 merged worktrees, deleted 12 run folders older than 30d, 2 orphans skipped (use --force).
```

**Safety:** `--all` always prompts for explicit confirmation (`AskUserQuestion`) before deleting anything. No other flag is destructive without `--dry-run` available.

---

## Summary

Every piece of the pipeline maps to a feature that exists today:
- Subagents with per-call model selection (Opus / Sonnet / Haiku) — supported
- `permissionMode: plan` for the Planner — enforced
- `codex exec` with `--cd`, `--model`, `--sandbox`, `--output-schema` — supported
- `codex exec resume` for Fixer context continuity — supported
- Skills-based packaging of `/4co-op` — supported
- Narrator pattern via Haiku subagent — idiomatic

The biggest real-world risk is **ChatGPT sign-in rate limits**, not architecture. Everything else is just careful prompt + schema engineering.
