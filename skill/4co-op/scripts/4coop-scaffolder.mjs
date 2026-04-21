import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SKILL_ROOT,
  ensureDir,
  getRuntimePaths,
  pathExists,
  readJsonIfExists
} from './4coop-paths.mjs'
import { getDefaultConfig, loadConfig } from './4coop-config.mjs'

const AGENT_FILES = [
  ['4coop-planner.md', 'planner'],
  ['4coop-spec-checker.md', 'spec_checker'],
  ['4coop-escalation.md', 'escalation'],
  ['4coop-pr-reviewer.md', 'reviewer'],
  ['4coop-narrator.md', 'narrator']
]

const REQUIRED_PERMISSIONS = [
  'Bash(node *)',
  'Bash(codex *)',
  'Bash(gh *)',
  'Bash(git worktree *)',
  'Bash(claude -p *)',
  'Bash(cmd /c start *)',
  'Bash(open *)',
  'Bash(xdg-open *)'
]

const GITIGNORE_MARKER = '# 4CO-OP local install and runtime artifacts'
const GITIGNORE_BLOCK = `${GITIGNORE_MARKER}
.4co-op/
.claude/
`

function replaceModelLine(content, modelSlug) {
  return content.replace(/^model:\s*.+$/m, `model: ${modelSlug}`)
}

function syncSingleAgent(targetPath, bundledPath, modelSlug) {
  const content = fs.readFileSync(bundledPath, 'utf8')
  const rendered = replaceModelLine(content, modelSlug)
  ensureDir(path.dirname(targetPath))
  fs.writeFileSync(targetPath, rendered, 'utf8')
}

function syncAgents(projectRoot, config) {
  const paths = getRuntimePaths(projectRoot)
  for (const [fileName, stageKey] of AGENT_FILES) {
    const bundledPath = path.join(SKILL_ROOT, 'agents', fileName)
    const stageModel = config.models[stageKey]?.model ?? getDefaultConfig().models[stageKey].model
    syncSingleAgent(path.join(paths.projectInstallDir, 'agents', fileName), bundledPath, stageModel)
  }
}

function cleanupManagedSettingsLocal(paths) {
  if (!pathExists(paths.settingsLocalPath)) {
    return
  }

  const existing = readJsonIfExists(paths.settingsLocalPath)
  if (!existing || typeof existing !== 'object' || existing === null || !Array.isArray(existing.permissions?.allow)) {
    return
  }

  const filteredAllow = existing.permissions.allow.filter(entry => !REQUIRED_PERMISSIONS.includes(String(entry ?? '')))
  if (filteredAllow.length === existing.permissions.allow.length) {
    return
  }

  const next = JSON.parse(JSON.stringify(existing))
  if (filteredAllow.length > 0) {
    next.permissions.allow = filteredAllow
  } else {
    delete next.permissions.allow
  }

  if (next.permissions && Object.keys(next.permissions).length === 0) {
    delete next.permissions
  }

  if (Object.keys(next).length === 0) {
    fs.rmSync(paths.settingsLocalPath, {
      force: true
    })
    return
  }

  ensureDir(path.dirname(paths.settingsLocalPath))
  fs.writeFileSync(paths.settingsLocalPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

function ensureHostSkillFiles(paths) {
  if (pathExists(paths.projectClaudeSkillDir)) {
    fs.rmSync(paths.projectClaudeSkillDir, {
      recursive: true,
      force: true
    })
  }
  ensureDir(paths.projectClaudeSkillDir)
  for (const fileName of ['SKILL.md', 'clean.md']) {
    fs.copyFileSync(path.join(SKILL_ROOT, fileName), path.join(paths.projectClaudeSkillDir, fileName))
  }
}

function cleanupLegacyClaudeArtifacts(paths) {
  const legacyTargets = [
    path.join(paths.projectClaudeDir, 'agents'),
    path.join(paths.projectClaudeDir, 'logs'),
    path.join(paths.projectClaudeDir, 'runs'),
    path.join(paths.projectClaudeDir, 'worktrees'),
    path.join(paths.projectClaudeDir, '4coop-active.json'),
    path.join(paths.projectClaudeDir, '4coop-pending-config.json'),
    path.join(paths.projectClaudeDir, 'monitor.port'),
    path.join(paths.projectClaudeDir, 'pipeline.lock'),
    path.join(paths.projectClaudeDir, 'pipeline-queue.json')
  ]

  for (const target of legacyTargets) {
    if (!pathExists(target)) {
      continue
    }
    fs.rmSync(target, {
      recursive: true,
      force: true
    })
  }
}

function ensureGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore')
  const current = pathExists(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
  if (current.includes(GITIGNORE_MARKER)) {
    const requiredEntries = GITIGNORE_BLOCK
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
    const currentLines = current.split(/\r?\n/)
    const missingEntries = requiredEntries.filter(entry => !currentLines.includes(entry))
    if (missingEntries.length === 0) {
      return
    }
    const separator = current.endsWith('\n') || current.length === 0 ? '' : '\n'
    fs.writeFileSync(gitignorePath, `${current}${separator}${missingEntries.join('\n')}\n`, 'utf8')
    return
  }

  const separator = current.endsWith('\n') || current.length === 0 ? '' : '\n'
  fs.writeFileSync(gitignorePath, `${current}${separator}${GITIGNORE_BLOCK}`, 'utf8')
}

function ensureProjectCommands(paths) {
  if (pathExists(paths.projectConfigPath)) {
    return
  }
  if (pathExists(paths.legacyProjectConfigPath)) {
    ensureDir(path.dirname(paths.projectConfigPath))
    try {
      fs.renameSync(paths.legacyProjectConfigPath, paths.projectConfigPath)
    } catch {
      fs.copyFileSync(paths.legacyProjectConfigPath, paths.projectConfigPath)
      fs.rmSync(paths.legacyProjectConfigPath, {
        force: true
      })
    }
    return
  }
  fs.writeFileSync(paths.projectConfigPath, `${JSON.stringify({ confirmed: false, build: '', test: '', lint: '' }, null, 2)}\n`, 'utf8')
}

function pruneLegacyProjectConfig(paths) {
  if (!pathExists(paths.projectConfigPath) || !pathExists(paths.legacyProjectConfigPath)) {
    return
  }

  const current = fs.readFileSync(paths.projectConfigPath, 'utf8').trim()
  const legacy = fs.readFileSync(paths.legacyProjectConfigPath, 'utf8').trim()
  if (current === legacy) {
    fs.rmSync(paths.legacyProjectConfigPath, {
      force: true
    })
  }
}

function ensureProjectSkillConfig(paths) {
  if (pathExists(paths.projectConfigOverridePath)) {
    return
  }
  ensureDir(path.dirname(paths.projectConfigOverridePath))
  fs.copyFileSync(path.join(SKILL_ROOT, 'config.json'), paths.projectConfigOverridePath)
}

function copySkillTree(projectRoot) {
  const paths = getRuntimePaths(projectRoot)
  if (path.resolve(paths.projectInstallDir) !== path.resolve(SKILL_ROOT)) {
    ensureDir(path.dirname(paths.projectInstallDir))
    fs.cpSync(SKILL_ROOT, paths.projectInstallDir, {
      recursive: true,
      force: true
    })
  }
}

export function isProjectScaffoldComplete(projectRoot) {
  const paths = getRuntimePaths(projectRoot)
  const requiredPaths = [
    path.join(paths.projectInstallDir, 'SKILL.md'),
    path.join(paths.projectInstallDir, 'scripts', '4coop-orchestrator.mjs'),
    path.join(paths.projectClaudeSkillDir, 'SKILL.md'),
    paths.projectConfigOverridePath,
    paths.projectConfigPath
  ]
  return requiredPaths.every(pathExists)
}

export function refreshAgentsFromConfig(projectRoot) {
  if (!isProjectScaffoldComplete(projectRoot)) {
    return false
  }
  const config = loadConfig(projectRoot)
  syncAgents(projectRoot, config)
  return true
}

export function scaffoldProject(projectRoot) {
  const paths = getRuntimePaths(projectRoot)
  ensureDir(paths.runtimeDir)
  ensureDir(paths.runtimeWorktreesDir)
  cleanupLegacyClaudeArtifacts(paths)
  cleanupManagedSettingsLocal(paths)
  copySkillTree(projectRoot)
  ensureProjectCommands(paths)
  pruneLegacyProjectConfig(paths)
  ensureProjectSkillConfig(paths)
  ensureHostSkillFiles(paths)
  ensureGitignore(projectRoot)
  const config = loadConfig(projectRoot)
  syncAgents(projectRoot, config)
  return {
    projectRoot,
    paths,
    created: true
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectRoot = process.cwd()
  scaffoldProject(projectRoot)
  console.log(JSON.stringify({ ok: true, projectRoot }, null, 2))
}
