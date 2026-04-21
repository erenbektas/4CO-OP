import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  buildRunId,
  ensureRuntimeDirs,
  ensureDir,
  findProjectRoot,
  getRuntimePaths,
  pathExists,
  readJsonIfExists,
  relativeProjectPath,
  resolveBundledPath,
  writeJson
} from './4coop-paths.mjs'
import {
  approvalPrompt,
  awaitingPrompt,
  configHelp,
  configRequirements,
  configProposal,
  halted,
  mergeReadyHint,
  missingDependency,
  missingGitHubRepo,
  needsScaffold,
  noActionableComments,
  noNewComments,
  nothingChanged,
  plannerInProgress,
  queued,
  scaffolded,
  staleLockCleared
} from './4coop-canned.mjs'
import {
  loadConfig,
  loadProjectCommands,
  projectCommandsReady,
  proposeProjectCommands,
  validateProjectCommands
} from './4coop-config.mjs'
import {
  acquireLock,
  enqueue,
  lockIsFresh,
  readLock,
  releaseLock,
  shiftQueue
} from './4coop-lock.mjs'
import {
  beginStageCall,
  createMonitorState,
  finishStageCall,
  interruptStageCall,
  serializeMonitorState,
  summarizeMonitorForLog
} from './4coop-metrics.mjs'
import { createLogger } from './4coop-logger.mjs'
import { ensureMonitor, postMonitorState, shutdownMonitor } from './4coop-monitor-spawn.mjs'
import { createPlannerRelayPrompt, createStageRelayPrompt, writeRelayFile } from './4coop-relay.mjs'
import {
  clearActiveSession,
  createInitialRunState,
  loadActiveSession,
  saveActiveSession,
  saveRunState
} from './4coop-state.mjs'
import { ensureWorktree, removeWorktree } from './4coop-worktree.mjs'
import { ensureTagged, stripLeadingTag, withTag } from './4coop-tag-format.mjs'
import { runClaudeStage } from './4coop-stage-claude.mjs'
import { runCodexExec, runCodexResume } from './4coop-stage-codex.mjs'
import { isProjectScaffoldComplete, refreshAgentsFromConfig, scaffoldProject } from './4coop-scaffolder.mjs'

const READ_ONLY_STAGES = new Set(['planner', 'spec_checker', 'escalation', 'reviewer', 'gatekeeper', 'narrator'])
const STAGE_SCHEMA_FILES = {
  planner: 'planner-result.json',
  builder: 'builder-result.json',
  spec_checker: 'spec-check-result.json',
  escalation: 'escalation-result.json',
  reviewer: 'reviewer-result.json',
  fixer: 'fixer-result.json',
  gatekeeper: 'gatekeeper-verdict.json',
  narrator: 'narrator-result.json'
}
const SETUP_MANIFEST_FILES = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'Makefile',
  'Gemfile',
  'Rakefile',
  'composer.json'
]

function parseArgs(argv) {
  const [command = 'start', ...rest] = argv
  const parsed = {
    command,
    feature: '',
    answer: '',
    flags: []
  }

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]
    if (current === '--feature' || current === '--answer') {
      const target = current === '--feature' ? 'feature' : 'answer'
      const values = []
      for (let inner = index + 1; inner < rest.length; inner += 1) {
        if (rest[inner].startsWith('--')) {
          break
        }
        values.push(rest[inner])
        index = inner
      }
      parsed[target] = values.join(' ').trim()
    } else if (current === '--') {
      parsed.flags.push(...rest.slice(index + 1))
      break
    } else {
      parsed.flags.push(current)
    }
  }

  if (!parsed.feature && parsed.command === 'start') {
    parsed.feature = parsed.flags.join(' ').trim()
    parsed.flags = []
  }

  const checkAlias = parsed.flags.join(' ').trim().toLowerCase()
  if (
    parsed.command === 'check-comment' ||
    parsed.command === 'check-comments' ||
    (parsed.command === 'check' && (checkAlias === 'comment' || checkAlias === 'comments'))
  ) {
    parsed.command = 'check-comment'
    parsed.flags = []
  }

  return parsed
}

function printResult(status, messages, extra = {}) {
  console.log(JSON.stringify({
    status,
    messages,
    ...extra
  }, null, 2))
}

function runCommand(command, args, { cwd, input = null } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(' ')} failed`)
  }

  return result.stdout.trim()
}

function commandExists(command) {
  const direct = spawnSync(command, ['--version'], {
    encoding: 'utf8'
  })
  if (!direct.error && direct.status === 0) {
    return true
  }

  if (process.platform === 'win32') {
    const escaped = String(command).replace(/'/g, "''")
    const powershellProbe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-Command '${escaped}' -ErrorAction Stop | Out-Null`
    ], {
      encoding: 'utf8'
    })
    return !powershellProbe.error && powershellProbe.status === 0
  }

  const escaped = String(command).replace(/'/g, `'\\''`)
  const shellProbe = spawnSync('sh', [
    '-lc',
    `command -v '${escaped}' >/dev/null 2>&1`
  ], {
    encoding: 'utf8'
  })
  return !shellProbe.error && shellProbe.status === 0
}

function missingDependencies(config) {
  const commands = new Set(['git', 'gh'])
  for (const stageConfig of Object.values(config.models)) {
    commands.add(stageConfig.cli)
  }
  return [...commands].filter(command => !commandExists(command))
}

function parseGitHubRepoFromRemote(remoteUrl) {
  const normalized = String(remoteUrl ?? '').trim()
  const match = normalized.match(/github\.com[:/](.+?)(?:\.git)?$/i)
  if (!match) {
    return null
  }
  const parts = match[1]
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 2) {
    return null
  }
  return `${parts[0]}/${parts[1]}`
}

function resolveGitHubContext(projectRoot) {
  let remoteUrl
  try {
    remoteUrl = runCommand('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot })
  } catch {
    return null
  }

  const repo = parseGitHubRepoFromRemote(remoteUrl)
  if (!repo) {
    return null
  }

  try {
    const viewed = JSON.parse(runCommand('gh', [
      'repo',
      'view',
      repo,
      '--json',
      'nameWithOwner,url'
    ], { cwd: projectRoot }))

    return {
      repo: viewed.nameWithOwner,
      url: viewed.url
    }
  } catch {
    return null
  }
}

function ensureGitHubContextForState(projectRoot, state) {
  if (state?.github?.repo) {
    return state.github
  }

  const resolved = resolveGitHubContext(projectRoot)
  if (!resolved) {
    throw new Error('project is not connected to a GitHub repository')
  }

  state.github = resolved
  return resolved
}

function requireGitHubRepo(state) {
  const repo = state?.github?.repo
  if (!repo) {
    throw new Error('GitHub repository context is missing from the run state')
  }
  return repo
}

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function isHumanAuthor(author) {
  const login = String(author?.login ?? '').trim()
  if (!login) {
    return false
  }
  if (author?.isBot === true) {
    return false
  }
  return !/\[bot\]$/i.test(login)
}

function collectNewConversationItems(prView, reviewComments, sinceIso) {
  const sinceMs = parseTimestampMs(sinceIso)
  const items = []

  for (const comment of prView.comments ?? []) {
    const body = String(comment.body ?? '').trim()
    const timestamp = comment.updatedAt ?? comment.createdAt
    if (!body || !isHumanAuthor(comment.author) || parseTimestampMs(timestamp) <= sinceMs) {
      continue
    }
    items.push({
      kind: 'comment',
      author: comment.author.login,
      timestamp,
      body
    })
  }

  for (const review of prView.reviews ?? []) {
    const body = String(review.body ?? '').trim()
    const timestamp = review.submittedAt ?? review.updatedAt ?? review.createdAt
    if (!body || !isHumanAuthor(review.author) || parseTimestampMs(timestamp) <= sinceMs) {
      continue
    }
    items.push({
      kind: 'review',
      author: review.author.login,
      timestamp,
      state: review.state ?? null,
      body
    })
  }

  for (const reviewComment of reviewComments ?? []) {
    const author = String(reviewComment.user?.login ?? '').trim()
    const body = String(reviewComment.body ?? '').trim()
    const timestamp = reviewComment.updated_at ?? reviewComment.created_at
    if (!author || /\[bot\]$/i.test(author) || !body || parseTimestampMs(timestamp) <= sinceMs) {
      continue
    }
    const line = Number.isFinite(reviewComment.line)
      ? reviewComment.line
      : (Number.isFinite(reviewComment.original_line) ? reviewComment.original_line : null)
    items.push({
      kind: 'review_comment',
      author,
      timestamp,
      path: reviewComment.path ?? null,
      line,
      body
    })
  }

  return items.sort((left, right) => parseTimestampMs(left.timestamp) - parseTimestampMs(right.timestamp))
}

function formatManualCommentMarkdown(prView, items) {
  const sections = [
    '# Manual PR comments',
    '',
    `PR: #${prView.number} ${prView.title}`,
    `URL: ${prView.url}`,
    `State: ${prView.state}`,
    ''
  ]

  items.forEach((item, index) => {
    sections.push(`## Item ${index + 1} (${item.kind})`)
    sections.push(`Author: ${item.author}`)
    sections.push(`At: ${item.timestamp}`)
    if (item.state) {
      sections.push(`Review state: ${item.state}`)
    }
    if (item.path) {
      sections.push(`File: ${item.path}${item.line ? `:${item.line}` : ''}`)
    }
    sections.push('')
    sections.push(item.body)
    sections.push('')
  })

  return sections.join('\n').trim()
}

function buildManualCommentReviewerPrompt(config, planPath, reviewInputPath, commentFilePath) {
  const tag = config.tags.reviewer.replace('{tag_display}', config.models.reviewer.tag_display)
  return [
    'You are the 4CO-OP PR Reviewer.',
    'Read the approved plan, the latest PR diff, and the new human-written PR comments.',
    'Convert only clearly actionable comments into structured issues.',
    'Ignore praise, duplicate notes, resolved notes, and comments that do not require code changes.',
    'Return only JSON with keys issues, tagged_message, body_markdown.',
    `tagged_message must start exactly with "${tag}:"`,
    `Plan file: ${planPath}`,
    `PR diff file: ${reviewInputPath}`,
    `Manual comment file: ${commentFilePath}`
  ].join('\n')
}

function findLatestRunWithPr(projectRoot) {
  const basePaths = getRuntimePaths(projectRoot)
  if (!pathExists(basePaths.runtimeRunsDir)) {
    return null
  }

  const candidates = fs.readdirSync(basePaths.runtimeRunsDir)
    .map(name => {
      const paths = getRuntimePaths(projectRoot, name)
      const state = readJsonIfExists(paths.stateFile)
      return state?.pr?.number ? { paths, state } : null
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Math.max(
        parseTimestampMs(left.state.pr?.last_comment_check_at),
        parseTimestampMs(left.state.created_at)
      )
      const rightTime = Math.max(
        parseTimestampMs(right.state.pr?.last_comment_check_at),
        parseTimestampMs(right.state.created_at)
      )
      return rightTime - leftTime
    })

  return candidates.find(candidate => candidate.state.gatekeeper?.verdict === 'APPROVE')
    ?? candidates[0]
    ?? null
}

function fetchPullRequestConversation(state, worktreePath) {
  const repo = requireGitHubRepo(state)
  const prNumber = String(state.pr.number)
  const prView = JSON.parse(runCommand('gh', [
    'pr',
    'view',
    prNumber,
    '--repo',
    repo,
    '--json',
    'number,url,title,state,updatedAt,comments,reviews,headRefName,baseRefName'
  ], { cwd: worktreePath }))
  const reviewComments = JSON.parse(runCommand('gh', [
    'api',
    `repos/${repo}/pulls/${prNumber}/comments?per_page=100`
  ], { cwd: worktreePath }) || '[]')

  return {
    prView,
    reviewComments
  }
}

function collectSetupManifestEntries(projectRoot) {
  return SETUP_MANIFEST_FILES
    .map(fileName => path.join(projectRoot, fileName))
    .filter(pathExists)
    .map(filePath => {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(0, 100).join('\n')
      return {
        relative_path: relativeProjectPath(projectRoot, filePath),
        snippet: lines
      }
    })
}

function buildSetupAssistantPrompt(config, manifestEntries) {
  const manifestBlock = manifestEntries.length > 0
    ? manifestEntries.map(entry => {
      return [
        `File: ${entry.relative_path}`,
        '```text',
        entry.snippet,
        '```'
      ].join('\n')
    }).join('\n\n')
    : 'No recognized manifest files were provided.'

  return [
    'You are the 4CO-OP narrator in setup-assistant mode.',
    `Return only JSON with tagged_message starting exactly with "${config.tags.meta}:".`,
    'Inspect only the manifest snippets provided below.',
    'Pick sensible build, test, and lint commands for this project.',
    'Prefer commands that are explicitly present in the manifests.',
    'If the project does not appear to have tests yet, proposed_test may be an empty string.',
    'Return keys: tagged_message, detected_stack, proposed_build, proposed_test, proposed_lint, confidence, summary.',
    '',
    manifestBlock
  ].join('\n')
}

async function runSetupAssistant(projectRoot, config) {
  const manifestEntries = collectSetupManifestEntries(projectRoot)
  const fallback = proposeProjectCommands(projectRoot)

  try {
    const result = await runClaudeStage({
      cli: config.models.narrator.cli,
      stage: 'narrator',
      model: config.models.narrator.model,
      prompt: buildSetupAssistantPrompt(config, manifestEntries),
      cwd: projectRoot,
      timeoutMs: 5 * 60 * 1000
    })

    const structured = result.structured
    return {
      summary: structured.summary ?? stripLeadingTag(structured.tagged_message) ?? fallback.summary,
      detected_stack: structured.detected_stack ?? fallback.detected_stack,
      proposed_build: structured.proposed_build ?? fallback.proposed_build,
      proposed_test: structured.proposed_test ?? fallback.proposed_test,
      proposed_lint: structured.proposed_lint ?? fallback.proposed_lint,
      confidence: structured.confidence ?? fallback.confidence,
      tagged_message: structured.tagged_message
    }
  } catch {
    return {
      ...fallback,
      tagged_message: withTag(config, 'meta', fallback.summary)
    }
  }
}

function writeProjectCommands(paths, commands) {
  writeJson(paths.projectConfigPath, {
    confirmed: true,
    build: commands.build ?? '',
    test: commands.test ?? '',
    lint: commands.lint ?? ''
  })
}

function parseConfigAnswer(answer, proposal) {
  const trimmed = String(answer ?? '').trim()
  if (!trimmed) {
    return { action: 'invalid' }
  }
  if (/^cancel\b/i.test(trimmed)) {
    return { action: 'cancel' }
  }
  if (/^(ok|yes|use these)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: {
        build: proposal.proposed_build ?? '',
        test: proposal.proposed_test ?? '',
        lint: proposal.proposed_lint ?? ''
      }
    }
  }
  if (/^(no tests|skip tests)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: {
        build: proposal.proposed_build ?? '',
        test: '',
        lint: proposal.proposed_lint ?? ''
      }
    }
  }
  if (/^edit:/i.test(trimmed)) {
    const body = trimmed.replace(/^edit:\s*/i, '')
    const commands = {
      build: proposal.proposed_build ?? '',
      test: proposal.proposed_test ?? '',
      lint: proposal.proposed_lint ?? ''
    }
    const regex = /(build|test|lint)\s*=\s*(.+?)(?=\s+(?:build|test|lint)\s*=|$)/gi
    let match
    while ((match = regex.exec(body)) !== null) {
      commands[match[1].toLowerCase()] = match[2].trim()
    }
    return { action: 'accept', commands }
  }
  return { action: 'invalid' }
}

function summarizePlanFallback(config, planMarkdown, planPath) {
  const summary = String(planMarkdown ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ')
  const planReference = path.isAbsolute(planPath)
    ? toMarkdownFileLink(planPath, 'full plan')
    : String(planPath ?? '').trim() || 'full plan'
  return withTag(config, 'planner', `${summary || 'Plan ready.'} Full plan: ${planReference}`)
}

function toMarkdownFileLink(absolutePath, label) {
  const normalized = String(absolutePath ?? '').replace(/\\/g, '/')
  if (!normalized) {
    return label
  }
  return `[${label}](/${normalized})`
}

function finalizePlannerSummaryMessage(config, structured, planPathAbsolute, fallbackPlanPath) {
  const plannerTag = config.tags.planner.replace('{tag_display}', config.models.planner.tag_display)
  const summary = Array.isArray(structured?.summary_sentences)
    ? structured.summary_sentences.filter(Boolean).slice(0, 5).join(' ')
    : ''
  const messageBody = summary || stripLeadingTag(structured?.tagged_message) || 'Plan ready.'
  const planReference = planPathAbsolute ? toMarkdownFileLink(planPathAbsolute, 'full plan') : fallbackPlanPath
  return `${plannerTag}: ${messageBody} Full plan: ${planReference}`
}

function buildPlannerRetryPrompt(config, featureRequest, previousOutput = '') {
  const basePrompt = buildPlannerPrompt(config, featureRequest)
  const instructions = [
    '',
    'Your previous reply did not match the required JSON shape.',
    'Retry now and return exactly one JSON object.',
    'Do not include markdown fences or any prose before or after the JSON.',
    'Make sure tagged_message, plan_markdown, acceptance_checklist, file_structure_hint, and definition_of_done are all present.'
  ]
  if (previousOutput.trim()) {
    instructions.push('', 'Previous invalid reply:', previousOutput.trim())
  }
  return `${basePrompt}${instructions.join('\n')}`
}

function isStageSchemaError(error, stage) {
  return error?.name === 'StageSchemaError' && error?.stage === stage
}

function fallbackStatusMessage(config, stage, payload = {}) {
  switch (stage) {
    case 'builder':
      if (payload.phase === 'starting') {
        return withTag(config, 'builder', `Building on ${payload.branch}.`)
      }
      return withTag(
        config,
        'builder',
        `Commit ${String(payload.commit_sha ?? '').slice(0, 7)} landed. build=${payload.build}, tests=${payload.tests}, lint=${payload.lint}.`
      )
    case 'spec_checker':
      return withTag(config, 'spec_checker', `${payload.pass_count} PASS, ${payload.fail_count} FAIL, ${payload.unclear_count} UNCLEAR.`)
    case 'escalation':
      return withTag(config, 'escalation', `${payload.resolved_count} unclear items resolved.`)
    case 'reviewer':
      return withTag(config, 'reviewer', `${payload.issue_count} issues found.${payload.pr_url ? ` ${payload.pr_url}` : ''}`)
    case 'fixer':
      return withTag(config, 'fixer', `Fixes applied in ${payload.commit_count} commits.`)
    case 'gatekeeper':
      return withTag(config, 'gatekeeper', `${payload.verdict} with severity ${payload.severity}.${payload.pr_url ? ` ${payload.pr_url}` : ''}`)
    default:
      return withTag(config, 'meta', payload.message ?? 'Status updated.')
  }
}

function buildNarratorPrompt(config, mode, targetStage, payload) {
  const tag = targetStage === 'meta' ? config.tags.meta : config.tags[targetStage].replace('{tag_display}', config.models[targetStage].tag_display)
  if (mode === 'relay') {
    return [
      'You are the 4CO-OP narrator relay.',
      'Do not paraphrase any requirements or file contents.',
      'Return only JSON:',
      '{"tagged_message":"[4CO-OP]: relay ready","relay_prompt":"Follow the plan provided in .4co-op/runs/<id>/plan.md."}',
      '',
      `Preferred relay prompt: ${payload.preferred_prompt}`
    ].join('\n')
  }

  if (mode === 'planner-summary') {
    return [
      'You are the 4CO-OP narrator.',
      `Return only JSON with tagged_message starting exactly with "${tag}:".`,
      'Also include summary_sentences as an array of at most 5 items.',
      `Plan path: ${payload.plan_path}`,
      '',
      'Plan markdown:',
      payload.plan_markdown
    ].join('\n')
  }

  return [
    'You are the 4CO-OP narrator.',
    `Return only JSON with tagged_message starting exactly with "${tag}:".`,
    'Keep the message short and plain.',
    '',
    `Stage payload: ${JSON.stringify(payload, null, 2)}`
  ].join('\n')
}

async function syncMonitor(paths, state, monitorState, monitorPort) {
  if (state) {
    state.metrics = monitorState
    state.monitor_port = monitorPort
    saveRunState(paths, state)
  }
  if (monitorPort) {
    await postMonitorState(monitorPort, serializeMonitorState(monitorState))
  }
}

function snapshot(logger, monitorState) {
  logger.write('table_snapshot', {
    snapshot: summarizeMonitorForLog(monitorState)
  })
}

function nextArtifactBase(paths, stage, monitorState) {
  const nextCall = (monitorState.rows[stage]?.calls ?? 0) + 1
  return path.join(paths.runDir, `${stage}-${String(nextCall).padStart(2, '0')}`)
}

async function runTrackedStage({
  stage,
  config,
  prompt,
  cwd,
  paths,
  state,
  logger,
  monitorState,
  monitorPort,
  timeoutMs = 20 * 60 * 1000,
  sessionId = null
}) {
  const stageConfig = config.models[stage]
  const startedAt = new Date().toISOString()
  const artifactBase = nextArtifactBase(paths, stage, monitorState)
  const outputFile = `${artifactBase}-last-message.txt`
  const rawOutputPath = `${artifactBase}.ndjson`
  const schemaPath = resolveBundledPath('schemas', STAGE_SCHEMA_FILES[stage])

  beginStageCall(monitorState, stage, {
    started_at: startedAt,
    input: prompt,
    input_tokens: Math.max(1, Math.ceil(prompt.length / 4))
  })
  await syncMonitor(paths, state, monitorState, monitorPort)
  snapshot(logger, monitorState)

  const started = Date.now()
  try {
    let result
    if (stageConfig.cli === 'claude') {
      result = await runClaudeStage({
        cli: stageConfig.cli,
        stage,
        model: stageConfig.model,
        prompt,
        cwd,
        timeoutMs
      })
    } else if (sessionId) {
      result = await runCodexResume({
        stage,
        sessionId,
        model: stageConfig.model,
        prompt,
        cwd,
        outputFile,
        rawOutputPath,
        timeoutMs
      })
    } else {
      result = await runCodexExec({
        stage,
        model: stageConfig.model,
        prompt,
        cwd,
        schemaPath,
        outputFile,
        rawOutputPath,
        sandboxMode: READ_ONLY_STAGES.has(stage) ? 'read-only' : 'workspace-write',
        timeoutMs
      })
    }

    const durationMs = Date.now() - started
    finishStageCall(monitorState, stage, {
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      input: prompt,
      output: result.outputText,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      duration_ms: durationMs,
      exact_tokens: result.usage.exact
    })
    logger.write('stage_call', {
      stage,
      call_number: monitorState.rows[stage].calls,
      duration_ms: durationMs,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      exit_code: result.exitCode,
      exact_tokens: result.usage.exact
    })
    await syncMonitor(paths, state, monitorState, monitorPort)
    snapshot(logger, monitorState)
    return result
  } catch (error) {
    interruptStageCall(monitorState, stage, {
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      input: prompt
    })
    logger.write('interruption', {
      stage,
      reason_code: 'error'
    })
    await syncMonitor(paths, state, monitorState, monitorPort)
    snapshot(logger, monitorState)
    throw error
  }
}

async function runNarrator({
  mode,
  targetStage,
  payload,
  config,
  paths,
  state,
  logger,
  monitorState,
  monitorPort
}) {
  const prompt = buildNarratorPrompt(config, mode, targetStage, payload)
  try {
    const result = await runTrackedStage({
      stage: 'narrator',
      config,
      prompt,
      cwd: state?.worktree?.path ?? paths.projectRoot,
      paths,
      state,
      logger,
      monitorState,
      monitorPort,
      timeoutMs: 5 * 60 * 1000
    })
    if (mode === 'relay') {
      return result.structured.relay_prompt || payload.preferred_prompt
    }
    if (mode === 'planner-summary') {
      return finalizePlannerSummaryMessage(config, result.structured, payload.plan_absolute_path, payload.plan_path)
    }
    return ensureTagged(config, targetStage, result.structured.tagged_message)
  } catch {
    if (mode === 'relay') {
      return payload.preferred_prompt
    }
    if (mode === 'planner-summary') {
      return summarizePlanFallback(
        config,
        payload.plan_markdown,
        payload.plan_absolute_path ?? payload.plan_path
      )
    }
    return fallbackStatusMessage(config, targetStage, payload)
  }
}

function buildPlannerPrompt(config, featureRequest) {
  const plannerTag = config.tags.planner.replace('{tag_display}', config.models.planner.tag_display)
  return [
    'You are the 4CO-OP Planner.',
    'Inspect the repository and produce a concrete implementation plan.',
    'Return exactly one JSON object and nothing else.',
    'Do not use markdown fences.',
    'Return only JSON with these keys:',
    '{"tagged_message":"","plan_markdown":"","acceptance_checklist":[{"id":"AC-001","text":"","status":"pending"}],"file_structure_hint":[""],"definition_of_done":""}',
    `tagged_message must start exactly with "${plannerTag}:"`,
    '',
    'User request:',
    featureRequest
  ].join('\n')
}

function buildSpecPrompt(config, planPath) {
  const tag = config.tags.spec_checker.replace('{tag_display}', config.models.spec_checker.tag_display)
  return [
    'You are the 4CO-OP Spec Checker.',
    'Read the plan file and the implemented worktree.',
    'Return only JSON with keys results, summary, tagged_message.',
    `tagged_message must start exactly with "${tag}:"`,
    'Each result item must have id, status, evidence_file, evidence_line, quote.',
    `Plan file: ${planPath}`
  ].join('\n')
}

function buildEscalationPrompt(config, planPath, unresolvedJsonPath) {
  const tag = config.tags.escalation.replace('{tag_display}', config.models.escalation.tag_display)
  return [
    'You are the 4CO-OP Escalation stage.',
    'Resolve only the UNCLEAR checklist items to PASS or FAIL.',
    'Return only JSON with keys resolved and tagged_message.',
    `tagged_message must start exactly with "${tag}:"`,
    `Plan file: ${planPath}`,
    `UNCLEAR input file: ${unresolvedJsonPath}`
  ].join('\n')
}

function buildReviewerPrompt(config, planPath, reviewInputPath) {
  const tag = config.tags.reviewer.replace('{tag_display}', config.models.reviewer.tag_display)
  return [
    'You are the 4CO-OP PR Reviewer.',
    'Read the diff and the approved plan.',
    'Return only JSON with keys issues, tagged_message, body_markdown.',
    `tagged_message must start exactly with "${tag}:"`,
    `Plan file: ${planPath}`,
    `PR diff file: ${reviewInputPath}`
  ].join('\n')
}

function buildGatekeeperPrompt(config, planPath, reviewInputPath, issuesPath) {
  return [
    'You are the 4CO-OP Gatekeeper.',
    'Use the approved plan, the current PR diff, and the latest issue list.',
    'Return only the schema-compliant verdict JSON.',
    `Plan file: ${planPath}`,
    `PR diff file: ${reviewInputPath}`,
    `Issues file: ${issuesPath}`
  ].join('\n')
}

function buildFixerIssuesMarkdown(title, issues) {
  return [
    `# ${title}`,
    '',
    ...issues.map((issue, index) => `${index + 1}. ${issue}`)
  ].join('\n')
}

function createPrBody(state) {
  const lines = [
    '# 4CO-OP Run',
    '',
    `Feature: ${state.feature_request}`,
    '',
    '## Acceptance checklist',
    ...state.plan.acceptance_checklist.map(item => `- [ ] ${item.id} ${item.text}`),
    '',
    `Build: ${state.builder.build}`,
    `Tests: ${state.builder.tests}`,
    `Lint: ${state.builder.lint}`
  ]

  if (!String(state.builder.tests ?? '').trim() || /\b(skip(?:ped)?|no tests|not run)\b/i.test(String(state.builder.tests ?? ''))) {
    lines.push('')
    lines.push('⚠️ tests skipped')
  }

  return lines.join('\n')
}

function ensurePullRequest(paths, state) {
  const repo = requireGitHubRepo(state)
  const existing = JSON.parse(runCommand('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    state.worktree.branch,
    '--json',
    'number,url',
    '--limit',
    '1'
  ], { cwd: state.worktree.path }) || '[]')

  if (existing[0]) {
    return {
      number: existing[0].number,
      url: existing[0].url
    }
  }

  const prBodyPath = path.join(paths.runDir, 'pr-body.md')
  fs.writeFileSync(prBodyPath, `${createPrBody(state)}\n`, 'utf8')
  runCommand('git', ['push', '-u', 'origin', state.worktree.branch], {
    cwd: state.worktree.path
  })
  const prUrl = runCommand('gh', [
    'pr',
    'create',
    '--repo',
    repo,
    '--base',
    state.worktree.base,
    '--head',
    state.worktree.branch,
    '--title',
    `4CO-OP: ${state.feature_request}`,
    '--body-file',
    prBodyPath
  ], { cwd: state.worktree.path })
  const viewed = JSON.parse(runCommand('gh', [
    'pr',
    'view',
    prUrl.trim(),
    '--repo',
    repo,
    '--json',
    'number,url'
  ], { cwd: state.worktree.path }))
  return {
    number: viewed.number,
    url: viewed.url
  }
}

function refreshPrDiff(paths, state) {
  const repo = requireGitHubRepo(state)
  const diff = runCommand('gh', [
    'pr',
    'diff',
    String(state.pr.number),
    '--repo',
    repo
  ], { cwd: state.worktree.path })
  fs.writeFileSync(paths.reviewerInputFile, `${diff}\n`, 'utf8')
  return paths.reviewerInputFile
}

function finalizeRun(paths, state, logger, outcome) {
  state.status = outcome
  saveRunState(paths, state)
  logger.write('run_end', {
    outcome
  })
  releaseLock(paths)
}

async function maybeDrainQueue(context) {
  const { paths, config } = context
  const { next } = shiftQueue(paths)
  if (!next) {
    return null
  }

  const notice = withTag(config, 'meta', `Starting queued request: ${next.feature}`)
  const result = await handleStart(context.projectRoot, next.feature, {
    bypassQueue: true
  })
  return {
    status: result.status,
    messages: [notice, ...result.messages]
  }
}

async function handleStart(projectRoot, feature, options = {}) {
  const basePaths = getRuntimePaths(projectRoot)
  ensureRuntimeDirs(basePaths)
  const config = loadConfig(projectRoot)

  const missing = missingDependencies(config)
  if (missing.length > 0) {
    return {
      status: 'halted',
      messages: missing.map(item => missingDependency(config, item))
    }
  }

  const githubContext = resolveGitHubContext(projectRoot)
  if (!githubContext) {
    return {
      status: 'halted',
      messages: [missingGitHubRepo(config)]
    }
  }

  if (!isProjectScaffoldComplete(projectRoot)) {
    saveActiveSession(basePaths, {
      status: 'awaiting_scaffold',
      feature,
      created_at: new Date().toISOString()
    })
    return {
      status: 'awaiting_scaffold',
      messages: [needsScaffold(config)]
    }
  }

  refreshAgentsFromConfig(projectRoot)
  const projectCommands = loadProjectCommands(basePaths.projectConfigPath)
  if (!projectCommandsReady(projectCommands)) {
    const proposal = await runSetupAssistant(projectRoot, config)
    saveActiveSession(basePaths, {
      status: 'awaiting_config_confirm',
      feature,
      proposal,
      created_at: new Date().toISOString()
    })
    return {
      status: 'awaiting_config_confirm',
      messages: [configProposal(config, proposal)]
    }
  }

  if (!feature) {
    saveActiveSession(basePaths, {
      status: 'awaiting_prompt',
      created_at: new Date().toISOString()
    })
    return {
      status: 'awaiting_prompt',
      messages: [awaitingPrompt(config)]
    }
  }

  const lock = readLock(basePaths)
  if (!options.bypassQueue && lock && lockIsFresh(lock)) {
    const queueEntries = enqueue(basePaths, {
      feature,
      requested_at: new Date().toISOString()
    })
    return {
      status: 'queued',
      messages: [queued(config, lock.feature, queueEntries.length)]
    }
  }

  if (lock && !lockIsFresh(lock)) {
    releaseLock(basePaths)
  }

  const runId = buildRunId(feature)
  const paths = getRuntimePaths(projectRoot, runId)
  ensureRuntimeDirs(paths)
  const logger = createLogger({
    projectRoot,
    logDir: config.logging.dir
  })
  const monitorState = createMonitorState(config)
  const monitor = await ensureMonitor(paths, config, serializeMonitorState(monitorState))
  logger.write('run_start', {
    run_id_short: runId.slice(0, 12)
  })
  logger.write('window_opened', {
    port: monitor.port
  })

  const state = createInitialRunState({
    runId,
    featureRequest: feature,
    monitorPort: monitor.port,
    logFile: logger.filePath
  })
  state.github = githubContext
  saveRunState(paths, state)
  acquireLock(basePaths, {
    run_id: runId,
    feature,
    started_at: new Date().toISOString()
  })
  saveActiveSession(basePaths, {
    status: 'planning',
    run_id: runId,
    feature,
    created_at: new Date().toISOString()
  })

  const messages = [plannerInProgress(config)]
  try {
    const plannerRelay = createPlannerRelayPrompt(feature)
    writeRelayFile(paths, 'relay-to-planner.txt', plannerRelay)
    let plannerResult
    let plannerParseRetried = false
    try {
      plannerResult = await runTrackedStage({
        stage: 'planner',
        config,
        prompt: buildPlannerPrompt(config, feature),
        cwd: projectRoot,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
    } catch (error) {
      if (!isStageSchemaError(error, 'planner')) {
        throw error
      }
      plannerParseRetried = true
      messages.push(withTag(config, 'meta', 'The planner stage failed to parse its output. Let me retry.'))
      plannerResult = await runTrackedStage({
        stage: 'planner',
        config,
        prompt: buildPlannerRetryPrompt(config, feature, error.outputText ?? error.stdout ?? ''),
        cwd: projectRoot,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
    }

    fs.writeFileSync(paths.planFile, `${plannerResult.structured.plan_markdown}\n`, 'utf8')
    state.status = 'awaiting_approval'
    state.plan = {
      path: relativeProjectPath(projectRoot, paths.planFile),
      acceptance_checklist: plannerResult.structured.acceptance_checklist,
      file_structure_hint: plannerResult.structured.file_structure_hint,
      definition_of_done: plannerResult.structured.definition_of_done
    }
    saveRunState(paths, state)

    const plannerMessage = await runNarrator({
      mode: 'planner-summary',
      targetStage: 'planner',
      payload: {
        plan_markdown: plannerResult.structured.plan_markdown,
        plan_path: state.plan.path,
        plan_absolute_path: paths.planFile
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    })
    messages.push(plannerMessage)
    messages.push(approvalPrompt(config))

    saveActiveSession(basePaths, {
      status: 'awaiting_approval',
      run_id: runId,
      feature,
      log_file: logger.filePath,
      monitor_port: monitor.port,
      created_at: new Date().toISOString()
    })
    snapshot(logger, monitorState)
    return {
      status: 'awaiting_approval',
      messages,
      run_id: runId
    }
  } catch (error) {
    finalizeRun(paths, state, logger, 'halted')
    clearActiveSession(basePaths)
    return {
      status: 'halted',
      messages: [
        ...messages,
        halted(config, error.message)
      ]
    }
  }
}

async function continueApprovedRun(projectRoot, activeSession) {
  const basePaths = getRuntimePaths(projectRoot)
  const config = loadConfig(projectRoot)
  const paths = getRuntimePaths(projectRoot, activeSession.run_id)
  ensureRuntimeDirs(paths)
  const state = readJsonIfExists(paths.stateFile)
  if (!state) {
    clearActiveSession(basePaths)
    return {
      status: 'halted',
      messages: [halted(config, 'run state not found')]
    }
  }

  const logger = createLogger({
    projectRoot,
    logDir: config.logging.dir,
    existingFile: state.log_file ?? activeSession.log_file
  })
  const monitorState = state.metrics ?? createMonitorState(config)
  const monitor = await ensureMonitor(paths, config, serializeMonitorState(monitorState))

  try {
    state.worktree = ensureWorktree(projectRoot, state.feature_request)
    ensureGitHubContextForState(projectRoot, state)
    saveRunState(paths, state)

    const builderRelayPreferred = createStageRelayPrompt({
      targetStage: 'builder',
      planFile: paths.planFile,
      projectRoot
    })
    const builderRelay = await runNarrator({
      mode: 'relay',
      targetStage: 'builder',
      payload: {
        preferred_prompt: builderRelayPreferred
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    })
    const builderRelayPath = writeRelayFile(paths, 'relay-to-builder.txt', builderRelay)
    const builderStart = await runNarrator({
      mode: 'status',
      targetStage: 'builder',
      payload: {
        phase: 'starting',
        branch: state.worktree.branch
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    })

    const messages = [builderStart]
    const builderResult = await runTrackedStage({
      stage: 'builder',
      config,
      prompt: fs.readFileSync(builderRelayPath, 'utf8'),
      cwd: state.worktree.path,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port,
      timeoutMs: 60 * 60 * 1000
    })

    state.builder = {
      codex_session_id: builderResult.sessionId ?? builderResult.structured.session_id,
      commit_sha: builderResult.structured.commit_sha,
      files_changed: builderResult.structured.files_changed,
      tests_added: builderResult.structured.tests_added,
      build: builderResult.structured.build,
      tests: builderResult.structured.tests,
      lint: builderResult.structured.lint
    }
    saveRunState(paths, state)
    messages.push(await runNarrator({
      mode: 'status',
      targetStage: 'builder',
      payload: {
        phase: 'done',
        commit_sha: state.builder.commit_sha,
        build: state.builder.build,
        tests: state.builder.tests,
        lint: state.builder.lint
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    }))

    state.status = 'checking'
    saveRunState(paths, state)
    const specPrompt = `${createStageRelayPrompt({
      targetStage: 'spec_checker',
      planFile: paths.planFile,
      projectRoot
    })}\n\n${buildSpecPrompt(config, state.plan.path)}`
    const specResult = await runTrackedStage({
      stage: 'spec_checker',
      config,
      prompt: specPrompt,
      cwd: state.worktree.path,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port,
      timeoutMs: 20 * 60 * 1000
    })
    state.spec_check = {
      results: specResult.structured.results,
      escalated_ids: specResult.structured.results.filter(item => item.status === 'UNCLEAR').map(item => item.id)
    }
    saveRunState(paths, state)

    const specCounts = specResult.structured.results.reduce((accumulator, item) => {
      if (item.status === 'PASS') accumulator.pass_count += 1
      if (item.status === 'FAIL') accumulator.fail_count += 1
      if (item.status === 'UNCLEAR') accumulator.unclear_count += 1
      return accumulator
    }, { pass_count: 0, fail_count: 0, unclear_count: 0 })
    messages.push(await runNarrator({
      mode: 'status',
      targetStage: 'spec_checker',
      payload: specCounts,
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    }))

    if (specCounts.unclear_count > 0) {
      const unresolvedPath = path.join(paths.runDir, 'spec-unclear.json')
      fs.writeFileSync(unresolvedPath, `${JSON.stringify(specResult.structured.results.filter(item => item.status === 'UNCLEAR'), null, 2)}\n`, 'utf8')
      const escalationPrompt = `${createStageRelayPrompt({
        targetStage: 'escalation',
        planFile: paths.planFile,
        projectRoot
      })}\n\n${buildEscalationPrompt(config, state.plan.path, relativeProjectPath(projectRoot, unresolvedPath))}`
      const escalationResult = await runTrackedStage({
        stage: 'escalation',
        config,
        prompt: escalationPrompt,
        cwd: state.worktree.path,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
      const resolvedMap = new Map(escalationResult.structured.resolved.map(item => [item.id, item]))
      state.spec_check.results = state.spec_check.results.map(item => resolvedMap.get(item.id) ?? item)
      saveRunState(paths, state)
      messages.push(await runNarrator({
        mode: 'status',
        targetStage: 'escalation',
        payload: {
          resolved_count: escalationResult.structured.resolved.length
        },
        config,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      }))
    }

    if (state.spec_check.results.some(item => item.status === 'FAIL')) {
      finalizeRun(paths, state, logger, 'halted')
      clearActiveSession(basePaths)
      return {
        status: 'halted',
        messages: [
          ...messages,
          halted(config, 'spec checker found a failing acceptance criterion')
        ]
      }
    }

    state.pr = {
      ...state.pr,
      ...ensurePullRequest(paths, state)
    }
    saveRunState(paths, state)
    const reviewInputPath = refreshPrDiff(paths, state)

    const reviewerPrompt = `${createStageRelayPrompt({
      targetStage: 'reviewer',
      planFile: paths.planFile,
      reviewFile: reviewInputPath,
      projectRoot
    })}\n\n${buildReviewerPrompt(config, state.plan.path, relativeProjectPath(projectRoot, reviewInputPath))}`
    const reviewerResult = await runTrackedStage({
      stage: 'reviewer',
      config,
      prompt: reviewerPrompt,
      cwd: state.worktree.path,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    })
    state.reviewer = {
      issues: reviewerResult.structured.issues
    }
    fs.writeFileSync(paths.reviewFile, `${reviewerResult.structured.body_markdown}\n`, 'utf8')
    if (state.reviewer.issues.length > 0) {
      runCommand('gh', [
        'pr',
        'comment',
        String(state.pr.number),
        '--repo',
        state.github.repo,
        '--body-file',
        paths.reviewFile
      ], { cwd: state.worktree.path })
    }
    saveRunState(paths, state)
    messages.push(await runNarrator({
      mode: 'status',
      targetStage: 'reviewer',
      payload: {
        issue_count: state.reviewer.issues.length,
        pr_url: state.pr.url
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    }))

    let issueFilePath = paths.reviewFile
    if (state.reviewer.issues.length > 0) {
      const fixerRelayPreferred = createStageRelayPrompt({
        targetStage: 'fixer',
        planFile: paths.planFile,
        reviewFile: issueFilePath,
        projectRoot
      })
      const fixerRelay = await runNarrator({
        mode: 'relay',
        targetStage: 'fixer',
        payload: {
          preferred_prompt: fixerRelayPreferred
        },
        config,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
      const fixerRelayPath = writeRelayFile(paths, 'relay-to-fixer.txt', fixerRelay)
      const fixerResult = await runTrackedStage({
        stage: 'fixer',
        config,
        prompt: fs.readFileSync(fixerRelayPath, 'utf8'),
        cwd: state.worktree.path,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port,
        sessionId: state.builder.codex_session_id,
        timeoutMs: 60 * 60 * 1000
      })
      state.fixer.iterations += 1
      state.fixer.commits = fixerResult.structured.commits
      state.builder = {
        ...state.builder,
        build: fixerResult.structured.build,
        tests: fixerResult.structured.tests,
        lint: fixerResult.structured.lint
      }
      saveRunState(paths, state)
      runCommand('git', ['push'], { cwd: state.worktree.path })
      messages.push(await runNarrator({
        mode: 'status',
        targetStage: 'fixer',
        payload: {
          commit_count: fixerResult.structured.commits.length
        },
        config,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      }))
      refreshPrDiff(paths, state)
    }

    let verdict
    let gateIterations = 0
    do {
      gateIterations += 1
      const gatekeeperPrompt = buildGatekeeperPrompt(config, state.plan.path, relativeProjectPath(projectRoot, paths.reviewerInputFile), relativeProjectPath(projectRoot, issueFilePath))
      const gatekeeperResult = await runTrackedStage({
        stage: 'gatekeeper',
        config,
        prompt: gatekeeperPrompt,
        cwd: state.worktree.path,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
      verdict = gatekeeperResult.structured
      state.gatekeeper = {
        iteration: gateIterations,
        verdict: verdict.verdict,
        severity: verdict.severity,
        issues: verdict.issues
      }
      saveRunState(paths, state)
      messages.push(await runNarrator({
        mode: 'status',
        targetStage: 'gatekeeper',
        payload: {
          verdict: verdict.verdict,
          severity: verdict.severity,
          pr_url: state.pr.url
        },
        config,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      }))

      if (verdict.verdict === 'APPROVE') {
        break
      }

      if (verdict.severity === 'IMPORTANT' && gateIterations >= 2) {
        break
      }

      if (verdict.severity === 'CRITICAL' || verdict.severity === 'IMPORTANT') {
        issueFilePath = path.join(paths.runDir, `gatekeeper-issues-${gateIterations}.md`)
        fs.writeFileSync(issueFilePath, `${buildFixerIssuesMarkdown('Gatekeeper issues', verdict.issues)}\n`, 'utf8')
        const fixerRelay = createStageRelayPrompt({
          targetStage: 'fixer',
          planFile: paths.planFile,
          reviewFile: issueFilePath,
          projectRoot
        })
        writeRelayFile(paths, `relay-to-fixer-gate-${gateIterations}.txt`, fixerRelay)
        const fixerResult = await runTrackedStage({
          stage: 'fixer',
          config,
          prompt: fixerRelay,
          cwd: state.worktree.path,
          paths,
          state,
          logger,
          monitorState,
          monitorPort: monitor.port,
          sessionId: state.builder.codex_session_id,
          timeoutMs: 60 * 60 * 1000
        })
        state.fixer.iterations += 1
        state.fixer.commits.push(...fixerResult.structured.commits)
        state.builder = {
          ...state.builder,
          build: fixerResult.structured.build,
          tests: fixerResult.structured.tests,
          lint: fixerResult.structured.lint
        }
        saveRunState(paths, state)
        runCommand('git', ['push'], { cwd: state.worktree.path })
        refreshPrDiff(paths, state)
      }
    } while (verdict?.verdict !== 'APPROVE' && gateIterations < 3)

    if (verdict?.verdict === 'APPROVE') {
      state.pr = {
        ...state.pr,
        last_comment_check_at: new Date().toISOString()
      }
      saveRunState(paths, state)
      messages.push(mergeReadyHint(config))
    }

    finalizeRun(paths, state, logger, verdict?.verdict === 'APPROVE' ? 'approved' : 'handed_off')
    clearActiveSession(basePaths)
    logger.write('window_closed', {
      port: monitor.port
    })
    await shutdownMonitor(paths, monitor.port)

    const drained = await maybeDrainQueue({
      projectRoot,
      paths: basePaths,
      config
    })
    if (drained) {
      return {
        status: drained.status,
        messages: [...messages, ...drained.messages]
      }
    }

    return {
      status: verdict?.verdict === 'APPROVE' ? 'approved' : 'handed_off',
      messages
    }
  } catch (error) {
    finalizeRun(paths, state, logger, 'halted')
    clearActiveSession(basePaths)
    logger.write('window_closed', {
      port: monitor.port
    })
    await shutdownMonitor(paths, monitor.port)
    return {
      status: 'halted',
      messages: [halted(config, error.message)]
    }
  }
}

async function handleReject(projectRoot, activeSession) {
  const basePaths = getRuntimePaths(projectRoot)
  const config = loadConfig(projectRoot)
  if (!activeSession) {
    return {
      status: 'halted',
      messages: [halted(config, 'there is no active run')]
    }
  }

  if (activeSession.status === 'awaiting_scaffold' || activeSession.status === 'awaiting_config_confirm') {
    clearActiveSession(basePaths)
    return {
      status: 'rejected',
      messages: [nothingChanged(config)]
    }
  }

  if (activeSession.status === 'awaiting_approval' && activeSession.run_id) {
    const paths = getRuntimePaths(projectRoot, activeSession.run_id)
    const state = readJsonIfExists(paths.stateFile)
    if (state) {
      const logger = createLogger({
        projectRoot,
        logDir: config.logging.dir,
        existingFile: state.log_file
      })
      finalizeRun(paths, state, logger, 'rejected')
    } else {
      releaseLock(basePaths)
    }
    clearActiveSession(basePaths)
    return {
      status: 'rejected',
      messages: [halted(config, 'plan rejected by user')]
    }
  }

  clearActiveSession(basePaths)
  return {
    status: 'rejected',
    messages: [nothingChanged(config)]
  }
}

async function handleProvideFeature(projectRoot, feature) {
  const activeSession = loadActiveSession(getRuntimePaths(projectRoot))
  const nextFeature = feature || activeSession?.feature || ''
  return await handleStart(projectRoot, nextFeature)
}

async function handleConfigConfirm(projectRoot, answer) {
  const paths = getRuntimePaths(projectRoot)
  const config = loadConfig(projectRoot)
  const active = loadActiveSession(paths)
  if (!active || active.status !== 'awaiting_config_confirm') {
    return {
      status: 'halted',
      messages: [halted(config, 'there is no pending config proposal')]
    }
  }

  const parsed = parseConfigAnswer(answer, active.proposal)
  if (parsed.action === 'cancel') {
    clearActiveSession(paths)
    return {
      status: 'rejected',
      messages: [nothingChanged(config)]
    }
  }
  if (parsed.action === 'invalid') {
    return {
      status: 'awaiting_config_confirm',
      messages: [configHelp(config)]
    }
  }

  const commandErrors = validateProjectCommands(parsed.commands)
  if (commandErrors.length > 0) {
    const missingKeys = commandErrors
      .filter(item => item.endsWith('cannot be empty'))
      .map(item => item.split(' ')[0])
    return {
      status: 'awaiting_config_confirm',
      messages: [
        configRequirements(config, missingKeys.length > 0 ? missingKeys : ['build', 'lint']),
        configHelp(config)
      ]
    }
  }

  writeProjectCommands(paths, parsed.commands)
  clearActiveSession(paths)
  return await handleStart(projectRoot, active.feature ?? '')
}

async function handleCheckComment(projectRoot) {
  const basePaths = getRuntimePaths(projectRoot)
  ensureRuntimeDirs(basePaths)
  const config = loadConfig(projectRoot)
  const missing = missingDependencies(config)
  if (missing.length > 0) {
    return {
      status: 'halted',
      messages: missing.map(item => missingDependency(config, item))
    }
  }

  const lock = readLock(basePaths)
  if (lock && lockIsFresh(lock)) {
    return {
      status: 'halted',
      messages: [halted(config, 'run in progress, refusing to check comments')]
    }
  }
  if (lock && !lockIsFresh(lock)) {
    releaseLock(basePaths)
  }

  const latestRun = findLatestRunWithPr(projectRoot)
  if (!latestRun) {
    return {
      status: 'halted',
      messages: [halted(config, 'no previous 4CO-OP run with a pull request was found')]
    }
  }

  const { paths, state } = latestRun
  const logger = createLogger({
    projectRoot,
    logDir: config.logging.dir,
    existingFile: state.log_file
  })
  const monitorState = state.metrics ?? createMonitorState(config)
  const monitor = await ensureMonitor(paths, config, serializeMonitorState(monitorState))
  acquireLock(basePaths, {
    run_id: state.run_id,
    feature: `${state.feature_request} (check-comment)`,
    started_at: new Date().toISOString()
  })
  logger.write('comment_check_start', {
    run_id_short: String(state.run_id ?? '').slice(0, 12)
  })
  logger.write('window_opened', {
    port: monitor.port
  })

  try {
    state.worktree = ensureWorktree(projectRoot, state.feature_request)
    ensureGitHubContextForState(projectRoot, state)
    if (!state.pr?.number) {
      throw new Error('run state does not have a pull request to inspect')
    }
    saveRunState(paths, state)

    const { prView, reviewComments } = fetchPullRequestConversation(state, state.worktree.path)
    state.pr = {
      ...state.pr,
      number: prView.number,
      url: prView.url
    }
    if (prView.state === 'MERGED' || prView.state === 'CLOSED') {
      throw new Error(`pull request is already ${prView.state.toLowerCase()}`)
    }

    const sinceIso = state.pr.last_comment_check_at ?? state.created_at
    const newItems = collectNewConversationItems(prView, reviewComments, sinceIso)
    if (newItems.length === 0) {
      state.pr.last_comment_check_at = new Date().toISOString()
      state.status = state.gatekeeper?.verdict === 'APPROVE' ? 'approved' : state.status
      saveRunState(paths, state)
      logger.write('comment_check_end', {
        outcome: 'no_new_comments'
      })
      logger.write('window_closed', {
        port: monitor.port
      })
      await shutdownMonitor(paths, monitor.port)
      releaseLock(basePaths)
      return {
        status: state.status,
        messages: [noNewComments(config)]
      }
    }

    const reviewInputPath = refreshPrDiff(paths, state)
    const timestamp = Date.now()
    const commentFilePath = path.join(paths.runDir, `manual-comments-${timestamp}.md`)
    fs.writeFileSync(commentFilePath, `${formatManualCommentMarkdown(prView, newItems)}\n`, 'utf8')

    const manualReviewFilePath = path.join(paths.runDir, `manual-comments-review-${timestamp}.md`)
    const reviewerPrompt = buildManualCommentReviewerPrompt(
      config,
      state.plan.path,
      relativeProjectPath(projectRoot, reviewInputPath),
      relativeProjectPath(projectRoot, commentFilePath)
    )
    const reviewerResult = await runTrackedStage({
      stage: 'reviewer',
      config,
      prompt: reviewerPrompt,
      cwd: state.worktree.path,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    })
    state.reviewer = {
      issues: reviewerResult.structured.issues
    }
    fs.writeFileSync(manualReviewFilePath, `${reviewerResult.structured.body_markdown}\n`, 'utf8')
    saveRunState(paths, state)

    const messages = [
      await runNarrator({
        mode: 'status',
        targetStage: 'reviewer',
        payload: {
          issue_count: state.reviewer.issues.length,
          pr_url: state.pr.url
        },
        config,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
    ]

    if (state.reviewer.issues.length === 0) {
      state.pr.last_comment_check_at = new Date().toISOString()
      state.status = state.gatekeeper?.verdict === 'APPROVE' ? 'approved' : state.status
      saveRunState(paths, state)
      logger.write('comment_check_end', {
        outcome: 'no_actionable_comments'
      })
      logger.write('window_closed', {
        port: monitor.port
      })
      await shutdownMonitor(paths, monitor.port)
      releaseLock(basePaths)
      return {
        status: state.status,
        messages: [...messages, noActionableComments(config)]
      }
    }

    if (!state.builder?.codex_session_id) {
      throw new Error('builder session is missing, so fixer cannot continue from PR comments')
    }

    const fixerRelayPreferred = createStageRelayPrompt({
      targetStage: 'fixer',
      planFile: paths.planFile,
      reviewFile: manualReviewFilePath,
      projectRoot
    })
    const fixerRelay = await runNarrator({
      mode: 'relay',
      targetStage: 'fixer',
      payload: {
        preferred_prompt: fixerRelayPreferred
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    })
    const fixerRelayPath = writeRelayFile(paths, `relay-to-fixer-comments-${timestamp}.txt`, fixerRelay)
    const fixerResult = await runTrackedStage({
      stage: 'fixer',
      config,
      prompt: fs.readFileSync(fixerRelayPath, 'utf8'),
      cwd: state.worktree.path,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port,
      sessionId: state.builder.codex_session_id,
      timeoutMs: 60 * 60 * 1000
    })
    state.fixer.iterations += 1
    state.fixer.commits.push(...fixerResult.structured.commits)
    state.builder = {
      ...state.builder,
      build: fixerResult.structured.build,
      tests: fixerResult.structured.tests,
      lint: fixerResult.structured.lint
    }
    saveRunState(paths, state)
    runCommand('git', ['push'], { cwd: state.worktree.path })
    messages.push(await runNarrator({
      mode: 'status',
      targetStage: 'fixer',
      payload: {
        commit_count: fixerResult.structured.commits.length
      },
      config,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
    }))
    refreshPrDiff(paths, state)

    let issueFilePath = manualReviewFilePath
    let verdict
    let gateIterations = 0
    do {
      gateIterations += 1
      const gatekeeperPrompt = buildGatekeeperPrompt(
        config,
        state.plan.path,
        relativeProjectPath(projectRoot, paths.reviewerInputFile),
        relativeProjectPath(projectRoot, issueFilePath)
      )
      const gatekeeperResult = await runTrackedStage({
        stage: 'gatekeeper',
        config,
        prompt: gatekeeperPrompt,
        cwd: state.worktree.path,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      })
      verdict = gatekeeperResult.structured
      state.gatekeeper = {
        iteration: gateIterations,
        verdict: verdict.verdict,
        severity: verdict.severity,
        issues: verdict.issues
      }
      saveRunState(paths, state)
      messages.push(await runNarrator({
        mode: 'status',
        targetStage: 'gatekeeper',
        payload: {
          verdict: verdict.verdict,
          severity: verdict.severity,
          pr_url: state.pr.url
        },
        config,
        paths,
        state,
        logger,
        monitorState,
        monitorPort: monitor.port
      }))

      if (verdict.verdict === 'APPROVE') {
        break
      }

      if (verdict.severity === 'IMPORTANT' && gateIterations >= 2) {
        break
      }

      if (verdict.severity === 'CRITICAL' || verdict.severity === 'IMPORTANT') {
        issueFilePath = path.join(paths.runDir, `gatekeeper-comment-issues-${gateIterations}.md`)
        fs.writeFileSync(issueFilePath, `${buildFixerIssuesMarkdown('Gatekeeper issues', verdict.issues)}\n`, 'utf8')
        const fixerRelayPathLoop = writeRelayFile(
          paths,
          `relay-to-fixer-comment-gate-${gateIterations}.txt`,
          createStageRelayPrompt({
            targetStage: 'fixer',
            planFile: paths.planFile,
            reviewFile: issueFilePath,
            projectRoot
          })
        )
        const followUpFixerResult = await runTrackedStage({
          stage: 'fixer',
          config,
          prompt: fs.readFileSync(fixerRelayPathLoop, 'utf8'),
          cwd: state.worktree.path,
          paths,
          state,
          logger,
          monitorState,
          monitorPort: monitor.port,
          sessionId: state.builder.codex_session_id,
          timeoutMs: 60 * 60 * 1000
        })
        state.fixer.iterations += 1
        state.fixer.commits.push(...followUpFixerResult.structured.commits)
        state.builder = {
          ...state.builder,
          build: followUpFixerResult.structured.build,
          tests: followUpFixerResult.structured.tests,
          lint: followUpFixerResult.structured.lint
        }
        saveRunState(paths, state)
        runCommand('git', ['push'], { cwd: state.worktree.path })
        refreshPrDiff(paths, state)
      }
    } while (verdict?.verdict !== 'APPROVE' && gateIterations < 3)

    state.pr.last_comment_check_at = new Date().toISOString()
    state.status = verdict?.verdict === 'APPROVE' ? 'approved' : 'handed_off'
    saveRunState(paths, state)
    logger.write('comment_check_end', {
      outcome: state.status
    })
    logger.write('window_closed', {
      port: monitor.port
    })
    await shutdownMonitor(paths, monitor.port)
    releaseLock(basePaths)

    if (state.status === 'approved') {
      messages.push(mergeReadyHint(config))
    }

    return {
      status: state.status,
      messages
    }
  } catch (error) {
    saveRunState(paths, state)
    logger.write('comment_check_end', {
      outcome: 'halted'
    })
    logger.write('window_closed', {
      port: monitor.port
    })
    await shutdownMonitor(paths, monitor.port)
    releaseLock(basePaths)
    return {
      status: 'halted',
      messages: [halted(config, error.message)]
    }
  }
}

function parseAgeLimit(value) {
  const match = String(value ?? '').match(/^(\d+)d$/i)
  if (!match) {
    return null
  }
  return Number(match[1]) * 24 * 60 * 60 * 1000
}

function cleanRuns(projectRoot, flags) {
  const paths = getRuntimePaths(projectRoot)
  const config = loadConfig(projectRoot)
  const lock = readLock(paths)
  if (lock && lockIsFresh(lock)) {
    return {
      status: 'halted',
      messages: [halted(config, 'run in progress, refusing to clean')]
    }
  }

  const dryRun = flags.includes('--dry-run')
  const force = flags.includes('--force')
  const removeAll = flags.includes('--all')
  const olderThanIndex = flags.indexOf('--older-than')
  const keepLastIndex = flags.indexOf('--keep-last')
  const olderThanMs = olderThanIndex >= 0 ? parseAgeLimit(flags[olderThanIndex + 1]) : null
  const keepLast = keepLastIndex >= 0 ? Number(flags[keepLastIndex + 1]) : null

  const runDirs = pathExists(paths.runtimeRunsDir)
    ? fs.readdirSync(paths.runtimeRunsDir).map(name => path.join(paths.runtimeRunsDir, name))
    : []
  const runStates = runDirs
    .map(runDir => {
      const statePath = path.join(runDir, 'state.json')
      return pathExists(statePath) ? { runDir, state: readJsonIfExists(statePath) } : null
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.state.created_at).getTime() - new Date(left.state.created_at).getTime())

  let sweptWorktrees = 0
  let deletedRuns = 0

  for (const { state } of runStates) {
    if (!state.pr?.number || !state.github?.repo || !state.worktree?.path || !pathExists(state.worktree.path)) {
      continue
    }
    try {
      const prState = runCommand('gh', [
        'pr',
        'view',
        String(state.pr.number),
        '--repo',
        state.github.repo,
        '--json',
        'state',
        '--jq',
        '.state'
      ], { cwd: projectRoot })
      if (prState === 'MERGED' || prState === 'CLOSED') {
        if (!dryRun) {
          removeWorktree(projectRoot, state.worktree.path, force)
        }
        sweptWorktrees += 1
      }
    } catch {
      continue
    }
  }

  const now = Date.now()
  for (let index = 0; index < runStates.length; index += 1) {
    const { runDir, state } = runStates[index]
    const ageExceeded = olderThanMs ? now - new Date(state.created_at).getTime() > olderThanMs : false
    const outsideKeepWindow = Number.isFinite(keepLast) ? index >= keepLast : false
    const shouldDelete = removeAll || ageExceeded || outsideKeepWindow
    if (!shouldDelete) {
      continue
    }
    if (!dryRun) {
      fs.rmSync(runDir, {
        recursive: true,
        force: true
      })
    }
    deletedRuns += 1
  }

  return {
    status: 'cleaned',
    messages: [
      withTag(config, 'meta', `Swept ${sweptWorktrees} merged or closed worktrees, deleted ${deletedRuns} run folders.`)
    ]
  }
}

async function main() {
  const projectRoot = findProjectRoot(process.cwd())
  const args = parseArgs(process.argv.slice(2))
  const basePaths = getRuntimePaths(projectRoot)
  ensureRuntimeDirs(basePaths)

  let result
  if (args.command === 'start') {
    result = await handleStart(projectRoot, args.feature)
  } else if (args.command === 'check-comment') {
    result = await handleCheckComment(projectRoot)
  } else if (args.command === 'continue-active') {
    const activeSession = loadActiveSession(basePaths)
    if (!activeSession) {
      result = {
        status: 'halted',
        messages: [halted(loadConfig(projectRoot), 'there is no active run')]
      }
    } else if (activeSession.status === 'awaiting_scaffold') {
      scaffoldProject(projectRoot)
      clearActiveSession(basePaths)
      result = await handleStart(projectRoot, activeSession.feature ?? '')
      result.messages = [scaffolded(loadConfig(projectRoot)), ...result.messages]
    } else if (activeSession.status === 'awaiting_approval') {
      result = await continueApprovedRun(projectRoot, activeSession)
    } else {
      result = {
        status: 'halted',
        messages: [halted(loadConfig(projectRoot), `continue-active is not valid from ${activeSession.status}`)]
      }
    }
  } else if (args.command === 'reject-active') {
    result = await handleReject(projectRoot, loadActiveSession(basePaths))
  } else if (args.command === 'provide-feature') {
    result = await handleProvideFeature(projectRoot, args.feature)
  } else if (args.command === 'config-confirm') {
    result = await handleConfigConfirm(projectRoot, args.answer)
  } else if (args.command === 'clean') {
    result = cleanRuns(projectRoot, args.flags)
  } else {
    result = {
      status: 'halted',
      messages: [halted(loadConfig(projectRoot), `unknown command: ${args.command}`)]
    }
  }

  printResult(result.status, result.messages.filter(m => m != null), result.run_id ? { run_id: result.run_id } : {})
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const projectRoot = findProjectRoot(process.cwd())
    const config = loadConfig(projectRoot)
    printResult('halted', [halted(config, error.message)])
    process.exitCode = 1
  })
}
