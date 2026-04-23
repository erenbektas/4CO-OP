import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic, writeJsonAtomic } from '../skill/4co-op/scripts/4coop-atomic.mjs'
import {
  backfillStateDefaults,
  clearStageInFlight,
  createInitialRunState,
  getLatestSessionId,
  markStateResumed,
  markStateSuspended,
  readStageInFlight,
  recordSessionId,
  saveRunState,
  touchStageInFlight,
  writeStageInFlight
} from '../skill/4co-op/scripts/4coop-state.mjs'
import {
  acquireLock,
  lockIsFresh,
  markLockResumed,
  markLockSuspended,
  readLock,
  releaseLock,
  touchLockHeartbeat
} from '../skill/4co-op/scripts/4coop-lock.mjs'

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-sr-'))
  const runtime = path.join(dir, '.4co-op')
  const runId = 'test-run'
  const runDir = path.join(runtime, 'runs', runId)
  fs.mkdirSync(path.join(runtime, 'runs'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  const paths = {
    projectRoot: dir,
    runtimeDir: runtime,
    runId,
    runDir,
    stateFile: path.join(runDir, 'state.json'),
    stageInFlightFile: path.join(runDir, 'stage-in-flight.json'),
    activeFile: path.join(runtime, '4coop-active.json'),
    lockFile: path.join(runtime, 'pipeline.lock')
  }
  return { dir, paths }
}

test('writeFileAtomic writes completely or not at all', () => {
  const { dir } = tmpProject()
  try {
    const target = path.join(dir, 'sample.json')
    writeJsonAtomic(target, { hello: 'world' })
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { hello: 'world' })
    // No temp files should linger in the target directory.
    const leftovers = fs.readdirSync(dir).filter(name => name.startsWith('sample.json.tmp'))
    assert.equal(leftovers.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordSessionId stores per-stage session ids and surfaces the latest', () => {
  const { dir, paths } = tmpProject()
  try {
    const state = createInitialRunState({ runId: paths.runId, featureRequest: 'x' })
    saveRunState(paths, state)
    recordSessionId(paths, { stage: 'builder', callIndex: 1, sessionId: 'thread-A', tool: 'codex' })
    recordSessionId(paths, { stage: 'builder', callIndex: 2, sessionId: 'thread-B', tool: 'codex' })
    const reloaded = backfillStateDefaults(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')))
    assert.equal(reloaded.sessions.builder['1'].session_id, 'thread-A')
    assert.equal(reloaded.sessions.builder['2'].session_id, 'thread-B')
    // Builder gets the convenience mirror too.
    assert.equal(reloaded.builder.codex_session_id, 'thread-B')
    assert.equal(getLatestSessionId(reloaded, 'builder'), 'thread-B')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stage-in-flight sentinel lifecycle: write, touch, read, clear', async () => {
  const { dir, paths } = tmpProject()
  try {
    writeStageInFlight(paths, { stage: 'reviewer', callIndex: 1, tool: 'claude', sessionId: 'uuid-1' })
    const first = readStageInFlight(paths)
    assert.equal(first.stage, 'reviewer')
    assert.equal(first.session_id, 'uuid-1')
    const initialHeartbeat = first.heartbeat_at
    await new Promise(resolve => setTimeout(resolve, 15))
    touchStageInFlight(paths, { extra: 'value' })
    const second = readStageInFlight(paths)
    assert.notEqual(second.heartbeat_at, initialHeartbeat)
    assert.equal(second.extra, 'value')
    clearStageInFlight(paths)
    assert.equal(readStageInFlight(paths), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('markStateSuspended / markStateResumed flip status and increment resume_count', () => {
  const { dir, paths } = tmpProject()
  try {
    const state = createInitialRunState({ runId: paths.runId, featureRequest: 'y' })
    saveRunState(paths, state)
    const suspended = markStateSuspended(paths, 'user')
    assert.equal(suspended.status, 'suspended')
    assert.equal(suspended.suspend_reason, 'user')
    assert.ok(suspended.suspended_at)
    const resumed = markStateResumed(paths, 'running')
    assert.equal(resumed.status, 'running')
    assert.equal(resumed.resume_count, 1)
    markStateResumed(paths, 'running')
    const twice = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))
    assert.equal(twice.resume_count, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lock honors pid + heartbeat; stale heartbeat makes it un-fresh', () => {
  const { dir, paths } = tmpProject()
  try {
    const lock = acquireLock(paths, { run_id: paths.runId, feature: 'z' })
    assert.equal(lock.pid, process.pid)
    assert.ok(lockIsFresh(lock))
    // Back-date the heartbeat to simulate a dead writer.
    const stale = { ...readLock(paths), heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }
    fs.writeFileSync(paths.lockFile, JSON.stringify(stale), 'utf8')
    assert.equal(lockIsFresh(readLock(paths)), false)
    touchLockHeartbeat(paths)
    assert.ok(lockIsFresh(readLock(paths)))
    const suspended = markLockSuspended(paths, 'user')
    assert.equal(suspended.suspended, true)
    // Suspended locks are considered fresh so another orchestrator won't steal the slot.
    assert.ok(lockIsFresh(readLock(paths)))
    const resumed = markLockResumed(paths)
    assert.equal(resumed.suspended, undefined)
    releaseLock(paths)
    assert.equal(readLock(paths), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lock treats a dead pid as not-fresh', () => {
  const { dir, paths } = tmpProject()
  try {
    acquireLock(paths, { run_id: paths.runId, feature: 'z' })
    // Replace pid with a very unlikely-to-exist value.
    const deadPid = 999999
    const withDeadPid = { ...readLock(paths), pid: deadPid }
    fs.writeFileSync(paths.lockFile, JSON.stringify(withDeadPid), 'utf8')
    assert.equal(lockIsFresh(readLock(paths)), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('backfillStateDefaults adds new keys without stomping existing ones', () => {
  const legacy = {
    run_id: 'r',
    feature_request: 'f',
    status: 'planning',
    builder: { codex_session_id: 'keep-me' }
  }
  const filled = backfillStateDefaults(structuredClone(legacy))
  assert.deepEqual(filled.sessions, {})
  assert.equal(filled.suspended_at, null)
  assert.equal(filled.suspend_reason, null)
  assert.equal(filled.resume_count, 0)
  assert.equal(filled.builder.codex_session_id, 'keep-me')
})
