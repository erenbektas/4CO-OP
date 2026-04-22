import {
  STAGE_KEYS,
  getRuntimePaths,
  pathExists,
  readJsonIfExists,
  resolveConfigLookup,
  writeJson
} from './4coop-paths.mjs'
import { proposeProjectCommands as detectProjectCommands } from './4coop-detect.mjs'

const CURRENT_CONFIG_VERSION = 2

const DEFAULT_CONFIG = {
  version: CURRENT_CONFIG_VERSION,
  models: {
    planner: { cli: 'claude', model: 'claude-opus-4-7', context: '1m', tag_display: 'Opus 4.7 1M' },
    builder: { cli: 'codex', model: 'gpt-5.4', tag_display: '5.4' },
    spec_checker: { cli: 'claude', model: 'claude-sonnet-4-6', tag_display: 'Sonnet 4.6', escalation_model: 'claude-opus-4-7' },
    escalation: { cli: 'claude', model: 'claude-opus-4-7', tag_display: 'Opus 4.7' },
    reviewer: { cli: 'claude', model: 'claude-opus-4-7', tag_display: 'Opus 4.7' },
    fixer: { cli: 'codex', model: 'gpt-5.4', tag_display: '5.4' },
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
    browser: 'system'
  },
  logging: {
    enabled: true,
    dir: '.4co-op/logs',
    snapshot_interval_seconds_active: 10,
    snapshot_interval_seconds_idle: 60
  },
  workflow: {
    default_base_branch: ''
  }
}

export function getDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

function upgradeConfigObject(config) {
  const next = JSON.parse(JSON.stringify(config))
  const startingVersion = Number.isInteger(next.version) ? next.version : 1
  let changed = false

  if (startingVersion < 2) {
    // v1 default for monitor_window.browser was "auto" (preferred Chrome/Edge/Brave).
    // v2 default is "system" — the OS default browser. Rewrite only the stale default;
    // preserve any explicit non-auto choice the user had made.
    if (next.monitor_window && next.monitor_window.browser === 'auto') {
      next.monitor_window.browser = 'system'
      changed = true
    }

    // v1 defaults for builder/fixer were gpt-5.3-codex; v2 promotes them to gpt-5.4.
    // Only rewrite when the user is on the stale default — explicit overrides stay put.
    for (const stage of ['builder', 'fixer']) {
      const stageConfig = next.models?.[stage]
      if (stageConfig && stageConfig.model === 'gpt-5.3-codex') {
        stageConfig.model = 'gpt-5.4'
        if (stageConfig.tag_display === '5.3-Codex') {
          stageConfig.tag_display = '5.4'
        }
        changed = true
      }
    }
  }

  if (next.version !== CURRENT_CONFIG_VERSION) {
    next.version = CURRENT_CONFIG_VERSION
    changed = true
  }

  return { config: next, changed }
}

export function migrateProjectConfig(projectRoot) {
  const paths = getRuntimePaths(projectRoot)
  if (!pathExists(paths.projectConfigOverridePath)) {
    return { migrated: false, reason: 'no-project-config' }
  }

  const existing = readJsonIfExists(paths.projectConfigOverridePath)
  if (!existing || typeof existing !== 'object') {
    return { migrated: false, reason: 'invalid-project-config' }
  }

  const { config, changed } = upgradeConfigObject(existing)
  if (!changed) {
    return { migrated: false, reason: 'already-current' }
  }

  writeJson(paths.projectConfigOverridePath, config)
  return { migrated: true, from: existing.version ?? null, to: CURRENT_CONFIG_VERSION }
}

export function deepMerge(base, override) {
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

  return errors
}

export function projectCommandsReady(projectCommands) {
  return Boolean(projectCommands) &&
    projectCommands.confirmed === true &&
    validateProjectCommands(projectCommands).length === 0
}

export function proposeProjectCommands(projectRoot) {
  return detectProjectCommands(projectRoot)
}
