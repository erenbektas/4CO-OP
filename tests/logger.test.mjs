import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from '../skill/4co-op/scripts/4coop-logger.mjs'

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('logger preserves paths, URLs, and commit SHAs verbatim', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-logger-'))
  try {
    const logger = createLogger({ projectRoot: tmp, logDir: 'logs' })
    logger.write('stage_call', {
      stage: 'builder',
      input_file: 'runs/abc/relay/builder-01.md',
      output_file: '/Users/alice/project/.4co-op/runs/abc/raw/builder-01.ndjson',
      commit: '84a1ecb4f9d2',
      pr_url: 'https://github.com/acme/widgets/pull/42',
      duration_ms: 12345
    })
    const [line] = readLines(logger.filePath)
    assert.equal(line.stage, 'builder')
    assert.equal(line.input_file, 'runs/abc/relay/builder-01.md')
    assert.equal(line.output_file, '/Users/alice/project/.4co-op/runs/abc/raw/builder-01.ndjson')
    assert.equal(line.commit, '84a1ecb4f9d2')
    assert.equal(line.pr_url, 'https://github.com/acme/widgets/pull/42')
    assert.equal(line.duration_ms, 12345)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('logger keeps the long-string cap as a safety net at 2000 chars', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-logger-'))
  try {
    const logger = createLogger({ projectRoot: tmp, logDir: 'logs' })
    const giant = 'x'.repeat(5000)
    logger.write('big_dump', { payload: giant, small: 'ok' })
    const [line] = readLines(logger.filePath)
    assert.ok(line.payload.startsWith('x'.repeat(2000)))
    assert.match(line.payload, /truncated 3000 chars/)
    assert.equal(line.small, 'ok')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('logger preserves nested structures including previously-stripped keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-logger-'))
  try {
    const logger = createLogger({ projectRoot: tmp, logDir: 'logs' })
    logger.write('complex', {
      prompt: 'Build the feature',
      input: 'raw input',
      output: 'raw output',
      path: 'src/foo.ts',
      branch: 'feature/add-x',
      nested: {
        file: 'deep.ts',
        url: 'https://example.com'
      }
    })
    const [line] = readLines(logger.filePath)
    assert.equal(line.prompt, 'Build the feature')
    assert.equal(line.input, 'raw input')
    assert.equal(line.path, 'src/foo.ts')
    assert.equal(line.branch, 'feature/add-x')
    assert.equal(line.nested.file, 'deep.ts')
    assert.equal(line.nested.url, 'https://example.com')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
