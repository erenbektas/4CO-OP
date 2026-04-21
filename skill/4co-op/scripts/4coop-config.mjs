import fs from 'node:fs'
import path from 'node:path'
import {
  STAGE_KEYS,
  pathExists,
  readJsonIfExists,
  readTextIfExists,
  resolveConfigLookup
} from './4coop-paths.mjs'

const DEFAULT_CONFIG = {
  version: 1,
  models: {
    planner: { cli: 'claude', model: 'claude-opus-4-7', context: '1m', tag_display: 'Opus 4.7 1M' },
    builder: { cli: 'codex', model: 'gpt-5.3-codex', tag_display: '5.3-Codex' },
    spec_checker: { cli: 'claude', model: 'claude-sonnet-4-6', tag_display: 'Sonnet 4.6' },
    escalation: { cli: 'claude', model: 'claude-opus-4-7', tag_display: 'Opus 4.7' },
    reviewer: { cli: 'claude', model: 'claude-opus-4-7', tag_display: 'Opus 4.7' },
    fixer: { cli: 'codex', model: 'gpt-5.3-codex', tag_display: '5.3-Codex' },
    gatekeeper: { cli: 'codex', model: 'gpt-5.4', tag_display: '5.4' },
    narrator: { cli: 'claude', model: 'claude-haiku-4-5', tag_display: 'Haiku 4.5' }
  },
  tags: {
    meta: '[4CO-OP]',
    planner: '[🧠 Planner | {tag_display}]',
    builder: '[🛠️ Builder | {tag_display}]',
    spec_checker: '[✅ Spec Checker | {tag_display}]',
    escalation: '[🔎 Escalation | {tag_display}]',
    reviewer: '[👓 Reviewer | {tag_display}]',
    fixer: '[🔧 Fixer | {tag_display}]',
    gatekeeper: '[⚖️ Gatekeeper | {tag_display}]',
    narrator: '[4CO-OP]'
  },
  monitor_window: {
    enabled: true,
    port: 0,
    auto_launch: true,
    browser: 'auto'
  },
  logging: {
    enabled: true,
    dir: '.4co-op/logs',
    snapshot_interval_seconds_active: 10,
    snapshot_interval_seconds_idle: 60
  }
}

export function getDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

function deepMerge(base, override) {
  if (override === undefined) {
    return base
  }
  if (Array.isArray(base) || Array.isArray(override)) {
    return override
  }
  if (typeof base !== 'object' || base === null || typeof override !== 'object' || override === null) {
    return override
  }

  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(base[key], value)
  }
  return merged
}

export function validateConfig(config) {
  const errors = []

  if (!Number.isInteger(config.version) || config.version < 1) {
    errors.push('version must be an integer >= 1')
  }

  for (const stage of STAGE_KEYS) {
    const modelConfig = config.models?.[stage]
    if (!modelConfig) {
      errors.push(`missing models.${stage}`)
      continue
    }
    if (!['claude', 'codex'].includes(modelConfig.cli)) {
      errors.push(`models.${stage}.cli must be "claude" or "codex"`)
    }
    if (!modelConfig.model) {
      errors.push(`models.${stage}.model must be non-empty`)
    }
    if (!modelConfig.tag_display) {
      errors.push(`models.${stage}.tag_display must be non-empty`)
    }
  }

  for (const key of ['meta', ...STAGE_KEYS]) {
    if (!config.tags?.[key]) {
      errors.push(`missing tags.${key}`)
    }
  }

  if (!Number.isInteger(config.monitor_window?.port) || config.monitor_window.port < 0 || config.monitor_window.port > 65535) {
    errors.push('monitor_window.port must be an integer between 0 and 65535')
  }

  for (const field of ['snapshot_interval_seconds_active', 'snapshot_interval_seconds_idle']) {
    if (!Number.isInteger(config.logging?.[field]) || config.logging[field] < 1) {
      errors.push(`logging.${field} must be an integer >= 1`)
    }
  }

  if (!config.logging?.dir) {
    errors.push('logging.dir must be non-empty')
  }

  return errors
}

export function loadConfig(projectRoot) {
  const merged = resolveConfigLookup(projectRoot)
    .map(candidate => readJsonIfExists(candidate))
    .filter(Boolean)
    .reduce((accumulator, nextValue) => deepMerge(accumulator, nextValue), getDefaultConfig())

  const errors = validateConfig(merged)
  if (errors.length > 0) {
    throw new Error(`Invalid 4CO-OP config:\n- ${errors.join('\n- ')}`)
  }
  return merged
}

export function loadProjectCommands(projectConfigPath) {
  const raw = readJsonIfExists(projectConfigPath)
  if (!raw) {
    return null
  }
  return {
    confirmed: Boolean(raw.confirmed),
    build: String(raw.build ?? '').trim(),
    test: String(raw.test ?? '').trim(),
    lint: String(raw.lint ?? '').trim()
  }
}

export function validateProjectCommands(projectCommands) {
  const errors = []
  if (!projectCommands) {
    errors.push('missing project commands')
    return errors
  }

  for (const key of ['build', 'test', 'lint']) {
    if (typeof projectCommands[key] !== 'string') {
      errors.push(`${key} must be a string`)
    }
  }

  if (!String(projectCommands.build ?? '').trim()) {
    errors.push('build command cannot be empty')
  }
  if (!String(projectCommands.lint ?? '').trim()) {
    errors.push('lint command cannot be empty')
  }

  return errors
}

export function projectCommandsReady(projectCommands) {
  return Boolean(projectCommands) &&
    projectCommands.confirmed === true &&
    validateProjectCommands(projectCommands).length === 0
}

function summarizeNodeProject(packageJsonPath) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const scripts = packageJson.scripts ?? {}
  const build = scripts.build ? 'npm run build' : ''
  const test = scripts.test ? 'npm test' : ''
  const lint = scripts.lint ? 'npm run lint' : ''
  return {
    detected_stack: 'Node',
    proposed_build: build,
    proposed_test: test,
    proposed_lint: lint,
    confidence: scripts.build || scripts.test || scripts.lint ? 0.95 : 0.65,
    summary: 'Looks like a Node project.'
  }
}

function summarizePythonProject(projectRoot) {
  const pyprojectPath = path.join(projectRoot, 'pyproject.toml')
  const pyproject = readTextIfExists(pyprojectPath) ?? ''
  const hasPytest = /\[tool\.pytest\]/.test(pyproject) || pathExists(path.join(projectRoot, 'pytest.ini'))
  return {
    detected_stack: 'Python',
    proposed_build: 'python -m build',
    proposed_test: hasPytest ? 'pytest' : '',
    proposed_lint: 'ruff check .',
    confidence: hasPytest ? 0.75 : 0.65,
    summary: 'Looks like a Python project.'
  }
}

export function proposeProjectCommands(projectRoot) {
  const packageJsonPath = path.join(projectRoot, 'package.json')
  if (pathExists(packageJsonPath)) {
    return summarizeNodeProject(packageJsonPath)
  }
  if (pathExists(path.join(projectRoot, 'pyproject.toml'))) {
    return summarizePythonProject(projectRoot)
  }
  if (pathExists(path.join(projectRoot, 'go.mod'))) {
    return {
      detected_stack: 'Go',
      proposed_build: 'go build ./...',
      proposed_test: 'go test ./...',
      proposed_lint: 'go vet ./...',
      confidence: 0.8,
      summary: 'Looks like a Go project.'
    }
  }
  if (pathExists(path.join(projectRoot, 'Cargo.toml'))) {
    return {
      detected_stack: 'Rust',
      proposed_build: 'cargo build',
      proposed_test: 'cargo test',
      proposed_lint: 'cargo clippy -- -D warnings',
      confidence: 0.8,
      summary: 'Looks like a Rust project.'
    }
  }
  if (pathExists(path.join(projectRoot, 'Makefile'))) {
    return {
      detected_stack: 'Generic',
      proposed_build: 'make build',
      proposed_test: 'make test',
      proposed_lint: 'make lint',
      confidence: 0.55,
      summary: 'I found a Makefile, so I can start from the usual make targets.'
    }
  }
  return {
    detected_stack: 'Unknown',
    proposed_build: '',
    proposed_test: '',
    proposed_lint: '',
    confidence: 0.2,
    summary: 'I could not confidently detect build, test, and lint commands from the project files I found.'
  }
}
