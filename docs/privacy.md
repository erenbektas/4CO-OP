# 4CO-OP Privacy And Logging

This file describes what the nightly tracker/logging system records and what it intentionally avoids.

## Log File Location

By default, nightly logs are written to:

```text
.4co-op/logs/
```

The default file name format is:

```text
ddmmyyyyhhmmss.log
```

## What Gets Logged

The logger records structured JSON lines.

Main event types:

- `run_start`
- `run_end`
- `comment_check_start`
- `comment_check_end`
- `window_opened`
- `window_closed`
- `stage_call`
- `interruption`
- `table_snapshot`

## What A Table Snapshot Contains

`table_snapshot` is the nightly tracker summary for each stage.

Per stage it records:

- stage name
- total tokens
- total runtime
- call count
- whether the stage was interrupted
- whether token counts are exact or estimated

This is the same summary-level data shown in the tracker table. It does not store the detail pane text.

## What A Stage Call Contains

A `stage_call` entry records summary metadata such as:

- stage name
- call number
- duration
- input token count
- output token count
- exit code
- whether the token counts were exact

## What Is Explicitly Not Logged

The logger is designed to avoid storing:

- prompts
- model input text
- model output text
- file names
- file paths
- URLs
- branch names
- plan markdown
- PR body text
- quotes lifted from review artifacts
- feature request text

## Redaction Rules

The logger sanitizes payloads in two main ways.

### Key-Based Redaction

If a payload field name looks sensitive, the logger drops it completely.

Examples of blocked key patterns:

- `prompt`
- `input`
- `output`
- `path`
- `file`
- `branch`
- `url`
- `plan_markdown`
- `body_markdown`
- `quote`
- `feature_request`
- `feature`

### Value-Based Redaction

Even if the key name is harmless, string values are still sanitized.

Current protections:

- strings longer than 200 characters are replaced with a redacted marker
- Windows-style absolute paths are redacted
- URLs are redacted
- relative path-like values are redacted
- commit SHA-like values are redacted

## What The Tracker Window Shows

The tracker window can show more detail than the log file.

The window may display:

- a stage input preview
- a stage output preview
- token counts
- runtime
- call count

Important:

- this is live UI state for the local user
- the logger does not write those full detail-pane texts into the nightly log

## What Still Requires User Judgment

4CO-OP tries to sanitize nightly logs, but local runtime artifacts still deserve normal care.

Treat these as local working data:

- `.4co-op/runs/`
- `.4co-op/logs/`
- `.4co-op/worktrees/`
- `.4co-op/4coop-active.json`

Do not commit them from a normal target project.

## Disable Logging

To disable nightly logging, set this in `.4co-op/config.json`:

```json
{
  "logging": {
    "enabled": false
  }
}
```

## Delete Existing Logs

Delete:

```text
.4co-op/logs/
```
