import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic, writeJsonAtomic } from './4coop-atomic.mjs'

export const SKILL_NAME = '4co-op'
export const RUNTIME_DIRNAME = '.4co-op'
export const STAGE_KEYS = [
  'planner',
  'builder',
  'spec_checker',
  'escalation',
  'reviewer',
  'fixer',
  'gatekeeper',
  'narrator',
  'pr_writer'
]

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..')

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
  return dirPath
}

export function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

export function readTextIfExists(targetPath) {
  if (!pathExists(targetPath)) {
    return null
  }
  return fs.readFileSync(targetPath, 'utf8')
}

export function readJsonIfExists(targetPath) {
  const raw = readTextIfExists(targetPath)
  if (!raw) {
    return null
  }
  return JSON.parse(raw)
}

export function writeJson(targetPath, value) {
  writeJsonAtomic(targetPath, value)
}

export function writeTextFile(targetPath, value) {
  writeFileAtomic(targetPath, String(value ?? ''))
}

export function appendText(targetPath, value) {
  ensureDir(path.dirname(targetPath))
  fs.appendFileSync(targetPath, value, 'utf8')
}

export function toPosixPath(value) {
  return value.split(path.sep).join('/')
}

export function relativeProjectPath(projectRoot, absolutePath) {
  return toPosixPath(path.relative(projectRoot, absolutePath))
}

export function findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir)

  while (true) {
    if (pathExists(path.join(current, '.git'))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`Unable to find project root from ${startDir}`)
    }
    current = parent
  }
}

export function globalClaudeSkillRoot() {
  return path.join(os.homedir(), '.claude', 'skills', SKILL_NAME)
}

export function globalCodexSkillRoot() {
  return path.join(os.homedir(), '.codex', 'skills', SKILL_NAME)
}

export function globalSkillRoots() {
  return [
    { host: 'codex', path: globalCodexSkillRoot() },
    { host: 'claude', path: globalClaudeSkillRoot() }
  ]
}

export function resolveBundledPath(...segments) {
  return path.join(SKILL_ROOT, ...segments)
}

export function formatLogTimestamp(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = String(date.getFullYear())
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${dd}${mm}${yyyy}${hh}${min}${ss}`
}

export function formatRunIdTimestamp(date = new Date()) {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}-${hh}${min}${ss}`
}

export function slugify(value, fallback = 'task') {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.slice(0, 48) || fallback
}

export function buildRunId(feature, date = new Date()) {
  return `4coop-${formatRunIdTimestamp(date)}-${slugify(feature, 'prompt')}`
}

export function getRuntimePaths(projectRoot, runId = null) {
  const runtimeDir = path.join(projectRoot, RUNTIME_DIRNAME)
  const runtimeRunsDir = path.join(runtimeDir, 'runs')
  const runtimeLogsDir = path.join(runtimeDir, 'logs')
  const runtimeWorktreesDir = path.join(runtimeDir, 'worktrees')
  const projectInstallDir = path.join(runtimeDir, 'install', SKILL_NAME)
  const projectConfigOverridePath = path.join(runtimeDir, 'config.json')
  const projectConfigPath = path.join(runtimeDir, 'project.config.json')
  const projectClaudeDir = path.join(projectRoot, '.claude')
  const projectClaudeSkillDir = path.join(projectClaudeDir, 'skills', SKILL_NAME)
  const pendingConfigFile = path.join(runtimeDir, '4coop-pending-config.json')
  const activeFile = path.join(runtimeDir, '4coop-active.json')
  const lockFile = path.join(runtimeDir, 'pipeline.lock')
  const queueFile = path.join(runtimeDir, 'pipeline-queue.json')
  const monitorPortFile = path.join(runtimeDir, 'monitor.port')
  const settingsLocalPath = path.join(projectClaudeDir, 'settings.local.json')
  const legacyProjectConfigPath = path.join(projectRoot, 'project.config.json')
  const runDir = runId ? path.join(runtimeRunsDir, runId) : null

  return {
    projectRoot,
    runtimeDir,
    runtimeRunsDir,
    runtimeLogsDir,
    runtimeWorktreesDir,
    projectInstallDir,
    projectConfigOverridePath,
    projectClaudeDir,
    projectClaudeSkillDir,
    pendingConfigFile,
    activeFile,
    lockFile,
    queueFile,
    monitorPortFile,
    settingsLocalPath,
    projectConfigPath,
    legacyProjectConfigPath,
    runId,
    runDir,
    stateFile: runDir ? path.join(runDir, 'state.json') : null,
    planFile: runDir ? path.join(runDir, 'plan.md') : null,
    reviewFile: runDir ? path.join(runDir, 'review.md') : null,
    reviewerInputFile: runDir ? path.join(runDir, 'reviewer-input.md') : null,
    relayDir: runDir ? path.join(runDir, 'relay') : null,
    ndjsonDir: runDir ? path.join(runDir, 'raw') : null,
    stageInFlightFile: runDir ? path.join(runDir, 'stage-in-flight.json') : null
  }
}

export function ensureRuntimeDirs(paths) {
  ensureDir(paths.runtimeDir)
  ensureDir(paths.runtimeRunsDir)
  ensureDir(paths.runtimeLogsDir)
  ensureDir(paths.runtimeWorktreesDir)

  if (paths.runDir) {
    ensureDir(paths.runDir)
    ensureDir(paths.relayDir)
    ensureDir(paths.ndjsonDir)
  }
}

export function resolveConfigLookup(projectRoot) {
  const projectPaths = getRuntimePaths(projectRoot)
  // Bundled first (fallback for missing keys), project override last so user
  // edits in .4co-op/config.json win over the shipped defaults.
  return [
    resolveBundledPath('config.json'),
    projectPaths.projectConfigOverridePath
  ]
}

export function coerceArray(value) {
  if (Array.isArray(value)) {
    return value
  }
  if (value === undefined || value === null) {
    return []
  }
  return [value]
}
