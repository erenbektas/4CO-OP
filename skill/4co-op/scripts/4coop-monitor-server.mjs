import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { URL } from 'node:url'
import { resolveBundledPath, RUNTIME_DIRNAME } from './4coop-paths.mjs'

function parseArgs(argv) {
  const args = { port: 0, errorDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--port') {
      args.port = Number(argv[index + 1] ?? 0)
      index += 1
    } else if (current === '--error-dir') {
      args.errorDir = argv[index + 1] ?? null
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

const args = parseArgs(process.argv.slice(2))
const clientHtml = fs.readFileSync(resolveBundledPath('scripts', '4coop-monitor-client.html'), 'utf8')
const clients = new Set()
let state = {
  started_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  active_stage: 'idle',
  rows: []
}

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
      sendJson(response, 200, { ok: true })
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

// One-shot error handler for listen-time failures only.
// Removed on successful listen so transient post-listen socket errors
// (e.g. ECONNRESET) don't kill the running server.
function handleListenError(err) {
  // Write failure details to a state file so the parent process (which spawns
  // with stdio:'ignore') can surface the real cause instead of a generic
  // "did not become healthy" timeout.
  const failure = {
    code: err.code || 'UNKNOWN',
    message: err?.message ?? String(err),
    port: args.port,
    timestamp: new Date().toISOString(),
  }

  // Use --error-dir CLI arg if provided; otherwise fall back to cwd + RUNTIME_DIRNAME
  const errorDir = args.errorDir
    ?? path.join(process.cwd(), RUNTIME_DIRNAME)
  const errorLogFile = path.join(errorDir, '.monitor-listen-error.json')
  const errorTmpFile = errorLogFile + '.tmp'

  try {
    fs.mkdirSync(errorDir, { recursive: true })
    // Atomic write: tmp -> rename so reader never sees partial JSON
    fs.writeFileSync(errorTmpFile, JSON.stringify(failure, null, 2), 'utf8')
    fs.renameSync(errorTmpFile, errorLogFile)
  } catch { /* best-effort; console.error below is secondary */ }

  console.error('[monitor] listen failed on port', args.port, ':', failure.code)

  // Close server to release handles, then exit via setImmediate so stderr drains
  try { server.close() } catch { /* already closed */ }
  setImmediate(() => { process.exit(1) })
}

server.on('error', handleListenError)

server.once('listening', () => {
  // Listen succeeded — remove the one-shot handler so post-listen errors
  // (e.g. ECONNRESET) don't kill the running server.
  server.removeListener('error', handleListenError)
})

server.listen(args.port, '127.0.0.1')
