import { withTag } from './4coop-tag-format.mjs'

export function needsScaffold(config) {
  return withTag(config, 'meta', 'necessary files are not in the project folder, do you want me to scaffold?')
}

export function plannerInProgress(config) {
  return withTag(config, 'meta', 'Planner is currently creating a plan, please hold on')
}

export function awaitingPrompt(config) {
  return withTag(config, 'meta', "What's in your mind?")
}

export function approvalPrompt(config) {
  return withTag(config, 'meta', 'Is this plan good or do you want to edit/cancel?')
}

export function nothingChanged(config) {
  return withTag(config, 'meta', 'okay, nothing changed.')
}

export function scaffolded(config) {
  return withTag(config, 'meta', 'Scaffolding completed.')
}

export function configHelp(config) {
  return withTag(
    config,
    'meta',
    [
      "I didn't understand that reply. Try one of these:",
      '  ok                        — use the proposed commands (empty ones get skipped)',
      '  skip                      — run with no build/test/lint steps at all',
      '  no tests                  — use proposed build/lint but skip tests',
      '  edit: build=npm run build test=npm test lint=npm run lint',
      '  cancel                    — abort this run'
    ].join('\n')
  )
}

export function queued(config, currentFeature, position) {
  return withTag(config, 'meta', `Queued behind ${currentFeature} (position ${position})`)
}

export function staleLockCleared(config, previousRunId) {
  return withTag(config, 'meta', `Cleared a stale lock from ${previousRunId}.`)
}

export function halted(config, reason) {
  return withTag(config, 'meta', `Run halted: ${reason}`)
}

export function branchList(config, branches, currentDefault) {
  if (!branches || branches.length === 0) {
    return withTag(config, 'meta', 'No branches found in this repository.')
  }
  const lines = branches.map(name => {
    const marker = name === currentDefault ? ' (default)' : ''
    return `  - ${name}${marker}`
  })
  lines.unshift('Available base branches:')
  lines.push('Use `/4co-op set-base <branch>` to change the default, or `/4co-op start --base <branch> <feature>` for a one-off.')
  return withTag(config, 'meta', lines.join('\n'))
}

export function baseBranchInvalid(config, attempted, branches) {
  const lines = [`Base branch "${attempted}" does not exist locally or on origin.`]
  if (branches && branches.length > 0) {
    lines.push('Available branches:')
    for (const name of branches) {
      lines.push(`  - ${name}`)
    }
  }
  return withTag(config, 'meta', lines.join('\n'))
}

export function baseBranchSet(config, branch) {
  return withTag(config, 'meta', `Default base branch set to "${branch}". Future runs will branch off of it unless --base is passed.`)
}

export function configProposal(config, proposal) {
  const build = proposal.proposed_build || ''
  const test = proposal.proposed_test || ''
  const lint = proposal.proposed_lint || ''
  const fmt = value => value ? value : '(skip)'
  const lines = [
    `[4CO-OP]: ${proposal.summary}`,
    '',
    "I use these three commands to check the Builder's work. Any of them can be empty — empty means I skip that step.",
    `  build = ${fmt(build)}     (how to compile/bundle; e.g. "npm run build")`,
    `  test  = ${fmt(test)}     (how to run tests; e.g. "npm test")`,
    `  lint  = ${fmt(lint)}     (how to check style; e.g. "npm run lint")`,
    '',
    'Reply one of:',
    '  ok                        — use the values above as-is',
    '  skip                      — run with nothing (no build, no test, no lint)',
    '  no tests                  — use proposed build/lint, skip tests',
    '  edit: build=... test=... lint=...   — override any of them',
    '  cancel                    — abort'
  ]
  return lines.join('\n')
}

const DEPENDENCY_INSTALL_HINTS = {
  git: 'Install git: https://git-scm.com/downloads (macOS: "brew install git", Ubuntu: "sudo apt install git")',
  gh: 'Install GitHub CLI: https://cli.github.com (macOS: "brew install gh", then "gh auth login")',
  claude: 'Install Claude Code: "npm install -g @anthropic-ai/claude-code" (see https://docs.claude.com/en/docs/claude-code)',
  codex: 'Install Codex CLI: https://github.com/openai/codex (macOS: "brew install codex" or "npm install -g @openai/codex")'
}

export function missingDependency(config, dependencyName) {
  const hint = DEPENDENCY_INSTALL_HINTS[dependencyName]
  const base = `"${dependencyName}" is required but I couldn't find it on your PATH.`
  const message = hint ? `${base}\n  ${hint}` : base
  return withTag(config, 'meta', message)
}

export function missingGitHubRepo(config) {
  return withTag(
    config,
    'meta',
    [
      "This project isn't connected to a GitHub repository yet — I need one to open PRs.",
      '  To create a new GitHub repo for this project:',
      '    gh repo create --source=. --private --push',
      '  If the repo already exists, wire it up with:',
      '    git remote add origin git@github.com:<you>/<repo>.git',
      '    git push -u origin HEAD',
      '  Then make sure "gh auth status" shows you as logged in.'
    ].join('\n')
  )
}

export function mergeReadyHint(config) {
  return withTag(
    config,
    'meta',
    'If you get new manual PR comments before merging, run "/4co-op check comment" and I will review them and continue.'
  )
}

export function noNewComments(config) {
  return withTag(config, 'meta', 'No new PR comments were found since the last check.')
}

export function noActionableComments(config) {
  return withTag(config, 'meta', 'I found new PR comments, but none of them were clearly actionable.')
}
