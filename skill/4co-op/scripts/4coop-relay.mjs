import path from 'node:path'
import { ensureDir } from './4coop-paths.mjs'
import { writeFileAtomic } from './4coop-atomic.mjs'

export function createPlannerRelayPrompt(featureRequest) {
  return [
    'Use the user request below exactly as written.',
    'Create the plan and write only the JSON output the orchestrator expects.',
    '',
    'User request:',
    String(featureRequest ?? '')
  ].join('\n')
}

export function createStageRelayPrompt({ targetStage, planFile, reviewFile = null, projectRoot }) {
  const shared = `Follow the plan provided at ${planFile}.`

  switch (targetStage) {
    case 'builder': {
      const projectConfig = path.join(projectRoot, '.4co-op', 'project.config.json')
      return `${shared} Use build, test, and lint commands from ${projectConfig}.`
    }
    case 'spec_checker':
      return `${shared} Evaluate every acceptance criterion and return only the structured result.`
    case 'escalation':
      return `${shared} Resolve only the UNCLEAR checklist items.`
    case 'reviewer':
      return `${shared} Review the PR diff captured at ${reviewFile}.`
    case 'fixer':
      return `${shared} Address only the PR review issues written at ${reviewFile}.`
    case 'gatekeeper':
      return `${shared} Use ${reviewFile} and the PR diff to return the final verdict.`
    default:
      return shared
  }
}

export function writeRelayFile(paths, name, prompt) {
  ensureDir(paths.relayDir)
  const filePath = path.join(paths.relayDir, name)
  writeFileAtomic(filePath, `${prompt.trim()}\n`)
  return filePath
}
