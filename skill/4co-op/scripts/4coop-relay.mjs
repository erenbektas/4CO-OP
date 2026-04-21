import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, relativeProjectPath } from './4coop-paths.mjs'

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
  const relativePlan = relativeProjectPath(projectRoot, planFile)
  const shared = `Follow the plan provided in ${relativePlan}.`

  switch (targetStage) {
    case 'builder':
      return `${shared} Use build, test, and lint commands from .4co-op/project.config.json.`
    case 'spec_checker':
      return `${shared} Evaluate every acceptance criterion and return only the structured result.`
    case 'escalation':
      return `${shared} Resolve only the UNCLEAR checklist items.`
    case 'reviewer': {
      const relativeReview = reviewFile ? relativeProjectPath(projectRoot, reviewFile) : null
      return `${shared} Review the PR diff captured in ${relativeReview}.`
    }
    case 'fixer': {
      const relativeReview = reviewFile ? relativeProjectPath(projectRoot, reviewFile) : null
      return `${shared} Address only the PR review issues written in ${relativeReview}.`
    }
    case 'gatekeeper': {
      const relativeReview = reviewFile ? relativeProjectPath(projectRoot, reviewFile) : null
      return `${shared} Use ${relativeReview} and the PR diff to return the final verdict.`
    }
    default:
      return shared
  }
}

export function writeRelayFile(paths, name, prompt) {
  ensureDir(paths.relayDir)
  const filePath = path.join(paths.relayDir, name)
  fs.writeFileSync(filePath, `${prompt.trim()}\n`, 'utf8')
  return filePath
}
