import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SKILL_ROOT,
  globalSkillRoots
} from './4coop-paths.mjs'
import { scaffoldProject } from './4coop-scaffolder.mjs'

function parseArgs(argv) {
  const args = {
    global: false,
    project: null,
    dryRun: false,
    update: false,
    host: 'both'
  }

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--global') {
      args.global = true
    } else if (current === '--project') {
      const targetPath = argv[index + 1]
      if (!targetPath || targetPath.startsWith('--')) {
        throw new Error(`Missing value for --project.\n\n${getUsageText()}`)
      }
      args.project = path.resolve(targetPath)
      index += 1
    } else if (current === '--dry-run') {
      args.dryRun = true
    } else if (current === '--update') {
      args.update = true
    } else if (current === '--host') {
      const hostValue = argv[index + 1]
      if (!hostValue || hostValue.startsWith('--')) {
        throw new Error(`Missing value for --host.\n\n${getUsageText()}`)
      }
      args.host = String(hostValue).trim().toLowerCase()
      index += 1
    }
  }

  if (!args.global && !args.project) {
    throw new Error(`Choose an install target.\n\n${getUsageText()}`)
  }

  return args
}

function getUsageText() {
  return [
    'Usage:',
    '  install.mjs --global [--host codex|claude|both] [--dry-run]',
    '  install.mjs --project <target-project-path> [--dry-run]',
    '  install.mjs --global --project <target-project-path> [--dry-run]',
    '',
    'This GitHub repo is source code, not a project-local install target by default.',
    'Use --project with an explicit target path when you want a per-project install.'
  ].join('\n')
}

function maybeLog(dryRun, message) {
  if (dryRun) {
    console.log(message)
  }
}

function resolveGlobalTargets(host) {
  if (!['both', 'codex', 'claude'].includes(host)) {
    throw new Error(`Unsupported --host value: ${host}`)
  }
  const allTargets = globalSkillRoots()
  if (host === 'both') {
    return allTargets
  }
  return allTargets.filter(target => target.host === host)
}

function copyGlobalInstall(dryRun, host) {
  const targets = resolveGlobalTargets(host)
  for (const target of targets) {
    maybeLog(dryRun, `Copy ${SKILL_ROOT} -> ${target.path}`)
  }

  if (dryRun) {
    return targets
  }

  for (const target of targets) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true })
    fs.cpSync(SKILL_ROOT, target.path, {
      recursive: true,
      force: true
    })
  }

  return targets
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.global) {
    copyGlobalInstall(args.dryRun, args.host)
  }
  if (args.project) {
    maybeLog(args.dryRun, `Scaffold project-local install in ${args.project}`)
    if (!args.dryRun) {
      scaffoldProject(args.project)
    }
  }

  console.log(JSON.stringify({
    ok: true,
    global: args.global,
    project: args.project,
    dryRun: args.dryRun,
    update: args.update,
    host: args.host
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
