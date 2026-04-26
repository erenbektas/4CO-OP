# 4CO-OP Config

4CO-OP loads config in this order:

1. bundled defaults from `skill/4co-op/config.json`
2. project override from `.4co-op/config.json`

If the same key exists in both files, the project override wins.

## Main Rules

- the file must stay valid JSON
- unknown extra keys are not supported
- every stage must define `cli`, `model`, and `tag_display`
- `cli` must be either `claude` or `codex`

## File To Edit

For a project-local install, edit:

```text
.4co-op/config.json
```

Do not edit the generated install copy under `.4co-op/install/4co-op/` unless you intentionally want to patch only that local copied bundle.

## Top-Level Keys

### `version`

- type: integer
- current required minimum: `1`

### `models`

This defines which CLI and model each stage uses.

Stages:

- `planner`
- `builder`
- `spec_checker`
- `escalation`
- `reviewer`
- `fixer`
- `gatekeeper`
- `narrator`

Each stage object supports:

- `cli`: `claude` or `codex`
- `model`: model id string passed to that CLI
- `tag_display`: short label shown in tags and the tracker
- `context`: optional string, currently used by the default planner config

Default model map:

| Stage | Default CLI | Default Model | Default Tag |
| --- | --- | --- | --- |
| planner | `claude` | `claude-opus-4-7` | `Opus 4.7 1M` |
| builder | `codex` | `gpt-5.4` | `5.4` |
| spec_checker | `claude` | `claude-sonnet-4-6` | `Sonnet 4.6` |
| escalation | `claude` | `claude-opus-4-7` | `Opus 4.7` |
| reviewer | `claude` | `claude-opus-4-7` | `Opus 4.7` |
| fixer | `codex` | `gpt-5.4` | `5.4` |
| gatekeeper | `codex` | `gpt-5.4` | `5.4` |
| narrator | `claude` | `claude-haiku-4-5` | `Haiku 4.5` |

### `tags`

This controls the user-visible prefixes added to messages.

Required keys:

- `meta`
- `planner`
- `builder`
- `spec_checker`
- `escalation`
- `reviewer`
- `fixer`
- `gatekeeper`
- `narrator`

The stage tags can use `{tag_display}` and 4CO-OP will replace it with that stage's configured `tag_display`.

Default values:

```json
{
  "meta": "[4CO-OP]",
  "planner": "[🧠 Planner | {tag_display}]",
  "builder": "[🛠️ Builder | {tag_display}]",
  "spec_checker": "[✅ Spec Checker | {tag_display}]",
  "escalation": "[🔎 Escalation | {tag_display}]",
  "reviewer": "[👓 Reviewer | {tag_display}]",
  "fixer": "[🔧 Fixer | {tag_display}]",
  "gatekeeper": "[⚖️ Gatekeeper | {tag_display}]",
  "narrator": "[4CO-OP]"
}
```

### `monitor_window`

Controls the nightly tracker window.

Keys:

- `enabled`: `true` or `false`
- `port`: integer `0` to `65535`
- `auto_launch`: `true` or `false`
- `browser`: browser launcher preference

Notes:

- `port: 0` means choose a free port automatically
- `browser: "system"` is the default and opens the tracker in the OS default browser
- `browser: "auto"` prefers an app-style window via Chrome/Edge/Brave when one is installed
- explicit names like `edge`, `chrome`, and `brave` are supported
- an executable path can also be used

### `logging`

Controls nightly logging.

Keys:

- `enabled`: `true` or `false`
- `dir`: output directory
- `snapshot_interval_seconds_active`: integer `>= 1`
- `snapshot_interval_seconds_idle`: integer `>= 1`

Notes:

- if `dir` is relative, it is resolved from the project root
- the default value is `.4co-op/logs`

## Example

```json
{
  "version": 1,
  "models": {
    "planner": {
      "cli": "claude",
      "model": "claude-opus-4-7",
      "context": "1m",
      "tag_display": "Opus 4.7 1M"
    },
    "builder": {
      "cli": "codex",
      "model": "gpt-5.4",
      "tag_display": "5.4"
    },
    "spec_checker": {
      "cli": "claude",
      "model": "claude-sonnet-4-6",
      "tag_display": "Sonnet 4.6"
    },
    "escalation": {
      "cli": "claude",
      "model": "claude-opus-4-7",
      "tag_display": "Opus 4.7"
    },
    "reviewer": {
      "cli": "claude",
      "model": "claude-opus-4-7",
      "tag_display": "Opus 4.7"
    },
    "fixer": {
      "cli": "codex",
      "model": "gpt-5.4",
      "tag_display": "5.4"
    },
    "gatekeeper": {
      "cli": "codex",
      "model": "gpt-5.4",
      "tag_display": "5.4"
    },
    "narrator": {
      "cli": "claude",
      "model": "claude-haiku-4-5",
      "tag_display": "Haiku 4.5"
    }
  },
  "tags": {
    "meta": "[4CO-OP]",
    "planner": "[🧠 Planner | {tag_display}]",
    "builder": "[🛠️ Builder | {tag_display}]",
    "spec_checker": "[✅ Spec Checker | {tag_display}]",
    "escalation": "[🔎 Escalation | {tag_display}]",
    "reviewer": "[👓 Reviewer | {tag_display}]",
    "fixer": "[🔧 Fixer | {tag_display}]",
    "gatekeeper": "[⚖️ Gatekeeper | {tag_display}]",
    "narrator": "[4CO-OP]"
  },
  "monitor_window": {
    "enabled": true,
    "port": 0,
    "auto_launch": true,
    "browser": "system"
  },
  "logging": {
    "enabled": true,
    "dir": ".4co-op/logs",
    "snapshot_interval_seconds_active": 10,
    "snapshot_interval_seconds_idle": 60
  }
}
```
