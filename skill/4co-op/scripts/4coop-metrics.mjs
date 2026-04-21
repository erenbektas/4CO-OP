const DISPLAY_ORDER = [
  'idle',
  'planner',
  'builder',
  'spec_checker',
  'escalation',
  'reviewer',
  'fixer',
  'gatekeeper',
  'narrator',
  'total'
]

function stripReasoningBlocks(text) {
  return String(text ?? '')
    .replace(/```reasoning[\s\S]*?```/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim()
}

function createRow(key, label, tag) {
  return {
    key,
    label,
    tag,
    tokens: 0,
    runtime_ms: 0,
    calls: 0,
    active: false,
    interrupted: false,
    exact_tokens: true,
    last_call: null,
    current_call: null
  }
}

export function createMonitorState(config) {
  const rows = {
    idle: createRow('idle', 'Idle', '—'),
    planner: createRow('planner', 'Planner', config.tags.planner.replace('{tag_display}', config.models.planner.tag_display)),
    builder: createRow('builder', 'Builder', config.tags.builder.replace('{tag_display}', config.models.builder.tag_display)),
    spec_checker: createRow('spec_checker', 'Spec Checker', config.tags.spec_checker.replace('{tag_display}', config.models.spec_checker.tag_display)),
    escalation: createRow('escalation', 'Escalation', config.tags.escalation.replace('{tag_display}', config.models.escalation.tag_display)),
    reviewer: createRow('reviewer', 'PR Reviewer', config.tags.reviewer.replace('{tag_display}', config.models.reviewer.tag_display)),
    fixer: createRow('fixer', 'Fixer', config.tags.fixer.replace('{tag_display}', config.models.fixer.tag_display)),
    gatekeeper: createRow('gatekeeper', 'Gatekeeper', config.tags.gatekeeper.replace('{tag_display}', config.models.gatekeeper.tag_display)),
    narrator: createRow('narrator', 'Haiku', config.tags.meta),
    total: createRow('total', 'Total Token Usage', '—')
  }

  rows.idle.active = true

  return {
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    active_stage: 'idle',
    rows
  }
}

function refreshTotals(state) {
  const total = state.rows.total
  total.tokens = 0
  total.runtime_ms = 0
  total.calls = 0
  total.active = false
  total.interrupted = false
  total.exact_tokens = true

  for (const key of Object.keys(state.rows)) {
    if (key === 'idle' || key === 'total') {
      continue
    }
    const row = state.rows[key]
    total.tokens += row.tokens
    total.runtime_ms += row.runtime_ms
    total.calls += row.calls
    total.exact_tokens = total.exact_tokens && row.exact_tokens
    total.interrupted = total.interrupted || row.interrupted
  }
}

function updateActiveStage(state, nextStage) {
  for (const row of Object.values(state.rows)) {
    row.active = false
  }
  state.active_stage = nextStage
  state.rows[nextStage].active = true
  state.updated_at = new Date().toISOString()
  refreshTotals(state)
  return state
}

function buildDetailPayload(payload = {}) {
  const inputFull = stripReasoningBlocks(payload.input_full ?? payload.input ?? '')
  const outputFull = stripReasoningBlocks(payload.output_full ?? payload.output ?? '')
  const previewLimit = 4096

  return {
    started_at: payload.started_at ?? new Date().toISOString(),
    ended_at: payload.ended_at ?? null,
    input_tokens: Number(payload.input_tokens ?? 0),
    output_tokens: Number(payload.output_tokens ?? 0),
    input_full: inputFull,
    output_full: outputFull,
    input_preview: inputFull.length > previewLimit ? `${inputFull.slice(0, previewLimit)}…` : inputFull,
    output_preview: outputFull.length > previewLimit ? `${outputFull.slice(0, previewLimit)}…` : outputFull,
    input_truncated: inputFull.length > previewLimit,
    output_truncated: outputFull.length > previewLimit,
    interrupted: Boolean(payload.interrupted)
  }
}

export function beginStageCall(state, stage, payload = {}) {
  const row = state.rows[stage]
  row.current_call = {
    started_at: payload.started_at ?? new Date().toISOString(),
    input: payload.input ?? '',
    input_tokens: Number(payload.input_tokens ?? 0)
  }
  row.interrupted = false
  return updateActiveStage(state, stage)
}

export function finishStageCall(state, stage, payload = {}) {
  const row = state.rows[stage]
  const startedAt = row.current_call?.started_at ?? new Date().toISOString()
  const endedAt = payload.ended_at ?? new Date().toISOString()
  const durationMs = Number(payload.duration_ms ?? (new Date(endedAt).getTime() - new Date(startedAt).getTime()))
  const inputTokens = Number(payload.input_tokens ?? row.current_call?.input_tokens ?? 0)
  const outputTokens = Number(payload.output_tokens ?? 0)

  row.calls += 1
  row.runtime_ms += Math.max(durationMs, 0)
  row.tokens += inputTokens + outputTokens
  row.exact_tokens = row.exact_tokens && payload.exact_tokens !== false
  row.last_call = buildDetailPayload({
    started_at: startedAt,
    ended_at: endedAt,
    input: payload.input ?? row.current_call?.input ?? '',
    output: payload.output ?? '',
    input_tokens: inputTokens,
    output_tokens: outputTokens
  })
  row.current_call = null
  return updateActiveStage(state, 'idle')
}

export function interruptStageCall(state, stage, payload = {}) {
  const row = state.rows[stage]
  const startedAt = row.current_call?.started_at ?? new Date().toISOString()
  const endedAt = payload.ended_at ?? new Date().toISOString()
  const inputTokens = Number(payload.input_tokens ?? row.current_call?.input_tokens ?? 0)
  const outputTokens = Number(payload.output_tokens ?? 0)
  row.calls += 1
  row.tokens += inputTokens + outputTokens
  row.interrupted = true
  row.exact_tokens = row.exact_tokens && payload.exact_tokens !== false
  row.last_call = buildDetailPayload({
    started_at: startedAt,
    ended_at: endedAt,
    input: payload.input ?? row.current_call?.input ?? '',
    output: payload.output ?? '',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    interrupted: true
  })
  row.current_call = null
  return updateActiveStage(state, 'idle')
}

export function serializeMonitorState(state) {
  refreshTotals(state)
  return {
    started_at: state.started_at ?? state.updated_at,
    updated_at: state.updated_at,
    active_stage: state.active_stage,
    rows: DISPLAY_ORDER.map(key => state.rows[key])
  }
}

export function summarizeMonitorForLog(state) {
  return DISPLAY_ORDER
    .filter(key => key !== 'idle')
    .map(key => {
      const row = state.rows[key]
      return {
        stage: key,
        tokens: row.tokens,
        runtime_ms: row.runtime_ms,
        calls: row.calls,
        interrupted: row.interrupted,
        exact_tokens: row.exact_tokens
      }
    })
}
