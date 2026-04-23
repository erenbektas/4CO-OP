import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { URL } from 'node:url'
import { getRuntimePaths, resolveBundledPath, writeJson } from './4coop-paths.mjs'
import { deepMerge, getDefaultConfig, loadConfig, validateConfig } from './4coop-config.mjs'

function parseArgs(argv) {
  const args = { port: 0, projectRoot: null }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--port') {
      args.port = Number(argv[index + 1] ?? 0)
      index += 1
    } else if (current === '--project-root') {
      args.projectRoot = String(argv[index + 1] ?? '') || null
      index += 1
    }
  }
  return args
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(JSON.stringify(payload))
}

function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  })
  response.end(text)
}

function isLoopbackRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
}

function updateStateFromPayload(parsed) {
  const previousStartedAt = state.started_at ?? new Date().toISOString()
  if (parsed.state) {
    state = parsed.state
  } else {
    state = parsed
  }
  state.started_at = state.started_at ?? previousStartedAt
  state.updated_at = state.updated_at ?? new Date().toISOString()
}

function getStageDetail(stageName) {
  const stage = state.rows?.find?.(row => row.key === stageName)
  return stage?.last_call ?? null
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function safeReadText(filePath, { tailBytes = null } = {}) {
  try {
    if (!fs.existsSync(filePath)) return null
    if (tailBytes == null) {
      return fs.readFileSync(filePath, 'utf8')
    }
    const stat = fs.statSync(filePath)
    const start = Math.max(0, stat.size - tailBytes)
    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function runGit(cwd, args, timeoutMs = 10000) {
  return new Promise(resolve => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > 2_000_000) {
        try { child.kill('SIGTERM') } catch {}
      }
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
  })
}

function parseNameStatus(raw) {
  return (raw || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split(/\s+/)
      return { status, path: rest.join(' ') }
    })
}

function mergeChanges(committed, unstaged) {
  const out = [...committed]
  for (const entry of unstaged) {
    if (!out.some(item => item.path === entry.path)) {
      out.push(entry)
    }
  }
  return out
}

function splitDiffByFile(raw) {
  if (!raw) return []
  const out = []
  const lines = raw.split('\n')
  let current = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) out.push(current)
      // `diff --git a/<path> b/<path>` — prefer b/<path> for new filename.
      const match = /diff --git a\/(.+) b\/(.+)/.exec(line)
      const filePath = match ? match[2] : null
      current = { path: filePath, diff: `${line}\n` }
      continue
    }
    if (current) {
      current.diff += `${line}\n`
    }
  }
  if (current) out.push(current)
  return out
}

function computeDiffStats(diff) {
  if (!diff) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function getRunsDir() {
  if (!projectRoot) return null
  return path.join(projectRoot, '.4co-op', 'runs')
}

function listRunSummaries() {
  const runsDir = getRunsDir()
  if (!runsDir || !fs.existsSync(runsDir)) return []

  const activeSession = projectRoot
    ? safeReadJson(path.join(projectRoot, '.4co-op', '4coop-active.json'))
    : null
  const activeRunId = activeSession?.run_id ?? null

  const entries = fs.readdirSync(runsDir).filter(name => {
    return fs.statSync(path.join(runsDir, name)).isDirectory()
  })

  return entries
    .map(name => {
      const statePath = path.join(runsDir, name, 'state.json')
      const runState = safeReadJson(statePath)
      const mtime = fs.existsSync(statePath)
        ? fs.statSync(statePath).mtimeMs
        : fs.statSync(path.join(runsDir, name)).mtimeMs
      return {
        run_id: name,
        feature: runState?.feature_request ?? '',
        status: runState?.status ?? 'unknown',
        pr_number: runState?.pr?.number ?? null,
        pr_url: runState?.pr?.url ?? null,
        created_at: runState?.created_at ?? null,
        updated_at: new Date(mtime).toISOString(),
        worktree_path: runState?.worktree?.path ?? null,
        branch: runState?.worktree?.branch ?? null,
        base: runState?.worktree?.base ?? null,
        active: name === activeRunId
      }
    })
    .sort((left, right) => {
      return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    })
}

function resolveRunPaths(runId) {
  if (!projectRoot) return null
  const safeRunId = String(runId ?? '').replace(/[^A-Za-z0-9_\-.]/g, '')
  if (!safeRunId || safeRunId !== runId) return null
  const runDir = path.join(projectRoot, '.4co-op', 'runs', safeRunId)
  if (!fs.existsSync(runDir)) return null
  return {
    runDir,
    stateFile: path.join(runDir, 'state.json'),
    planFile: path.join(runDir, 'plan.md'),
    reviewFile: path.join(runDir, 'review.md')
  }
}

function buildCockpitPayload() {
  const activeSession = projectRoot
    ? safeReadJson(path.join(projectRoot, '.4co-op', '4coop-active.json'))
    : null
  const activeRunId = activeSession?.run_id ?? null
  const activeRunState = activeRunId
    ? safeReadJson(path.join(projectRoot, '.4co-op', 'runs', activeRunId, 'state.json'))
    : null
  return {
    project_root: projectRoot,
    active_session: activeSession,
    active_run: activeRunState,
    dispatch_busy: dispatchBusy,
    dispatch_last_command: lastDispatchCommand,
    runs: listRunSummaries().slice(0, 25)
  }
}

function parseOrchestratorOutput(stdout) {
  const trimmed = (stdout ?? '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    for (let index = trimmed.length; index > 0; index -= 1) {
      if (trimmed[index - 1] === '}') {
        for (let start = 0; start < index; start += 1) {
          if (trimmed[start] === '{') {
            try {
              return JSON.parse(trimmed.slice(start, index))
            } catch {
              continue
            }
          }
        }
        break
      }
    }
    return null
  }
}

function runOrchestrator(command, extraArgs) {
  return new Promise(resolve => {
    if (!projectRoot) {
      resolve({
        ok: false,
        error: 'project root is not configured for this monitor',
        exit_code: -1
      })
      return
    }

    const orchestratorPath = resolveBundledPath('scripts', '4coop-orchestrator.mjs')
    const args = [orchestratorPath, command, ...extraArgs]
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' }
    })

    let stdout = ''
    let stderr = ''
    const MAX_OUTPUT = 4_000_000
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(-MAX_OUTPUT)
      }
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(-MAX_OUTPUT)
      }
    })
    child.on('error', error => {
      resolve({
        ok: false,
        error: error.message,
        exit_code: -1,
        stdout,
        stderr
      })
    })
    child.on('close', code => {
      const result = parseOrchestratorOutput(stdout)
      if (result) {
        resolve({
          ok: true,
          exit_code: code ?? 0,
          status: result.status ?? 'unknown',
          messages: Array.isArray(result.messages) ? result.messages : [],
          run_id: result.run_id ?? null,
          raw: result
        })
      } else {
        resolve({
          ok: false,
          exit_code: code ?? -1,
          error: stderr.trim() || stdout.trim() || `orchestrator exited with code ${code}`,
          stdout,
          stderr
        })
      }
    })
  })
}

function buildDispatchArgs(command, body) {
  const feature = String(body.feature ?? '').trim()
  const answer = String(body.answer ?? '').trim()
  const base = String(body.base ?? '').trim()

  switch (command) {
    case 'start':
      return feature ? ['--feature', feature, ...(base ? ['--base', base] : [])] : []
    case 'check-comment':
      return []
    case 'continue-active':
      return []
    case 'reject-active':
      return []
    case 'provide-feature':
      return feature ? ['--feature', feature] : []
    case 'config-confirm':
      return answer ? ['--answer', answer] : []
    case 'list-branches':
      return []
    case 'set-base':
      return base ? ['--base', base] : []
    case 'pause':
      return []
    case 'resume':
      return []
    case 'status':
      return []
    default:
      return null
  }
}

const args = parseArgs(process.argv.slice(2))
const clientHtml = fs.readFileSync(resolveBundledPath('scripts', '4coop-monitor-client.html'), 'utf8')
const clients = new Set()
let state = {
  started_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  active_stage: 'idle',
  rows: []
}
let projectRoot = args.projectRoot && fs.existsSync(args.projectRoot) ? args.projectRoot : null
let dispatchBusy = false
let lastDispatchCommand = null

function broadcast() {
  const payload = [
    `event: metrics`,
    `data: ${JSON.stringify(state)}`,
    '',
    `event: active_stage`,
    `data: ${JSON.stringify({ active_stage: state.active_stage })}`,
    '',
    `data: ${JSON.stringify(state)}`,
    ''
  ].join('\n')
  for (const response of clients) {
    response.write(payload)
  }
}

function broadcastEvent(eventName, payload) {
  const lines = [
    `event: ${eventName}`,
    `data: ${JSON.stringify(payload)}`,
    '',
    ''
  ].join('\n')
  for (const response of clients) {
    response.write(lines)
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(clientHtml)
    return
  }

  if (request.method === 'GET' && url.pathname === '/state') {
    sendJson(response, 200, state)
    return
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === 'GET' && url.pathname === '/ping') {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify(state)}\n\n`)
    response.write(`event: cockpit\ndata: ${JSON.stringify(buildCockpitPayload())}\n\n`)
    clients.add(response)
    request.on('close', () => {
      clients.delete(response)
    })
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/stage/')) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 3 && parts[2] === 'detail') {
      sendJson(response, 200, {
        ok: true,
        detail: getStageDetail(parts[1])
      })
      return
    }
  }

  if (request.method === 'GET' && url.pathname === '/cockpit') {
    sendJson(response, 200, buildCockpitPayload())
    return
  }

  if (request.method === 'GET' && url.pathname === '/runs') {
    sendJson(response, 200, { runs: listRunSummaries() })
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/runs/')) {
    const parts = url.pathname.split('/').filter(Boolean)
    const runId = parts[1]
    const sub = parts[2] ?? null
    const runPaths = resolveRunPaths(runId)
    if (!runPaths) {
      sendJson(response, 404, { ok: false, error: 'run not found' })
      return
    }

    if (!sub) {
      const runState = safeReadJson(runPaths.stateFile)
      if (!runState) {
        sendJson(response, 404, { ok: false, error: 'state.json missing' })
        return
      }
      sendJson(response, 200, { run_id: runId, state: runState })
      return
    }

    if (sub === 'plan') {
      const planText = safeReadText(runPaths.planFile)
      sendJson(response, 200, {
        ok: true,
        exists: planText != null,
        content: planText ?? ''
      })
      return
    }

    if (sub === 'review') {
      const reviewText = safeReadText(runPaths.reviewFile)
      sendJson(response, 200, {
        ok: true,
        exists: reviewText != null,
        content: reviewText ?? ''
      })
      return
    }

    if (sub === 'diff') {
      const runState = safeReadJson(runPaths.stateFile)
      const worktreePath = runState?.worktree?.path ?? null
      const base = runState?.worktree?.base ?? 'main'
      if (!worktreePath || !fs.existsSync(worktreePath)) {
        sendJson(response, 200, {
          ok: true,
          available: false,
          reason: 'workspace not yet created',
          diff: '',
          diff_by_file: [],
          unstaged_diff: '',
          commits: '',
          changes: []
        })
        return
      }
      const [committedDiff, unstagedDiff, logResult, statusResult, unstagedStatus] = await Promise.all([
        runGit(worktreePath, ['diff', `${base}...HEAD`]),
        runGit(worktreePath, ['diff', 'HEAD']),
        runGit(worktreePath, ['log', `${base}..HEAD`, '--oneline', '--stat']),
        runGit(worktreePath, ['diff', `${base}...HEAD`, '--name-status']),
        runGit(worktreePath, ['diff', 'HEAD', '--name-status'])
      ])

      const changes = parseNameStatus(statusResult.stdout)
      const unstagedChanges = parseNameStatus(unstagedStatus.stdout).map(entry => ({ ...entry, unstaged: true }))
      const allChanges = mergeChanges(changes, unstagedChanges)
      const committedByFile = splitDiffByFile(committedDiff.stdout || '')
      const unstagedByFile = splitDiffByFile(unstagedDiff.stdout || '')
      const diffByFile = allChanges.map(change => {
        const committed = committedByFile.find(entry => entry.path === change.path)
        const unstaged = unstagedByFile.find(entry => entry.path === change.path)
        const chunks = [committed?.diff, unstaged?.diff].filter(Boolean).join('\n')
        const stats = computeDiffStats(chunks)
        return {
          path: change.path,
          status: change.status,
          unstaged: change.unstaged === true,
          additions: stats.additions,
          deletions: stats.deletions,
          diff: chunks
        }
      })

      sendJson(response, 200, {
        ok: true,
        available: true,
        base,
        branch: runState?.worktree?.branch ?? null,
        worktree: worktreePath,
        diff: committedDiff.stdout || committedDiff.stderr || '',
        unstaged_diff: unstagedDiff.stdout || '',
        diff_by_file: diffByFile,
        commits: logResult.stdout || '',
        changes: allChanges
      })
      return
    }

    if (sub === 'log') {
      const runState = safeReadJson(runPaths.stateFile)
      const logFile = runState?.log_file ?? null
      if (!logFile) {
        sendJson(response, 200, { ok: true, exists: false, content: '' })
        return
      }
      const absLog = path.isAbsolute(logFile) ? logFile : path.join(projectRoot, logFile)
      const content = safeReadText(absLog, { tailBytes: 64 * 1024 })
      const narratorEntries = Array.isArray(runState?.narrator_log) ? runState.narrator_log : []
      sendJson(response, 200, {
        ok: true,
        exists: content != null,
        content: content ?? '',
        narrator_log: narratorEntries
      })
      return
    }

    if (sub === 'live') {
      const livePath = path.join(runPaths.runDir, 'live.ndjson')
      if (!fs.existsSync(livePath)) {
        sendJson(response, 200, { ok: true, exists: false, events: [] })
        return
      }
      const rawTail = Number(url.searchParams.get('tail') ?? 500)
      const tailLines = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 5000) : 500
      const raw = safeReadText(livePath) ?? ''
      const lines = raw.split(/\r?\n/).filter(Boolean)
      const sliced = lines.slice(-tailLines)
      const events = []
      for (const line of sliced) {
        try {
          events.push(JSON.parse(line))
        } catch {
          // skip malformed
        }
      }
      sendJson(response, 200, { ok: true, exists: true, events })
      return
    }

    if (sub === 'file') {
      const requestedPath = url.searchParams.get('path') ?? ''
      if (!/^[A-Za-z0-9._-]+\.(txt|md|json|ndjson)$/.test(requestedPath)) {
        sendJson(response, 400, { ok: false, error: 'invalid file name' })
        return
      }
      const resolvedPath = path.resolve(runPaths.runDir, requestedPath)
      const rel = path.relative(runPaths.runDir, resolvedPath)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        sendJson(response, 400, { ok: false, error: 'path escapes run directory' })
        return
      }
      if (!fs.existsSync(resolvedPath)) {
        sendJson(response, 404, { ok: false, error: 'file not found' })
        return
      }
      const content = safeReadText(resolvedPath)
      sendJson(response, 200, {
        ok: true,
        path: requestedPath,
        content: content ?? ''
      })
      return
    }

    sendJson(response, 404, { ok: false, error: 'unknown sub-resource' })
    return
  }

  if (!isLoopbackRequest(request) && request.method === 'POST') {
    sendJson(response, 403, { ok: false, error: 'Loopback requests only' })
    return
  }

  if (request.method === 'POST' && (url.pathname === '/state' || url.pathname === '/stage-update')) {
    try {
      const body = await readBody(request)
      const parsed = JSON.parse(body)
      updateStateFromPayload(parsed)
      broadcast()
      broadcastEvent('cockpit', buildCockpitPayload())
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/cockpit/refresh') {
    broadcastEvent('cockpit', buildCockpitPayload())
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === 'POST' && url.pathname === '/stage-event') {
    try {
      const body = await readBody(request)
      const parsed = JSON.parse(body || '{}')
      broadcastEvent('stage_event', parsed)
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/bind') {
    try {
      const body = await readBody(request)
      const parsed = JSON.parse(body || '{}')
      const incoming = String(parsed.project_root ?? '')
      if (incoming && fs.existsSync(incoming)) {
        projectRoot = incoming
        broadcastEvent('cockpit', buildCockpitPayload())
        sendJson(response, 200, { ok: true, project_root: projectRoot })
      } else {
        sendJson(response, 400, { ok: false, error: 'project_root missing or does not exist' })
      }
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/active') {
    try {
      const body = await readBody(request)
      const parsed = JSON.parse(body)
      state.active_stage = parsed.active_stage ?? parsed.stage ?? state.active_stage
      state.updated_at = new Date().toISOString()
      broadcast()
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/dispatch') {
    if (!projectRoot) {
      sendJson(response, 400, { ok: false, error: 'monitor is not bound to a project root' })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(request) || '{}')
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `invalid JSON body: ${error.message}` })
      return
    }
    const command = String(body.command ?? '').trim()
    const extraArgs = buildDispatchArgs(command, body)
    if (extraArgs === null) {
      sendJson(response, 400, { ok: false, error: `unknown command: ${command}` })
      return
    }

    dispatchBusy = true
    lastDispatchCommand = {
      command,
      started_at: new Date().toISOString(),
      feature: body.feature ?? null,
      answer: body.answer ?? null,
      base: body.base ?? null
    }
    broadcastEvent('cockpit', buildCockpitPayload())
    broadcastEvent('dispatch', { phase: 'started', command })

    // Fire-and-forget: orchestrator runs in the background, cockpit tracks
    // progress via state.json + /cockpit/refresh nudges from the orchestrator.
    // The HTTP response returns immediately so the UI stays responsive.
    runOrchestrator(command, extraArgs)
      .then(result => {
        dispatchBusy = false
        lastDispatchCommand = {
          ...lastDispatchCommand,
          ended_at: new Date().toISOString(),
          ok: result.ok,
          status: result.status ?? null
        }
        broadcastEvent('cockpit', buildCockpitPayload())
        broadcastEvent('dispatch', {
          phase: 'completed',
          command,
          ok: result.ok,
          status: result.status ?? null,
          messages: Array.isArray(result.messages)
            ? result.messages
            : (result.error ? [`[4CO-OP]: ${result.error}`] : [])
        })
      })
      .catch(error => {
        dispatchBusy = false
        broadcastEvent('cockpit', buildCockpitPayload())
        broadcastEvent('dispatch', {
          phase: 'completed',
          command,
          ok: false,
          status: null,
          messages: [`[4CO-OP]: ${error.message}`]
        })
      })

    sendJson(response, 202, { ok: true, status: 'dispatched', command })
    return
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    const payload = { ok: true, project_root: projectRoot }
    if (projectRoot) {
      try {
        const scaffoldFile = path.join(projectRoot, '.4co-op', 'config.json')
        payload.scaffolded = fs.existsSync(scaffoldFile)
      } catch {
        payload.scaffolded = false
      }
      try {
        const branch = (await runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)).stdout.trim()
        const status = (await runGit(projectRoot, ['status', '--porcelain'], 5000)).stdout.trim()
        payload.git = { branch, clean: status.length === 0 }
      } catch {
        payload.git = null
      }
    }
    sendJson(response, 200, payload)
    return
  }

  if (request.method === 'GET' && url.pathname === '/config') {
    if (!projectRoot) {
      sendJson(response, 400, { ok: false, error: 'monitor is not bound to a project root' })
      return
    }
    try {
      const merged = loadConfig(projectRoot)
      const overridePath = getRuntimePaths(projectRoot).projectConfigOverridePath
      const override = safeReadJson(overridePath)
      sendJson(response, 200, { ok: true, config: merged, override })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error.message })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/config/models') {
    if (!projectRoot) {
      sendJson(response, 400, { ok: false, error: 'monitor is not bound to a project root' })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(request) || '{}')
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `invalid JSON body: ${error.message}` })
      return
    }
    const incomingModels = body.models
    if (!incomingModels || typeof incomingModels !== 'object' || Array.isArray(incomingModels)) {
      sendJson(response, 400, { ok: false, error: 'models object required' })
      return
    }

    // Scaffolder writes the full bundled config.json to .4co-op/config.json and
    // loadConfig merges bundled-over-override, so partial override files get
    // clobbered. Build the full merged config first, patch, then write.
    const overridePath = getRuntimePaths(projectRoot).projectConfigOverridePath
    let effective
    try {
      effective = loadConfig(projectRoot)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: `failed to load current config: ${error.message}` })
      return
    }

    effective = deepMerge(effective, { models: incomingModels })
    if (body.tags && typeof body.tags === 'object' && !Array.isArray(body.tags)) {
      effective = deepMerge(effective, { tags: body.tags })
    }

    const errors = validateConfig(effective)
    if (errors.length > 0) {
      sendJson(response, 400, { ok: false, error: 'invalid config', details: errors })
      return
    }

    try {
      writeJson(overridePath, effective)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error.message })
      return
    }

    sendJson(response, 200, { ok: true, config: effective })
    return
  }

  if (request.method === 'POST' && url.pathname === '/shutdown') {
    sendJson(response, 200, { ok: true })
    for (const client of clients) {
      client.end()
    }
    clients.clear()
    server.close()
    return
  }

  sendJson(response, 404, { ok: false, error: 'Not found' })
})

server.listen(args.port, '127.0.0.1')
