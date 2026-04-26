import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createLiveEventSink,
  readLiveEventsTail
} from '../skill/4co-op/scripts/4coop-live-events.mjs'

function readNdjson(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('live-event sink writes ndjson and broadcasts per event', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const broadcasts = []
    const sink = createLiveEventSink({
      runDir: tmp,
      stage: 'builder',
      callIndex: 1,
      broadcast: (name, payload) => broadcasts.push({ name, payload })
    })
    sink.onEvent({ type: 'tool_call', name: 'Read', arguments: { file_path: 'src/foo.ts' } })
    sink.onEvent({ type: 'tool_call', name: 'Bash', arguments: { command: 'npm test' } })
    sink.onEvent({ type: 'agent_message', text: 'Working on it' })

    const rows = readNdjson(path.join(tmp, 'live.ndjson'))
    assert.equal(rows.length, 3)
    assert.equal(rows[0].stage, 'builder')
    assert.equal(rows[0].call_index, 1)
    assert.equal(rows[0].category, 'reads')
    assert.equal(rows[1].category, 'bash')
    assert.equal(rows[2].category, 'model_turns')

    assert.equal(broadcasts.length, 3)
    assert.equal(broadcasts[0].name, 'stage_event')
    assert.equal(broadcasts[0].payload.stage, 'builder')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('live-event sink counts each classified event once per category', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'builder' })
    sink.onEvent({ type: 'tool_call', name: 'Read', input: { file_path: 'a' } })
    sink.onEvent({ type: 'tool_call', name: 'Read', input: { file_path: 'b' } })
    sink.onEvent({ type: 'tool_call', name: 'Edit', input: { file_path: 'c' } })
    sink.onEvent({ type: 'agent_message', text: 'thinking out loud' })

    assert.equal(sink.eventCounts.reads, 2)
    assert.equal(sink.eventCounts.edits, 1)
    assert.equal(sink.eventCounts.model_turns, 1)
    assert.equal(sink.eventCounts.bash, 0)
    // Legacy alias still returns the same counts.
    assert.equal(sink.tokenAccounting.reads, 2)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('readLiveEventsTail returns last N parsed lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'builder' })
    for (let i = 0; i < 20; i += 1) {
      sink.onEvent({ type: 'tool_call', name: 'Read', input: { file_path: `src/foo-${i}.ts` } })
    }
    const tail = readLiveEventsTail(tmp, 5)
    assert.equal(tail.length, 5)
    // The preview carries the tool name + last file path for the newest event.
    assert.ok(tail[4].preview.includes('src/foo-19.ts'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('live-event sink classifies system/api_retry events', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'planner' })
    sink.onEvent({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 3000,
      error_status: 529,
      error: 'server_error'
    })
    const rows = readNdjson(path.join(tmp, 'live.ndjson'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].category, 'api_retry')
    assert.equal(rows[0].kind, 'api_retry')
    assert.match(rows[0].preview, /attempt 2\/5/)
    assert.match(rows[0].preview, /retry in 3s/)
    assert.equal(sink.eventCounts.api_retry, 1)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('readLiveEventsTail tolerates malformed lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'builder' })
    sink.onEvent({ type: 'tool_call', name: 'Read', input: { file_path: 'x' } })
    fs.appendFileSync(path.join(tmp, 'live.ndjson'), 'not-json-garbage\n', 'utf8')
    sink.onEvent({ type: 'tool_call', name: 'Edit', input: { file_path: 'y' } })
    const tail = readLiveEventsTail(tmp, 10)
    assert.equal(tail.length, 2)
    assert.equal(tail[1].summary, 'Edit')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
