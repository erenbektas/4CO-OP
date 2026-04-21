import test from 'node:test'
import assert from 'node:assert/strict'
import {
  projectCommandsReady,
  validateProjectCommands
} from '../skill/4co-op/scripts/4coop-config.mjs'

test('project commands require non-empty build and lint', () => {
  const errors = validateProjectCommands({
    confirmed: true,
    build: '',
    test: '',
    lint: ''
  })

  assert.deepEqual(errors, [
    'build command cannot be empty',
    'lint command cannot be empty'
  ])
  assert.equal(projectCommandsReady({
    confirmed: true,
    build: '',
    test: '',
    lint: ''
  }), false)
})

test('project commands allow empty test when build and lint are present', () => {
  assert.deepEqual(validateProjectCommands({
    confirmed: true,
    build: 'npm run build',
    test: '',
    lint: 'npm run lint'
  }), [])
  assert.equal(projectCommandsReady({
    confirmed: true,
    build: 'npm run build',
    test: '',
    lint: 'npm run lint'
  }), true)
})
