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

test('live-event sink accumulates per-category token totals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'builder' })
    sink.onEvent({ type: 'tool_call', name: 'Read', usage: { total_tokens: 100 } })
    sink.onEvent({ type: 'tool_call', name: 'Read', usage: { total_tokens: 250 } })
    sink.onEvent({ type: 'tool_call', name: 'Edit', usage: { total_tokens: 50 } })
    sink.onEvent({ type: 'agent_message', usage: { input_tokens: 10, output_tokens: 90 } })

    assert.equal(sink.tokenAccounting.reads, 350)
    assert.equal(sink.tokenAccounting.edits, 50)
    assert.equal(sink.tokenAccounting.model_turns, 100)
    assert.equal(sink.tokenAccounting.bash, 0)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('readLiveEventsTail returns last N parsed lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'builder' })
    for (let i = 0; i < 20; i += 1) {
      sink.onEvent({ type: 'tool_call', name: 'Read', index: i })
    }
    const tail = readLiveEventsTail(tmp, 5)
    assert.equal(tail.length, 5)
    assert.equal(tail[4].event.index, 19)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('readLiveEventsTail tolerates malformed lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-live-'))
  try {
    const sink = createLiveEventSink({ runDir: tmp, stage: 'builder' })
    sink.onEvent({ type: 'tool_call', name: 'Read' })
    fs.appendFileSync(path.join(tmp, 'live.ndjson'), 'not-json-garbage\n', 'utf8')
    sink.onEvent({ type: 'tool_call', name: 'Edit' })
    const tail = readLiveEventsTail(tmp, 10)
    assert.equal(tail.length, 2)
    assert.equal(tail[1].event.name, 'Edit')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
