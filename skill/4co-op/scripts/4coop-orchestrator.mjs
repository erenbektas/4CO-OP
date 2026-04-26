import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
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
  baseBranchInvalid,
  baseBranchSet,
  branchList,
  configHelp,
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
  collectManifestSnippets
} from './4coop-detect.mjs'
import {
  acquireLock,
  enqueue,
  lockIsFresh,
  markLockResumed,
  markLockSuspended,
  readLock,
  releaseLock,
  shiftQueue,
  touchLockHeartbeat
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
import { ensureMonitor, nudgeCockpit, postMonitorState, postStageEvent, shutdownMonitor } from './4coop-monitor-spawn.mjs'
import { createLiveEventSink } from './4coop-live-events.mjs'
import { createNetworkWatchdog } from './4coop-network-watchdog.mjs'
import { createPlannerRelayPrompt, createStageRelayPrompt, writeRelayFile } from './4coop-relay.mjs'
import {
  clearActiveSession,
  clearStageInFlight,
  createInitialRunState,
  getLatestSessionId,
  loadActiveSession,
  markStateResumed,
  markStateSuspended,
  readStageInFlight,
  recordSessionId,
  saveActiveSession,
  saveRunState,
  touchStageInFlight,
  updateRunState,
  writeStageInFlight
} from './4coop-state.mjs'
import { detectBaseBranch, ensureInPlaceBranch, ensureWorktree, listBaseBranchCandidates, removeWorktree } from './4coop-worktree.mjs'
import { ensureTagged, stripLeadingTag, withTag } from './4coop-tag-format.mjs'
import { runClaudeStage } from './4coop-stage-claude.mjs'
import { runCodexExec, runCodexResume } from './4coop-stage-codex.mjs'
import { isProjectScaffoldComplete, refreshAgentsFromConfig, scaffoldProject } from './4coop-scaffolder.mjs'

const READ_ONLY_STAGES = new Set(['planner', 'spec_checker', 'escalation', 'reviewer', 'gatekeeper', 'narrator'])

const SUSPEND_REASON = {
  user: 'user',
  network: 'network_loss',
  apiExhausted: 'api_exhausted'
}

class SuspendRequested extends Error {
  constructor(reason = SUSPEND_REASON.user) {
    super(`suspend requested: ${reason}`)
    this.name = 'SuspendRequested'
    this.reason = reason
  }
}

const stageController = {
  child: null,
  suspendReason: null,
  suspendRequested: false,
  basePaths: null,
  heartbeatTimer: null
}

function registerChild(child) {
  stageController.child = child
}

function clearChild() {
  stageController.child = null
}

function requestSuspend(reason) {
  stageController.suspendRequested = true
  stageController.suspendReason = reason ?? SUSPEND_REASON.user
  const child = stageController.child
  if (child && typeof child.kill === 'function') {
    try { child.kill('SIGTERM') } catch {}
  }
}

function startHeartbeat(basePaths, paths) {
  stopHeartbeat()
  stageController.basePaths = basePaths
  stageController.heartbeatTimer = setInterval(() => {
    try {
      touchLockHeartbeat(basePaths)
      if (paths?.stageInFlightFile) touchStageInFlight(paths)
    } catch {
      // Heartbeat is best-effort.
    }
  }, 10 * 1000)
  stageController.heartbeatTimer.unref?.()
}

function stopHeartbeat() {
  if (stageController.heartbeatTimer) {
    clearInterval(stageController.heartbeatTimer)
    stageController.heartbeatTimer = null
  }
}

async function saveActiveSessionAndNudge(basePaths, sessionData) {
  saveActiveSession(basePaths, sessionData)
  try {
    await nudgeCockpit(basePaths)
  } catch {
    // Monitor may not be running; halt flow should not depend on the UI.
  }
}

async function clearActiveSessionAndNudge(pathsLike) {
  clearActiveSession(pathsLike)
  try {
    await nudgeCockpit(pathsLike)
  } catch {}
}

const STAGE_SCHEMA_FILES = {
  planner: 'planner-result.json',
  builder: 'builder-result.json',
  spec_checker: 'spec-check-result.json',
  escalation: 'escalation-result.json',
  reviewer: 'reviewer-result.json',
  fixer: 'fixer-result.json',
  gatekeeper: 'gatekeeper-verdict.json',
  narrator: 'narrator-result.json',
  pr_writer: 'pr-writer-result.json'
}

function parseArgs(argv) {
  const [command = 'start', ...rest] = argv
  const parsed = {
    command,
    feature: '',
    answer: '',
    base: '',
    flags: []
  }

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]
    if (current === '--feature' || current === '--answer' || current === '--base') {
      const target = current === '--feature'
        ? 'feature'
        : current === '--answer' ? 'answer' : 'base'
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

  if (parsed.command === 'set-base' && !parsed.base) {
    parsed.base = parsed.flags.join(' ').trim()
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

function buildSetupAssistantPrompt(config, manifestEntries, fallback) {
  const manifestBlock = manifestEntries.length > 0
    ? manifestEntries.map(entry => {
      return [
        `File: ${entry.relative_path}`,
        '```text',
        entry.snippet,
        '```'
      ].join('\n')
    }).join('\n\n')
    : 'No recognized manifest files were found.'

  const hintBlock = fallback ? [
    '',
    'Deterministic detector hint (you may override if the manifests suggest something better):',
    `  detected_stack = ${fallback.detected_stack}`,
    `  proposed_build = ${fallback.proposed_build || '(none)'}`,
    `  proposed_test  = ${fallback.proposed_test || '(none)'}`,
    `  proposed_lint  = ${fallback.proposed_lint || '(none)'}`,
    ''
  ].join('\n') : ''

  return [
    'You are the 4CO-OP narrator in setup-assistant mode.',
    `Return only JSON with tagged_message starting exactly with "${config.tags.meta}:".`,
    'Inspect the manifest and config snippets provided below.',
    'Pick sensible build, test, and lint commands for this project.',
    'Prefer commands explicitly declared in the manifests (e.g. package.json scripts, Makefile targets, justfile recipes).',
    'Prefer wrapper scripts when present (./gradlew, ./mvnw).',
    'Pick the package manager suggested by any lockfile bullets listed below (bun.lockb → bun, pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm).',
    'If the project does not appear to have tests yet, proposed_test may be an empty string.',
    'Return keys: tagged_message, detected_stack, proposed_build, proposed_test, proposed_lint, confidence, summary.',
    hintBlock,
    manifestBlock
  ].join('\n')
}

async function runSetupAssistant(projectRoot, config) {
  const manifestEntries = collectManifestSnippets(projectRoot)
  const fallback = proposeProjectCommands(projectRoot)

  try {
    const result = await runClaudeStage({
      cli: config.models.narrator.cli,
      stage: 'narrator',
      model: config.models.narrator.model,
      prompt: buildSetupAssistantPrompt(config, manifestEntries, fallback),
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
  if (/^(skip|skip all|just start|just run|nothing)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: { build: '', test: '', lint: '' }
    }
  }
  if (/^(ok|okay|yes|use these|use proposed|accept)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: {
        build: proposal.proposed_build ?? '',
        test: proposal.proposed_test ?? '',
        lint: proposal.proposed_lint ?? ''
      }
    }
  }
  if (/^(no tests|skip tests|without tests)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: {
        build: proposal.proposed_build ?? '',
        test: '',
        lint: proposal.proposed_lint ?? ''
      }
    }
  }
  if (/^(no build|skip build|without build)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: {
        build: '',
        test: proposal.proposed_test ?? '',
        lint: proposal.proposed_lint ?? ''
      }
    }
  }
  if (/^(no lint|skip lint|without lint)\b/i.test(trimmed)) {
    return {
      action: 'accept',
      commands: {
        build: proposal.proposed_build ?? '',
        test: proposal.proposed_test ?? '',
        lint: ''
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
      STRICT_JSON_PREAMBLE,
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
      STRICT_JSON_PREAMBLE,
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
    STRICT_JSON_PREAMBLE,
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
  sessionId = null,
  resumeSessionId = null,
  basePaths = null
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

  const callIndex = (monitorState.rows[stage]?.calls ?? 0) + 1
  const liveSink = createLiveEventSink({
    runDir: paths.runDir,
    stage,
    callIndex,
    broadcast: monitorPort
      ? (eventName, payload) => { postStageEvent(monitorPort, payload).catch(() => {}) }
      : null
  })

  const suspendConfig = config.suspend ?? {}
  const watchdog = suspendConfig.auto_suspend_on_network_loss !== false
    ? createNetworkWatchdog({
        endpoints: suspendConfig.network_probe_endpoints,
        silenceTimeoutMs: suspendConfig.stream_silence_timeout_ms,
        maxConsecutiveFailures: suspendConfig.max_consecutive_probe_failures,
        onNetworkLoss: () => {
          logger.write('network_loss_detected', { stage })
          requestSuspend(SUSPEND_REASON.network)
        }
      })
    : null

  const onEvent = (event, rawLine) => {
    watchdog?.recordActivity()
    if (event?.type === 'system' && event?.subtype === 'api_retry') {
      const attempt = Number(event.attempt ?? 0)
      const maxRetries = Number(event.max_retries ?? 0)
      if (maxRetries > 0 && attempt >= maxRetries) {
        logger.write('api_retry_exhausted', {
          stage,
          error: event.error ?? null,
          error_status: event.error_status ?? null
        })
        requestSuspend(SUSPEND_REASON.apiExhausted)
      }
    }
    liveSink.onEvent(event, rawLine)
  }

  let effectiveResume = resumeSessionId
  if (!effectiveResume && state?.resume_hint?.stage === stage && state.resume_hint.session_id) {
    effectiveResume = state.resume_hint.session_id
    state.resume_hint = null
    saveRunState(paths, state)
    logger.write('stage_resume', { stage, session_id: effectiveResume })
  }
  const preAssignedClaudeId = stageConfig.cli === 'claude' && !effectiveResume ? randomUUID() : null
  const initialSessionId = effectiveResume ?? preAssignedClaudeId ?? sessionId ?? null
  const effectiveBasePaths = basePaths ?? (paths?.projectRoot ? getRuntimePaths(paths.projectRoot) : null)

  writeStageInFlight(paths, {
    stage,
    callIndex,
    tool: stageConfig.cli,
    sessionId: initialSessionId,
    promptPath: null
  })
  if (effectiveBasePaths) startHeartbeat(effectiveBasePaths, paths)
  watchdog?.start()

  const onSessionStarted = id => {
    if (!id) return
    try {
      recordSessionId(paths, { stage, callIndex, sessionId: id, tool: stageConfig.cli })
      touchStageInFlight(paths, { session_id: id })
    } catch {
      // Never crash a stage because bookkeeping failed.
    }
  }
  const onSpawn = child => {
    registerChild(child)
    if (stageController.suspendRequested) {
      try { child.kill('SIGTERM') } catch {}
    }
  }

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
        timeoutMs,
        onEvent,
        sessionId: preAssignedClaudeId,
        resumeSessionId: effectiveResume,
        onSessionStarted,
        onSpawn
      })
    } else if (effectiveResume || sessionId) {
      result = await runCodexResume({
        stage,
        sessionId: effectiveResume ?? sessionId,
        model: stageConfig.model,
        prompt,
        cwd,
        outputFile,
        rawOutputPath,
        timeoutMs,
        onEvent,
        onSessionStarted,
        onSpawn
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
        timeoutMs,
        onEvent,
        onSessionStarted,
        onSpawn
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
      exact_tokens: result.usage.exact,
      structured: result.structured ?? null,
      model: stageConfig.model,
      cli: stageConfig.cli,
      event_tokens: liveSink.eventCounts
    })
    logger.write('stage_call', {
      stage,
      call_number: monitorState.rows[stage].calls,
      duration_ms: durationMs,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      exit_code: result.exitCode,
      exact_tokens: result.usage.exact,
      event_tokens: liveSink.eventCounts,
      output_file: outputFile,
      raw_output_path: rawOutputPath,
      model: stageConfig.model,
      cli: stageConfig.cli
    })
    await syncMonitor(paths, state, monitorState, monitorPort)
    snapshot(logger, monitorState)
    clearStageInFlight(paths)
    clearChild()
    stopHeartbeat()
    watchdog?.stop()
    return result
  } catch (error) {
    interruptStageCall(monitorState, stage, {
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      input: prompt,
      event_tokens: liveSink.eventCounts,
      model: stageConfig.model,
      cli: stageConfig.cli,
      schema_failure: error?.name === 'StageSchemaError' ? {
        message: error.message,
        stage: error.stage,
        output_text_preview: String(error.outputText ?? '').slice(0, 2000),
        stderr_preview: String(error.stderr ?? '').slice(0, 1000)
      } : null
    })
    clearChild()
    stopHeartbeat()
    watchdog?.stop()

    if (stageController.suspendRequested) {
      const reason = stageController.suspendReason ?? SUSPEND_REASON.user
      logger.write('stage_suspended', { stage, reason })
      await syncMonitor(paths, state, monitorState, monitorPort)
      snapshot(logger, monitorState)
      throw new SuspendRequested(reason)
    }

    logger.write('interruption', {
      stage,
      reason_code: error?.name === 'StageSchemaError' ? 'schema_error' : 'error',
      message: error?.message ?? null,
      output_file: outputFile,
      raw_output_path: rawOutputPath
    })
    await syncMonitor(paths, state, monitorState, monitorPort)
    snapshot(logger, monitorState)
    throw error
  }
}

const STRICT_JSON_PREAMBLE = [
  'CRITICAL OUTPUT FORMAT REQUIREMENT:',
  '- Respond with ONLY a single JSON object matching the provided schema.',
  '- No markdown code fences (no ```json ... ```).',
  '- No prose before or after the JSON.',
  '- No commentary, no explanations outside the JSON fields.',
  '- The response must parse as valid JSON on the first attempt.',
  ''
].join('\n')

function writeSchemaFailureArtifact(runDir, stage, attempt, error) {
  try {
    const base = `${stage}-failure-attempt-${String(attempt).padStart(2, '0')}`
    const rawPath = path.join(runDir, `${base}-raw.txt`)
    fs.writeFileSync(rawPath, String(error?.outputText ?? ''), 'utf8')
    if (error?.stderr) {
      const stderrPath = path.join(runDir, `${base}-stderr.txt`)
      fs.writeFileSync(stderrPath, String(error.stderr), 'utf8')
    }
    return rawPath
  } catch {
    return null
  }
}

async function runSpecCheckerWithRecovery({
  config,
  basePrompt,
  cwd,
  paths,
  state,
  logger,
  monitorState,
  monitorPort
}) {
  const stage = 'spec_checker'
  const originalStageConfig = { ...config.models[stage] }
  const escalationModel = originalStageConfig.escalation_model ?? null
  const attempts = [
    { label: 'initial', prompt: basePrompt, overrideModel: null },
    { label: 'strict_retry', prompt: `${STRICT_JSON_PREAMBLE}${basePrompt}`, overrideModel: null }
  ]
  if (escalationModel && escalationModel !== originalStageConfig.model) {
    attempts.push({
      label: 'escalation',
      prompt: `${STRICT_JSON_PREAMBLE}${basePrompt}`,
      overrideModel: escalationModel
    })
  }

  const recoveryTrail = []
  let lastError = null

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    if (attempt.overrideModel) {
      config.models[stage] = { ...originalStageConfig, model: attempt.overrideModel }
      logger.write('spec_checker_model_escalation', {
        attempt: attempt.label,
        from_model: originalStageConfig.model,
        to_model: attempt.overrideModel
      })
    }
    try {
      const result = await runTrackedStage({
        stage,
        config,
        prompt: attempt.prompt,
        cwd,
        paths,
        state,
        logger,
        monitorState,
        monitorPort,
        timeoutMs: 20 * 60 * 1000
      })
      if (recoveryTrail.length > 0) {
        logger.write('spec_checker_schema_recovered', {
          attempt: attempt.label,
          recovered_after: recoveryTrail
        })
      }
      config.models[stage] = originalStageConfig
      return result
    } catch (error) {
      config.models[stage] = originalStageConfig
      if (!isStageSchemaError(error, stage)) {
        throw error
      }
      lastError = error
      const rawPath = writeSchemaFailureArtifact(paths.runDir, stage, index + 1, error)
      recoveryTrail.push({
        attempt: attempt.label,
        raw_path: rawPath ? path.basename(rawPath) : null,
        message: error.message
      })
      logger.write('spec_checker_schema_failure', {
        attempt: attempt.label,
        model: attempt.overrideModel ?? originalStageConfig.model,
        raw_path: rawPath ? path.basename(rawPath) : null,
        message: error.message
      })
    }
  }

  const failure = new Error(
    `spec checker schema parse failed after ${recoveryTrail.length} attempts — see ${recoveryTrail.map(entry => entry.raw_path).filter(Boolean).join(', ')}`
  )
  failure.name = 'StageSchemaError'
  failure.stage = stage
  failure.recoveryTrail = recoveryTrail
  failure.outputText = lastError?.outputText ?? ''
  failure.stderr = lastError?.stderr ?? ''
  throw failure
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
  const attemptStage = async stagePrompt => runTrackedStage({
    stage: 'narrator',
    config,
    prompt: stagePrompt,
    cwd: state?.worktree?.path ?? paths.projectRoot,
    paths,
    state,
    logger,
    monitorState,
    monitorPort,
    timeoutMs: 5 * 60 * 1000
  })

  let result
  try {
    result = await attemptStage(prompt)
  } catch (error) {
    if (!isStageSchemaError(error, 'narrator')) {
      return narratorFallback(config, mode, targetStage, payload)
    }
    try {
      result = await attemptStage(`${STRICT_JSON_PREAMBLE}\n\n${prompt}`)
    } catch {
      return narratorFallback(config, mode, targetStage, payload)
    }
  }

  if (mode === 'relay') {
    return result.structured.relay_prompt || payload.preferred_prompt
  }
  if (mode === 'planner-summary') {
    return finalizePlannerSummaryMessage(config, result.structured, payload.plan_absolute_path, payload.plan_path)
  }
  return ensureTagged(config, targetStage, result.structured.tagged_message)
}

async function runPrWriterAndUpdatePr({ config, paths, state, logger, monitorState, monitorPort, projectRoot }) {
  if (!state.pr?.number || !state.github?.repo) {
    throw new Error('pr_writer skipped: no PR context')
  }

  const diffPath = paths.reviewerInputFile
  const reviewPath = paths.reviewFile
  const specSummaryPath = path.join(paths.runDir, 'spec-summary.md')
  if (state.spec_check?.results) {
    const specLines = [
      '# Spec checker summary',
      '',
      ...state.spec_check.results.map(item => `- ${item.status} · ${item.id}${item.evidence_file ? ` — ${item.evidence_file}:${item.evidence_line}` : ''}`)
    ]
    fs.writeFileSync(specSummaryPath, `${specLines.join('\n')}\n`, 'utf8')
  }

  const prompt = buildPrWriterPrompt(config, {
    planPath: paths.planFile,
    diffPath,
    reviewPath,
    specSummaryPath: pathExists(specSummaryPath) ? specSummaryPath : null,
    builder: state.builder ?? {},
    featureRequest: state.feature_request
  })

  const cwd = state.worktree?.path ?? projectRoot
  const result = await runTrackedStage({
    stage: 'pr_writer',
    config,
    prompt,
    cwd,
    paths,
    state,
    logger,
    monitorState,
    monitorPort,
    timeoutMs: 10 * 60 * 1000
  })

  const title = String(result.structured.title ?? '').trim()
  const body = String(result.structured.body_markdown ?? '').trim()
  if (!title || !body) {
    throw new Error('pr_writer returned empty title or body')
  }

  const bodyPath = path.join(paths.runDir, 'pr-body-final.md')
  fs.writeFileSync(bodyPath, `${body}\n`, 'utf8')

  runCommand('gh', [
    'pr',
    'edit',
    String(state.pr.number),
    '--repo',
    state.github.repo,
    '--title',
    title,
    '--body-file',
    bodyPath
  ], { cwd })

  state.pr = {
    ...state.pr,
    title,
    body_path: bodyPath
  }
  saveRunState(paths, state)

  return ensureTagged(config, 'pr_writer', result.structured.tagged_message)
}

function narratorFallback(config, mode, targetStage, payload) {
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
    `Plan file (absolute path, readable from any cwd): ${planPath}`
  ].join('\n')
}

function buildEscalationPrompt(config, planPath, unresolvedJsonPath) {
  const tag = config.tags.escalation.replace('{tag_display}', config.models.escalation.tag_display)
  return [
    'You are the 4CO-OP Escalation stage.',
    'Resolve only the UNCLEAR checklist items to PASS or FAIL.',
    'Return only JSON with keys resolved and tagged_message.',
    `tagged_message must start exactly with "${tag}:"`,
    `Plan file (absolute path): ${planPath}`,
    `UNCLEAR input file (absolute path): ${unresolvedJsonPath}`
  ].join('\n')
}

function buildReviewerPrompt(config, planPath, reviewInputPath) {
  const tag = config.tags.reviewer.replace('{tag_display}', config.models.reviewer.tag_display)
  return [
    'You are the 4CO-OP PR Reviewer.',
    'Read the diff and the approved plan.',
    'Return only JSON with keys issues, tagged_message, body_markdown.',
    `tagged_message must start exactly with "${tag}:"`,
    `Plan file (absolute path): ${planPath}`,
    `PR diff file (absolute path): ${reviewInputPath}`
  ].join('\n')
}

function buildGatekeeperPrompt(config, planPath, reviewInputPath, issuesPath) {
  return [
    'You are the 4CO-OP Gatekeeper.',
    'Use the approved plan, the current PR diff, and the latest issue list.',
    'Return only the schema-compliant verdict JSON.',
    `Plan file (absolute path): ${planPath}`,
    `PR diff file (absolute path): ${reviewInputPath}`,
    `Issues file (absolute path): ${issuesPath}`
  ].join('\n')
}

function buildPrWriterPrompt(config, { planPath, diffPath, reviewPath, specSummaryPath, builder, featureRequest }) {
  const prWriterConfig = config.models.pr_writer ?? { tag_display: 'Sonnet 4.6' }
  const tagTemplate = config.tags.pr_writer ?? '[✍️ PR Writer | {tag_display}]'
  const tag = tagTemplate.replace('{tag_display}', prWriterConfig.tag_display)
  const builderSummary = [
    `commit ${String(builder?.commit_sha ?? '').slice(0, 12)}`,
    `build: ${builder?.build ?? '(not run)'}`,
    `tests: ${builder?.tests ?? '(not run)'}`,
    `lint: ${builder?.lint ?? '(not run)'}`
  ].join(' · ')

  return [
    'You are the 4CO-OP PR Writer.',
    'Read the approved plan, the final PR diff, the reviewer body, and the spec checker summary.',
    'Write a merge-ready PR title and body.',
    'Title: imperative mood, under 70 characters, no trailing period.',
    'Body: include Summary, Acceptance checklist (check items that passed the spec checker), Test plan, and optional Notes.',
    'Return only JSON with keys title, body_markdown, tagged_message.',
    `tagged_message must start exactly with "${tag}:"`,
    `Feature request: ${featureRequest}`,
    `Plan file (absolute path): ${planPath}`,
    `PR diff file (absolute path): ${diffPath}`,
    `Reviewer body file (absolute path): ${reviewPath}`,
    specSummaryPath ? `Spec summary file (absolute path): ${specSummaryPath}` : '',
    `Builder summary: ${builderSummary}`
  ].filter(Boolean).join('\n')
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

function suspendRun({ basePaths, paths, state, logger, feature, monitorPort, reason }) {
  const inFlight = readStageInFlight(paths)
  state.status = 'suspended'
  state.suspend_reason = reason
  state.suspended_at = new Date().toISOString()
  if (inFlight?.session_id) {
    state.resume_hint = {
      stage: inFlight.stage,
      session_id: inFlight.session_id,
      call_index: inFlight.call_index,
      tool: inFlight.tool
    }
  }
  saveRunState(paths, state)
  try {
    markLockSuspended(basePaths, reason)
  } catch {
    // If the lock is gone we still record the suspended state.
  }
  try {
    saveActiveSession(basePaths, {
      status: 'suspended',
      run_id: state.run_id,
      feature: feature ?? state.feature_request ?? '',
      suspend_reason: reason,
      log_file: logger?.filePath ?? state.log_file ?? null,
      monitor_port: monitorPort ?? state.monitor_port ?? null,
      suspended_at: state.suspended_at
    })
  } catch {}
  logger?.write?.('run_suspended', { reason })
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
    await saveActiveSessionAndNudge(basePaths, {
      status: 'awaiting_scaffold',
      feature,
      base: options.base ?? '',
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
    await saveActiveSessionAndNudge(basePaths, {
      status: 'awaiting_config_confirm',
      feature,
      base: options.base ?? '',
      proposal,
      created_at: new Date().toISOString()
    })
    return {
      status: 'awaiting_config_confirm',
      messages: [configProposal(config, proposal)]
    }
  }

  if (!feature) {
    await saveActiveSessionAndNudge(basePaths, {
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
  const resolvedBasePreference = (options.base || config.workflow?.default_base_branch || '').trim()
  state.base_branch_preference = resolvedBasePreference || null
  saveRunState(paths, state)
  acquireLock(basePaths, {
    run_id: runId,
    feature,
    started_at: new Date().toISOString()
  })
  await saveActiveSessionAndNudge(basePaths, {
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
        monitorPort: monitor.port,
        basePaths
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
        monitorPort: monitor.port,
        basePaths
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

    await saveActiveSessionAndNudge(basePaths, {
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
    if (error instanceof SuspendRequested) {
      suspendRun({
        basePaths,
        paths,
        state,
        logger,
        feature,
        monitorPort: monitor.port,
        reason: error.reason
      })
      try { await nudgeCockpit(basePaths) } catch {}
      return {
        status: 'suspended',
        messages: [
          ...messages,
          withTag(config, 'meta', `Run suspended (${error.reason}). Use /4co-op resume to continue.`)
        ],
        run_id: runId
      }
    }
    finalizeRun(paths, state, logger, 'halted')
    await clearActiveSessionAndNudge(basePaths)
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
    await clearActiveSessionAndNudge(basePaths)
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

  await saveActiveSessionAndNudge(basePaths, {
    status: 'running',
    run_id: activeSession.run_id,
    feature: activeSession.feature ?? state.feature_request ?? '',
    log_file: logger.filePath,
    monitor_port: monitor.port,
    created_at: activeSession.created_at ?? new Date().toISOString()
  })

  try {
    try {
      const mode = config.workspace?.mode ?? 'in_place'
      state.worktree = mode === 'worktree'
        ? ensureWorktree(projectRoot, state.feature_request, state.base_branch_preference ?? null)
        : ensureInPlaceBranch(projectRoot, state.feature_request, state.base_branch_preference ?? null)
    } catch (worktreeError) {
      if (state.base_branch_preference) {
        const { branches } = listBaseBranchCandidates(projectRoot)
        await clearActiveSessionAndNudge(basePaths)
        finalizeRun(paths, state, logger, 'halted')
        return {
          status: 'halted',
          messages: [
            baseBranchInvalid(config, state.base_branch_preference, branches),
            halted(config, worktreeError.message)
          ]
        }
      }
      throw worktreeError
    }
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
    })}\n\n${buildSpecPrompt(config, paths.planFile)}`
    const specResult = await runSpecCheckerWithRecovery({
      config,
      basePrompt: specPrompt,
      cwd: state.worktree.path,
      paths,
      state,
      logger,
      monitorState,
      monitorPort: monitor.port
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
      })}\n\n${buildEscalationPrompt(config, paths.planFile, unresolvedPath)}`
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
      await clearActiveSessionAndNudge(basePaths)
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
    })}\n\n${buildReviewerPrompt(config, paths.planFile, reviewInputPath)}`
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
      const gatekeeperPrompt = buildGatekeeperPrompt(config, paths.planFile, paths.reviewerInputFile, issueFilePath)
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

      try {
        const prWriterMessage = await runPrWriterAndUpdatePr({
          config,
          paths,
          state,
          logger,
          monitorState,
          monitorPort: monitor.port,
          projectRoot
        })
        if (prWriterMessage) messages.push(prWriterMessage)
      } catch (error) {
        logger.write('pr_writer_skipped', { reason: error.message })
      }

      messages.push(mergeReadyHint(config))
    }

    finalizeRun(paths, state, logger, verdict?.verdict === 'APPROVE' ? 'approved' : 'handed_off')
    await clearActiveSessionAndNudge(basePaths)
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
    if (error instanceof SuspendRequested) {
      suspendRun({
        basePaths,
        paths,
        state,
        logger,
        feature: activeSession?.feature ?? state.feature_request ?? '',
        monitorPort: monitor.port,
        reason: error.reason
      })
      try { await nudgeCockpit(basePaths) } catch {}
      return {
        status: 'suspended',
        messages: [withTag(config, 'meta', `Run suspended (${error.reason}). Use /4co-op resume to continue.`)]
      }
    }
    finalizeRun(paths, state, logger, 'halted')
    await clearActiveSessionAndNudge(basePaths)
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
    await clearActiveSessionAndNudge(basePaths)
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
    await clearActiveSessionAndNudge(basePaths)
    return {
      status: 'rejected',
      messages: [halted(config, 'plan rejected by user')]
    }
  }

  await clearActiveSessionAndNudge(basePaths)
  return {
    status: 'rejected',
    messages: [nothingChanged(config)]
  }
}

async function handleProvideFeature(projectRoot, feature) {
  const activeSession = loadActiveSession(getRuntimePaths(projectRoot))
  const nextFeature = feature || activeSession?.feature || ''
  return await handleStart(projectRoot, nextFeature, { base: activeSession?.base ?? '' })
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
    await clearActiveSessionAndNudge(paths)
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
    return {
      status: 'awaiting_config_confirm',
      messages: [configHelp(config)]
    }
  }

  writeProjectCommands(paths, parsed.commands)
  await clearActiveSessionAndNudge(paths)
  return await handleStart(projectRoot, active.feature ?? '', { base: active.base ?? '' })
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
      paths.planFile,
      reviewInputPath,
      commentFilePath
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
      timeoutMs: 60 * 60 * 1000,
      basePaths
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
        paths.planFile,
        paths.reviewerInputFile,
        issueFilePath
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
    if (state.worktree.mode === 'in_place' || state.worktree.path === projectRoot) {
      // In-place runs don't create a sibling worktree — nothing to sweep.
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

function handleListBranches(projectRoot) {
  const config = loadConfig(projectRoot)
  const { branches, default: def } = listBaseBranchCandidates(projectRoot)
  const configuredDefault = config.workflow?.default_base_branch?.trim() || def
  return {
    status: 'ok',
    messages: [branchList(config, branches, configuredDefault)]
  }
}

function handleSetBase(projectRoot, branch) {
  const config = loadConfig(projectRoot)
  const trimmed = (branch || '').trim()
  if (!trimmed) {
    return {
      status: 'halted',
      messages: [halted(config, 'set-base requires a branch name, e.g. /4co-op set-base develop')]
    }
  }
  try {
    detectBaseBranch(projectRoot, trimmed)
  } catch (error) {
    const { branches } = listBaseBranchCandidates(projectRoot)
    return {
      status: 'halted',
      messages: [
        baseBranchInvalid(config, trimmed, branches),
        halted(config, error.message)
      ]
    }
  }

  const paths = getRuntimePaths(projectRoot)
  ensureRuntimeDirs(paths)
  const existing = readJsonIfExists(paths.projectConfigOverridePath) ?? {}
  existing.workflow = { ...(existing.workflow ?? {}), default_base_branch: trimmed }
  writeJson(paths.projectConfigOverridePath, existing)

  return {
    status: 'ok',
    messages: [baseBranchSet(config, trimmed)]
  }
}

async function handleOpenCockpit(projectRoot) {
  const config = loadConfig(projectRoot)
  const basePaths = getRuntimePaths(projectRoot)
  ensureRuntimeDirs(basePaths)

  if (!isProjectScaffoldComplete(projectRoot)) {
    scaffoldProject(projectRoot)
  }

  // Build a minimal monitor state so the cockpit renders stage chrome immediately.
  const monitorState = createMonitorState(config)
  const monitor = await ensureMonitor(basePaths, config, serializeMonitorState(monitorState))

  return {
    status: 'ok',
    messages: [
      withTag(config, 'meta', `cockpit open at http://127.0.0.1:${monitor.port}/ — describe a feature in the Start form to kick off a run.`)
    ]
  }
}

function handleStatus(projectRoot) {
  const config = loadConfig(projectRoot)
  const basePaths = getRuntimePaths(projectRoot)
  const active = loadActiveSession(basePaths)
  const lock = readLock(basePaths)
  if (!active) {
    return {
      status: 'idle',
      messages: [withTag(config, 'meta', 'No active run.')]
    }
  }
  const paths = active.run_id ? getRuntimePaths(projectRoot, active.run_id) : null
  const state = paths ? readJsonIfExists(paths.stateFile) : null
  const inFlight = paths ? readStageInFlight(paths) : null
  const summary = [
    `status: ${active.status ?? state?.status ?? 'unknown'}`,
    active.run_id ? `run_id: ${active.run_id}` : null,
    state?.suspend_reason ? `suspend_reason: ${state.suspend_reason}` : null,
    inFlight ? `in_flight_stage: ${inFlight.stage} (session ${inFlight.session_id ?? 'n/a'})` : null,
    lock?.pid ? `orchestrator_pid: ${lock.pid}` : null,
    lock?.heartbeat_at ? `last_heartbeat: ${lock.heartbeat_at}` : null
  ].filter(Boolean).join('\n')
  return {
    status: 'ok',
    messages: [withTag(config, 'meta', summary)]
  }
}

async function handlePause(projectRoot) {
  const config = loadConfig(projectRoot)
  const basePaths = getRuntimePaths(projectRoot)
  const lock = readLock(basePaths)
  if (!lock || !lock.pid || lock.suspended) {
    return {
      status: 'noop',
      messages: [withTag(config, 'meta', lock?.suspended ? 'Run already suspended.' : 'No active run to pause.')]
    }
  }
  try {
    process.kill(lock.pid, 'SIGTERM')
  } catch (error) {
    return {
      status: 'halted',
      messages: [halted(config, `could not signal orchestrator pid ${lock.pid}: ${error.message}`)]
    }
  }
  return {
    status: 'pausing',
    messages: [withTag(config, 'meta', `Suspend signal sent to pid ${lock.pid}. Use /4co-op status to confirm, /4co-op resume to continue.`)]
  }
}

async function handleResume(projectRoot) {
  const config = loadConfig(projectRoot)
  const basePaths = getRuntimePaths(projectRoot)
  const active = loadActiveSession(basePaths)
  if (!active || active.status !== 'suspended' || !active.run_id) {
    return {
      status: 'halted',
      messages: [halted(config, 'there is no suspended run to resume')]
    }
  }
  const paths = getRuntimePaths(projectRoot, active.run_id)
  const state = readJsonIfExists(paths.stateFile)
  if (!state) {
    await clearActiveSessionAndNudge(basePaths)
    return {
      status: 'halted',
      messages: [halted(config, 'suspended run state missing; cannot resume')]
    }
  }
  try { markLockResumed(basePaths) } catch {}
  markStateResumed(paths, 'running')

  const resumeMessage = withTag(
    config,
    'meta',
    `Resuming run ${active.run_id}${state.resume_hint?.stage ? ` at ${state.resume_hint.stage}` : ''}.`
  )

  if (!state.plan?.path) {
    const result = await handleStart(projectRoot, state.feature_request ?? active.feature ?? '', {
      bypassQueue: true,
      base: state.base_branch_preference ?? ''
    })
    return {
      status: result.status,
      messages: [resumeMessage, ...result.messages],
      run_id: result.run_id
    }
  }

  const result = await continueApprovedRun(projectRoot, {
    ...active,
    status: 'running'
  })
  return {
    status: result.status,
    messages: [resumeMessage, ...result.messages]
  }
}

function installSuspendSignalHandlers() {
  let lastSigintAt = 0
  const onSignal = reason => () => {
    const now = Date.now()
    if (reason === SUSPEND_REASON.user && now - lastSigintAt < 2000) {
      // Double Ctrl+C escape hatch — let Node exit hard.
      process.exit(130)
    }
    lastSigintAt = now
    requestSuspend(reason)
  }
  process.on('SIGINT', onSignal(SUSPEND_REASON.user))
  process.on('SIGTERM', onSignal(SUSPEND_REASON.user))
}

async function main() {
  const projectRoot = findProjectRoot(process.cwd())
  const args = parseArgs(process.argv.slice(2))
  const basePaths = getRuntimePaths(projectRoot)
  ensureRuntimeDirs(basePaths)

  const suspendableCommands = new Set(['start', 'continue-active', 'resume', 'check-comment'])
  if (suspendableCommands.has(args.command)) {
    installSuspendSignalHandlers()
  }

  let result
  if (args.command === 'start') {
    result = await handleStart(projectRoot, args.feature, { base: args.base })
  } else if (args.command === 'pause') {
    result = await handlePause(projectRoot)
  } else if (args.command === 'resume') {
    result = await handleResume(projectRoot)
  } else if (args.command === 'status') {
    result = handleStatus(projectRoot)
  } else if (args.command === 'check-comment') {
    result = await handleCheckComment(projectRoot)
  } else if (args.command === 'list-branches') {
    result = handleListBranches(projectRoot)
  } else if (args.command === 'set-base') {
    result = handleSetBase(projectRoot, args.base)
  } else if (args.command === 'continue-active') {
    const activeSession = loadActiveSession(basePaths)
    if (!activeSession) {
      result = {
        status: 'halted',
        messages: [halted(loadConfig(projectRoot), 'there is no active run')]
      }
    } else if (activeSession.status === 'awaiting_scaffold') {
      scaffoldProject(projectRoot)
      await clearActiveSessionAndNudge(basePaths)
      result = await handleStart(projectRoot, activeSession.feature ?? '', { base: activeSession.base ?? '' })
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
  } else if (args.command === 'open') {
    result = await handleOpenCockpit(projectRoot)
  } else {
    result = {
      status: 'halted',
      messages: [halted(loadConfig(projectRoot), `unknown command: ${args.command}`)]
    }
  }

  printResult(result.status, result.messages, result.run_id ? { run_id: result.run_id } : {})
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const projectRoot = findProjectRoot(process.cwd())
    const config = loadConfig(projectRoot)
    printResult('halted', [halted(config, error.message)])
    process.exitCode = 1
  })
}
