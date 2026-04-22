import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_SCRIPT = path.resolve(HERE, '..', 'skill', '4co-op', 'scripts', '4coop-monitor-server.mjs')

async function findOpenPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

function mkRunState(runId, { feature, status, pr = null, worktree = null } = {}) {
  return {
    run_id: runId,
    feature_request: feature,
    created_at: new Date().toISOString(),
    status,
    plan: { path: null, acceptance_checklist: [], file_structure_hint: [], definition_of_done: '' },
    worktree: worktree ?? { path: null, branch: null, base: null },
    builder: { codex_session_id: null, commit_sha: null, files_changed: [], tests_added: [], build: null, tests: null, lint: null },
    spec_check: { results: [], escalated_ids: [] },
    github: { repo: 'acme/widgets', url: 'https://github.com/acme/widgets' },
    pr,
    reviewer: { issues: [] },
    fixer: { iterations: 0, commits: [] },
    gatekeeper: { iteration: 0, verdict: null, severity: null, issues: [] },
    narrator_log: [{ timestamp: '2025-04-22T00:00:00Z', message: '[4CO-OP]: ready' }],
    metrics: null
  }
}

async function startServer(projectRoot) {
  const port = await findOpenPort()
  const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--project-root', projectRoot], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const healthy = await waitFor(`http://127.0.0.1:${port}/ping`)
  if (!healthy) {
    child.kill('SIGTERM')
    throw new Error('server did not come up')
  }
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    stop() {
      child.kill('SIGTERM')
    }
  }
}

test('cockpit endpoint reports project root and run list', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-cockpit-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const runId = '4coop-2025-01-01-120000-demo'
  const runDir = path.join(tmp, '.4co-op', 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(runDir, 'state.json'),
    JSON.stringify(mkRunState(runId, { feature: 'add dark mode', status: 'awaiting_approval' }))
  )
  fs.writeFileSync(path.join(runDir, 'plan.md'), '# Plan\n\n- [ ] Step one\n- [x] Step two\n')

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const cockpit = await (await fetch(`${server.base}/cockpit`)).json()
  assert.equal(cockpit.project_root, tmp)
  assert.equal(cockpit.runs.length, 1)
  assert.equal(cockpit.runs[0].run_id, runId)
  assert.equal(cockpit.runs[0].feature, 'add dark mode')
  assert.equal(cockpit.runs[0].status, 'awaiting_approval')

  const plan = await (await fetch(`${server.base}/runs/${runId}/plan`)).json()
  assert.equal(plan.exists, true)
  assert.match(plan.content, /Step two/)
})

test('runs endpoint sorts by most recently updated', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-runs-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const older = '4coop-2025-01-01-100000-older'
  const newer = '4coop-2025-01-02-100000-newer'
  for (const id of [older, newer]) {
    const dir = path.join(tmp, '.4co-op', 'runs', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(mkRunState(id, { feature: id, status: 'halted' })))
  }
  // Force newer mtime on `newer`
  const newerPath = path.join(tmp, '.4co-op', 'runs', newer, 'state.json')
  const futureTime = new Date(Date.now() + 60_000)
  fs.utimesSync(newerPath, futureTime, futureTime)

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const result = await (await fetch(`${server.base}/runs`)).json()
  assert.equal(result.runs[0].run_id, newer)
  assert.equal(result.runs[1].run_id, older)
})

test('dispatch rejects unknown commands and is fire-and-forget for valid ones', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-dispatch-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const badResponse = await fetch(`${server.base}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'nope' })
  })
  assert.equal(badResponse.status, 400)
  const badPayload = await badResponse.json()
  assert.equal(badPayload.ok, false)
  assert.match(badPayload.error, /unknown command/)

  // Valid command — the orchestrator is spawned detached, so the HTTP response
  // returns 202 immediately rather than waiting for the pipeline to finish.
  // The spawned orchestrator will fail quickly (no git/config in tmp) but that
  // is fine because this test only asserts the response shape.
  const startResponse = await fetch(`${server.base}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'list-branches' })
  })
  assert.equal(startResponse.status, 202)
  const startPayload = await startResponse.json()
  assert.equal(startPayload.ok, true)
  assert.equal(startPayload.status, 'dispatched')
  assert.equal(startPayload.command, 'list-branches')
})

test('cockpit refresh broadcasts without mutating state', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-refresh-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const response = await fetch(`${server.base}/cockpit/refresh`, {
    method: 'POST'
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
})

test('runs/:id/live returns tail of live.ndjson, capped by tail query', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const runId = '4coop-2026-04-22-live'
  const runDir = path.join(tmp, '.4co-op', 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const lines = []
  for (let i = 0; i < 20; i += 1) {
    lines.push(JSON.stringify({ ts: 1000 + i, stage: 'builder', category: 'reads', event: { index: i } }))
  }
  fs.writeFileSync(path.join(runDir, 'live.ndjson'), `${lines.join('\n')}\n`)

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const full = await (await fetch(`${server.base}/runs/${runId}/live`)).json()
  assert.equal(full.ok, true)
  assert.equal(full.events.length, 20)

  const tail = await (await fetch(`${server.base}/runs/${runId}/live?tail=5`)).json()
  assert.equal(tail.events.length, 5)
  assert.equal(tail.events[4].event.index, 19)
})

test('runs/:id/live returns empty list when no live.ndjson exists', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const runId = '4coop-2026-04-22-empty'
  fs.mkdirSync(path.join(tmp, '.4co-op', 'runs', runId), { recursive: true })

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const result = await (await fetch(`${server.base}/runs/${runId}/live`)).json()
  assert.equal(result.ok, true)
  assert.equal(result.exists, false)
  assert.deepEqual(result.events, [])
})

test('runs/:id/file reads whitelisted files and rejects path escapes', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-file-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const runId = '4coop-2026-04-22-file'
  const runDir = path.join(tmp, '.4co-op', 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'spec-checker-failure-01-raw.txt'), 'this is the raw model output')
  fs.writeFileSync(path.join(runDir, 'secret.env'), 'SHOULD_NOT_LEAK=1')

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const allowed = await (await fetch(`${server.base}/runs/${runId}/file?path=spec-checker-failure-01-raw.txt`)).json()
  assert.equal(allowed.ok, true)
  assert.equal(allowed.content, 'this is the raw model output')

  const blockedExt = await fetch(`${server.base}/runs/${runId}/file?path=secret.env`)
  assert.equal(blockedExt.status, 400)

  const pathEscape = await fetch(`${server.base}/runs/${runId}/file?path=${encodeURIComponent('../../../etc/passwd.txt')}`)
  assert.equal(pathEscape.status, 400)
})

test('POST /stage-event broadcasts via SSE stage_event channel', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-sse-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const server = await startServer(tmp)
  t.after(() => server.stop())

  const received = []
  const ac = new AbortController()
  const streamPromise = (async () => {
    const response = await fetch(`${server.base}/events`, { signal: ac.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.includes('event: stage_event')) {
          const dataLine = part.split('\n').find(line => line.startsWith('data: '))
          if (dataLine) received.push(JSON.parse(dataLine.slice(6)))
        }
      }
      if (received.length >= 1) break
    }
  })().catch(() => {})

  await new Promise(resolve => setTimeout(resolve, 100))

  const post = await fetch(`${server.base}/stage-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'builder', category: 'reads', event: { type: 'tool_call', name: 'Read' } })
  })
  assert.equal(post.status, 200)

  await Promise.race([
    streamPromise,
    new Promise(resolve => setTimeout(resolve, 2000))
  ])
  ac.abort()

  assert.equal(received.length >= 1, true)
  assert.equal(received[0].stage, 'builder')
  assert.equal(received[0].event.name, 'Read')
})

test('bind endpoint rebinds project root for a running monitor', async t => {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-bindA-'))
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-bindB-'))
  t.after(() => {
    fs.rmSync(tmpA, { recursive: true, force: true })
    fs.rmSync(tmpB, { recursive: true, force: true })
  })

  const runIdB = '4coop-2025-02-02-120000-b'
  const runDirB = path.join(tmpB, '.4co-op', 'runs', runIdB)
  fs.mkdirSync(runDirB, { recursive: true })
  fs.writeFileSync(path.join(runDirB, 'state.json'), JSON.stringify(mkRunState(runIdB, { feature: 'from B', status: 'planning' })))

  const server = await startServer(tmpA)
  t.after(() => server.stop())

  const bindResponse = await fetch(`${server.base}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_root: tmpB })
  })
  assert.equal(bindResponse.status, 200)

  const cockpit = await (await fetch(`${server.base}/cockpit`)).json()
  assert.equal(cockpit.project_root, tmpB)
  assert.equal(cockpit.runs[0].run_id, runIdB)
})
