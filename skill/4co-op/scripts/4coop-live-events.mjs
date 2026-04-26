import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './4coop-paths.mjs'

const TOOL_CATEGORY = {
  Read: 'reads',
  Glob: 'reads',
  Grep: 'reads',
  LS: 'reads',
  Edit: 'edits',
  Write: 'edits',
  MultiEdit: 'edits',
  NotebookEdit: 'edits',
  Bash: 'bash'
}

function categoryForTool(toolName) {
  if (!toolName) return 'other'
  if (TOOL_CATEGORY[toolName]) return TOOL_CATEGORY[toolName]
  const lower = String(toolName).toLowerCase()
  if (lower.includes('read') || lower.includes('glob') || lower.includes('grep') || lower.includes('ls')) return 'reads'
  if (lower.includes('edit') || lower.includes('write') || lower.includes('apply_patch') || lower.includes('apply-patch')) return 'edits'
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) return 'bash'
  return 'other'
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return ''
}

function clip(text, max = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function extractToolInput(event) {
  const direct = event.input ?? event.arguments ?? event.tool_input ?? event.parameters ?? null
  if (direct && typeof direct === 'object') return direct
  if (typeof direct === 'string') {
    const parsed = parseJsonMaybe(direct)
    if (parsed && typeof parsed === 'object') return parsed
    return { _raw: direct }
  }
  return null
}

function summarizeBashCommand(input) {
  if (!input) return ''
  if (typeof input === 'string') return clip(input, 80)
  return clip(input.command ?? input.cmd ?? input._raw ?? '', 80)
}

function summarizeFilePath(input) {
  if (!input) return ''
  if (typeof input === 'string') return clip(input, 120)
  return clip(input.file_path ?? input.path ?? input.target ?? input.filename ?? '', 120)
}

function buildToolPreview(toolName, input) {
  const category = categoryForTool(toolName)
  if (category === 'bash') {
    const cmd = summarizeBashCommand(input)
    return cmd ? `${toolName} ${cmd}` : toolName
  }
  if (category === 'reads' || category === 'edits') {
    const file = summarizeFilePath(input)
    return file ? `${toolName} ${file}` : toolName
  }
  if (toolName === 'Task' && input?.description) {
    return `${toolName} ${clip(input.description, 80)}`
  }
  return toolName
}

// Codex wraps tool calls in `response.output_item.*` / `function_call` items.
function extractCodexItem(event) {
  if (event?.item && typeof event.item === 'object') return event.item
  if (event?.output_item && typeof event.output_item === 'object') return event.output_item
  return null
}

function classifyEvent(event) {
  if (!event || typeof event !== 'object') {
    return { category: 'other', summary: '', preview: '', kind: 'unknown' }
  }
  const type = event.type ?? event.event ?? null
  const subtype = event.subtype ?? null

  // Claude CLI system/api_retry — transient error auto-retry.
  if (type === 'system' && subtype === 'api_retry') {
    const attempt = Number(event.attempt ?? 0)
    const maxRetries = Number(event.max_retries ?? 0)
    const delayMs = Number(event.retry_delay_ms ?? 0)
    const errorStatus = event.error_status ?? null
    const errorKind = event.error ?? null
    const suffix = delayMs ? ` — retry in ${Math.round(delayMs / 1000)}s` : ''
    return {
      category: 'api_retry',
      summary: 'api_retry',
      preview: clip(`attempt ${attempt}/${maxRetries || '?'} (${errorKind ?? 'transient'})${errorStatus ? ` status ${errorStatus}` : ''}${suffix}`, 160),
      kind: 'api_retry'
    }
  }

  // Claude CLI envelope: tool_use / tool_result
  if (type === 'tool_use' || type === 'tool_call' || type === 'tool_call_started') {
    const toolName = event.name ?? event.tool ?? event.tool_name ?? null
    const input = extractToolInput(event)
    return {
      category: categoryForTool(toolName),
      summary: toolName ?? 'tool_call',
      preview: buildToolPreview(toolName, input),
      kind: 'tool_call'
    }
  }
  if (type === 'tool_result' || type === 'tool_output') {
    const toolName = event.name ?? event.tool ?? event.tool_name ?? null
    return {
      category: null, // don't double-count on result; already counted on call
      summary: toolName ?? 'tool_result',
      preview: clip(firstString(event.output_text, event.text, event.delta, typeof event.content === 'string' ? event.content : ''), 120),
      kind: 'tool_result'
    }
  }

  if (type === 'agent_message' || type === 'assistant_message' || type === 'message') {
    const text = firstString(
      event.text,
      event.content?.text,
      typeof event.content === 'string' ? event.content : '',
      event.message?.content
    )
    return { category: 'model_turns', summary: 'message', preview: clip(text, 160), kind: 'message' }
  }

  // Codex-specific: items surface as response.output_item.added / .done
  if (typeof type === 'string' && type.startsWith('response.output_item')) {
    const item = extractCodexItem(event)
    if (item) {
      const itemType = item.type ?? null
      if (itemType === 'function_call' || itemType === 'tool_call' || itemType === 'computer_call') {
        const toolName = item.name ?? item.function?.name ?? null
        const argString = item.arguments ?? item.function?.arguments ?? null
        const parsed = parseJsonMaybe(argString) ?? { _raw: argString }
        return {
          category: categoryForTool(toolName),
          summary: toolName ?? itemType,
          preview: buildToolPreview(toolName, parsed),
          kind: 'tool_call'
        }
      }
      if (itemType === 'message' || itemType === 'output_text') {
        const text = firstString(item.text, item.content?.[0]?.text, item.content?.text)
        return { category: 'model_turns', summary: 'message', preview: clip(text, 160), kind: 'message' }
      }
      if (itemType === 'reasoning') {
        return { category: 'model_turns', summary: 'reasoning', preview: '', kind: 'reasoning' }
      }
    }
  }

  // Codex `function_call_arguments.delta` and similar streaming — noisy; suppress from feed.
  if (typeof type === 'string' && (type.endsWith('.delta') || type.endsWith('.part'))) {
    return { category: null, summary: type, preview: '', kind: 'delta' }
  }

  // Codex usage events — do not categorize; they're bookkeeping, not tool activity.
  if (type === 'response.completed' || type === 'usage' || type === 'token_count') {
    return { category: null, summary: type, preview: '', kind: 'usage' }
  }

  // Thread/session lifecycle — surface in feed but don't count.
  if (typeof type === 'string' && (type.startsWith('thread.') || type.startsWith('session.') || type.startsWith('response.'))) {
    return { category: null, summary: type, preview: '', kind: 'lifecycle' }
  }

  return { category: 'other', summary: type ?? 'event', preview: '', kind: type ?? 'other' }
}

export function createLiveEventSink({ runDir, stage, callIndex = 1, broadcast = null }) {
  if (!runDir) {
    return {
      onEvent: () => {},
      eventCounts: { reads: 0, edits: 0, bash: 0, model_turns: 0, other: 0 },
      close: () => {}
    }
  }

  ensureDir(runDir)
  const filePath = path.join(runDir, 'live.ndjson')
  const eventCounts = { reads: 0, edits: 0, bash: 0, model_turns: 0, api_retry: 0, other: 0 }

  const onEvent = (event, _rawLine) => {
    const ts = Date.now()
    const classification = classifyEvent(event)

    if (classification.category && eventCounts[classification.category] !== undefined) {
      eventCounts[classification.category] += 1
    }

    const line = {
      ts,
      stage,
      call_index: callIndex,
      category: classification.category,
      kind: classification.kind,
      summary: classification.summary,
      preview: classification.preview || '',
      event_type: event?.type ?? null
    }

    try {
      fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // Disk full / permission errors must not crash the stage.
    }

    if (typeof broadcast === 'function') {
      try {
        broadcast('stage_event', line)
      } catch {
        // Broadcast failures are non-fatal.
      }
    }
  }

  return {
    onEvent,
    eventCounts,
    // Maintain the legacy field name so older state.json files keep working in the UI.
    get tokenAccounting() { return eventCounts },
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
