import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStructuredPayload } from '../skill/4co-op/scripts/4coop-stage-claude.mjs'

test('extractStructuredPayload handles nested Claude content arrays for planner output', () => {
  const plannerJson = JSON.stringify({
    tagged_message: '[🧠 Planner | Opus 4.7 1M]: Plan ready.',
    plan_markdown: '# Plan\n- Step 1',
    acceptance_checklist: [
      { id: 'AC-001', text: 'Build the feature', status: 'pending' }
    ],
    file_structure_hint: ['index.html'],
    definition_of_done: 'The requested page works.'
  })

  const envelope = {
    result: {
      content: [
        { type: 'text', text: plannerJson }
      ]
    }
  }

  const parsed = extractStructuredPayload('planner', envelope, '')
  assert.equal(parsed.plan_markdown, '# Plan\n- Step 1')
  assert.equal(parsed.acceptance_checklist[0].id, 'AC-001')
})
