import test from 'node:test'
import assert from 'node:assert/strict'
import {
  projectCommandsReady,
  validateProjectCommands
} from '../skill/4co-op/scripts/4coop-config.mjs'

test('empty build/test/lint are all valid (empty = skip)', () => {
  assert.deepEqual(validateProjectCommands({
    confirmed: true,
    build: '',
    test: '',
    lint: ''
  }), [])
  assert.equal(projectCommandsReady({
    confirmed: true,
    build: '',
    test: '',
    lint: ''
  }), true)
})

test('populated build/test/lint are valid', () => {
  assert.deepEqual(validateProjectCommands({
    confirmed: true,
    build: 'npm run build',
    test: 'npm test',
    lint: 'npm run lint'
  }), [])
  assert.equal(projectCommandsReady({
    confirmed: true,
    build: 'npm run build',
    test: 'npm test',
    lint: 'npm run lint'
  }), true)
})

test('non-string command fields are rejected', () => {
  const errors = validateProjectCommands({
    confirmed: true,
    build: null,
    test: '',
    lint: ''
  })
  assert.ok(errors.some(line => line.includes('build')))
})

test('unconfirmed commands are not ready', () => {
  assert.equal(projectCommandsReady({
    confirmed: false,
    build: '',
    test: '',
    lint: ''
  }), false)
})
