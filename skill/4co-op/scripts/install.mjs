import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  SKILL_ROOT,
  globalSkillRoots
} from './4coop-paths.mjs'
import { scaffoldProject } from './4coop-scaffolder.mjs'

const CLI_CHECKS = [
  { name: 'git', hint: 'macOS: "brew install git" · Ubuntu: "sudo apt install git" · https://git-scm.com/downloads' },
  { name: 'gh', hint: 'macOS: "brew install gh" · https://cli.github.com · then run "gh auth login"' },
  { name: 'claude', hint: '"npm install -g @anthropic-ai/claude-code" · https://docs.claude.com/en/docs/claude-code' },
  { name: 'codex', hint: '"npm install -g @openai/codex" or "brew install codex" · https://github.com/openai/codex' }
]

function parseArgs(argv) {
  const args = {
    global: false,
    project: null,
    dryRun: false,
    update: false,
    host: 'both',
    help: false
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
    } else if (current === '--help' || current === '-h') {
      args.help = true
    }
  }

  if (!args.global && !args.project) {
    args.global = true
  }

  return args
}

function getUsageText() {
  return [
    '4CO-OP installer',
    '',
    'Usage:',
    '  install.mjs                                    (default: install globally for Claude + Codex)',
    '  install.mjs --global [--host codex|claude|both]',
    '  install.mjs --project <path-to-project>',
    '  install.mjs --global --project <path-to-project>',
    '  install.mjs --dry-run                          (preview actions without writing files)',
    '',
    'After install, type "/4co-op" inside Claude Code in any project to use it.'
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

function commandExists(command) {
  if (process.platform === 'win32') {
    const probe = spawnSync('where', [command], { encoding: 'utf8' })
    return !probe.error && probe.status === 0
  }
  const probe = spawnSync('sh', ['-lc', `command -v '${command.replace(/'/g, `'\\''`)}' >/dev/null 2>&1`], {
    encoding: 'utf8'
  })
  return !probe.error && probe.status === 0
}

function checkPrerequisites() {
  const results = CLI_CHECKS.map(check => ({
    ...check,
    found: commandExists(check.name)
  }))
  return results
}

function printSummary({ args, globalTargets, checks }) {
  const lines = ['', '[4CO-OP]: install finished', '']
  if (args.global) {
    lines.push('  global install:')
    for (const target of globalTargets) {
      lines.push(`    - ${target.host}: ${target.path}`)
    }
  }
  if (args.project) {
    lines.push(`  project install: ${args.project}`)
  }
  lines.push('')
  lines.push('  prerequisites:')
  for (const check of checks) {
    const marker = check.found ? '[OK]    ' : '[MISSING]'
    lines.push(`    ${marker} ${check.name}`)
    if (!check.found) {
      lines.push(`             ${check.hint}`)
    }
  }
  const missing = checks.filter(check => !check.found)
  lines.push('')
  if (missing.length === 0) {
    lines.push('  next: open any project in Claude Code and type "/4co-op"')
  } else {
    lines.push('  next: install the missing tools above, then type "/4co-op" in Claude Code')
  }
  lines.push('')
  console.log(lines.join('\n'))
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(getUsageText())
    return
  }

  let globalTargets = []
  if (args.global) {
    globalTargets = copyGlobalInstall(args.dryRun, args.host)
  }
  if (args.project) {
    maybeLog(args.dryRun, `Scaffold project-local install in ${args.project}`)
    if (!args.dryRun) {
      scaffoldProject(args.project)
    }
  }

  const checks = args.dryRun ? [] : checkPrerequisites()
  if (!args.dryRun) {
    printSummary({ args, globalTargets, checks })
  } else {
    console.log(JSON.stringify({
      ok: true,
      global: args.global,
      project: args.project,
      dryRun: args.dryRun,
      update: args.update,
      host: args.host
    }, null, 2))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
