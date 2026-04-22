import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './4coop-paths.mjs'

const EVENT_CATEGORY_MAP = {
  Read: 'reads',
  Edit: 'edits',
  Write: 'edits',
  MultiEdit: 'edits',
  Bash: 'bash',
  Glob: 'reads',
  Grep: 'reads'
}

function categorizeToolCall(toolName) {
  if (!toolName) {
    return 'other'
  }
  return EVENT_CATEGORY_MAP[toolName] ?? 'other'
}

function countTokensForEvent(event) {
  const usage = event.usage ?? event.token_count ?? null
  if (typeof usage === 'number') {
    return usage
  }
  if (usage && typeof usage === 'object') {
    const input = Number(usage.input_tokens ?? 0)
    const output = Number(usage.output_tokens ?? 0)
    const total = Number(usage.total_tokens ?? 0)
    if (Number.isFinite(total) && total > 0) {
      return total
    }
    return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
  }
  if (typeof event.input_tokens === 'number' || typeof event.output_tokens === 'number') {
    return Number(event.input_tokens ?? 0) + Number(event.output_tokens ?? 0)
  }
  return 0
}

function classifyEvent(event) {
  const type = event?.type ?? event?.event ?? null
  if (!type) {
    return { category: 'other', summary: '' }
  }

  if (type === 'tool_call' || type === 'tool_use' || type === 'tool_call_started') {
    const toolName = event.name ?? event.tool ?? event.tool_name ?? null
    return { category: categorizeToolCall(toolName), summary: `tool:${toolName ?? 'unknown'}` }
  }

  if (type === 'tool_output' || type === 'tool_result') {
    const toolName = event.name ?? event.tool ?? event.tool_name ?? null
    return { category: categorizeToolCall(toolName), summary: `tool_output:${toolName ?? 'unknown'}` }
  }

  if (type === 'agent_message' || type === 'message' || type === 'assistant_message') {
    return { category: 'model_turns', summary: 'message' }
  }

  if (type === 'token_count' || type === 'usage') {
    return { category: null, summary: 'usage' }
  }

  return { category: 'other', summary: type }
}

export function createLiveEventSink({ runDir, stage, callIndex = 1, broadcast = null }) {
  if (!runDir) {
    return {
      onEvent: () => {},
      tokenAccounting: { reads: 0, edits: 0, bash: 0, model_turns: 0, other: 0 },
      close: () => {}
    }
  }

  ensureDir(runDir)
  const filePath = path.join(runDir, 'live.ndjson')
  const tokenAccounting = { reads: 0, edits: 0, bash: 0, model_turns: 0, other: 0 }

  const onEvent = (event, rawLine) => {
    const ts = Date.now()
    const classification = classifyEvent(event)
    const tokens = countTokensForEvent(event)

    if (classification.category && tokens > 0) {
      tokenAccounting[classification.category] =
        (tokenAccounting[classification.category] ?? 0) + tokens
    }

    const line = {
      ts,
      stage,
      call_index: callIndex,
      category: classification.category,
      summary: classification.summary,
      tokens,
      event
    }

    try {
      fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // If the file write fails (disk full, permission), don't crash the stage.
    }

    if (typeof broadcast === 'function') {
      try {
        broadcast('stage_event', line)
      } catch {
        // Broadcast failures shouldn't take down the run.
      }
    }
  }

  return {
    onEvent,
    tokenAccounting,
    close: () => {}
  }
}

export function readLiveEventsTail(runDir, tailLines = 500) {
  const filePath = path.join(runDir, 'live.ndjson')
  if (!fs.existsSync(filePath)) {
    return []
  }
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const sliced = tailLines > 0 ? lines.slice(-tailLines) : lines
  const out = []
  for (const line of sliced) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip malformed lines.
    }
  }
  return out
}
