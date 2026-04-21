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
    'Please reply "ok", "no tests", "edit: build=... test=... lint=...", or "cancel".'
  )
}

export function configRequirements(config, missingKeys) {
  const fields = missingKeys.length > 1
    ? `${missingKeys.slice(0, -1).join(', ')} and ${missingKeys.at(-1)}`
    : missingKeys[0]
  return withTag(
    config,
    'meta',
    `${fields} cannot be empty. Please reply "edit: build=... test=... lint=...", or "cancel".`
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

export function configProposal(config, proposal) {
  const lines = [
    `[4CO-OP]: ${proposal.summary}`,
    `  build = ${proposal.proposed_build || '(empty)'}`,
    `  test  = ${proposal.proposed_test || '(empty)'}`,
    `  lint  = ${proposal.proposed_lint || '(empty)'}`
  ]
  if (!proposal.proposed_build || !proposal.proposed_lint) {
    lines.push('Build and lint must be set before the pipeline can continue. Test may be empty if the project has no tests.')
  }
  lines.push(
    'Reply "ok", or "no tests", or "edit: build=... test=... lint=...", or "cancel".'
  )
  return lines.join('\n')
}

export function missingDependency(config, dependencyName) {
  return withTag(config, 'meta', `${dependencyName} is required before this pipeline can continue.`)
}

export function missingGitHubRepo(config) {
  return withTag(
    config,
    'meta',
    'This project is not connected to a GitHub repository yet. Connect the repo and make sure gh can view it, then try again.'
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
