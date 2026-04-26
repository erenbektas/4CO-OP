import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStructuredPayload } from '../skill/4co-op/scripts/4coop-stage-claude.mjs'

test('spec_checker parser accepts a well-formed JSON result', () => {
  const good = {
    results: [{ id: 'AC-001', status: 'PASS', evidence_file: 'src/a.ts', evidence_line: 12, quote: 'ok' }],
    summary: 'all pass',
    tagged_message: '[✅ Spec Checker | Sonnet 4.6]: done'
  }
  const envelope = { result: [{ type: 'text', text: JSON.stringify(good) }] }
  const parsed = extractStructuredPayload('spec_checker', envelope, '')
  assert.equal(parsed.results[0].status, 'PASS')
  assert.equal(parsed.summary, 'all pass')
})

test('spec_checker parser throws a diagnostic-rich error when the schema is malformed', () => {
  const malformed = {
    results: 'not-an-array',
    summary: 42
  }
  const envelope = { result: [{ type: 'text', text: JSON.stringify(malformed) }] }
  assert.throws(
    () => extractStructuredPayload('spec_checker', envelope, JSON.stringify(malformed)),
    err => {
      assert.match(err.message, /spec_checker/)
      return true
    }
  )
})

test('spec_checker parser accepts JSON wrapped in markdown code fences', () => {
  const good = {
    results: [{ id: 'AC-001', status: 'FAIL', evidence_file: 'src/a.ts', evidence_line: 1, quote: 'missing' }],
    summary: '1 FAIL',
    tagged_message: '[✅ Spec Checker | Sonnet 4.6]: fail'
  }
  const fenced = '```json\n' + JSON.stringify(good) + '\n```'
  const envelope = { result: [{ type: 'text', text: fenced }] }
  const parsed = extractStructuredPayload('spec_checker', envelope, fenced)
  assert.equal(parsed.results[0].status, 'FAIL')
})

test('spec_checker parser surfaces an error when prose-only output is returned', () => {
  const prose = 'Here is my analysis: all three criteria appear to pass, but I am not fully sure about AC-003.'
  const envelope = { result: [{ type: 'text', text: prose }] }
  assert.throws(
    () => extractStructuredPayload('spec_checker', envelope, prose),
    /spec_checker/
  )
})
