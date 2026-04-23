import { spawn } from 'node:child_process'
import { extractJsonObject, validateStageResult } from './4coop-schemas.mjs'

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

function parseEnvelope(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse()
    for (const line of lines) {
      try {
        return JSON.parse(line)
      } catch {
        continue
      }
    }
    return null
  }
}

function collectNestedCandidates(value, seen = new Set()) {
  if (value === undefined || value === null) {
    return []
  }
  if (typeof value === 'string') {
    return [value]
  }
  if (typeof value !== 'object') {
    return []
  }
  if (seen.has(value)) {
    return []
  }
  seen.add(value)

  const candidates = [value]
  if (Array.isArray(value)) {
    const joined = value
      .map(item => typeof item === 'string' ? item : item?.text)
      .filter(Boolean)
      .join('\n')
      .trim()
    if (joined) {
      candidates.push(joined)
    }
    for (const item of value) {
      candidates.push(...collectNestedCandidates(item, seen))
    }
    return candidates
  }

  for (const key of ['result', 'response', 'output', 'message', 'content', 'text']) {
    if (key in value) {
      candidates.push(...collectNestedCandidates(value[key], seen))
    }
  }

  return candidates
}

function extractOutputText(envelope, stdout) {
  if (!envelope) {
    return stdout.trim()
  }

  for (const candidate of collectNestedCandidates(envelope)) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  return stdout.trim()
}

function extractUsage(envelope, prompt, outputText) {
  const usage = envelope?.usage ?? {}
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens)

  if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      exact: true
    }
  }

  return {
    input_tokens: estimateTokens(prompt),
    output_tokens: estimateTokens(outputText),
    exact: false
  }
}

export function extractStructuredPayload(stage, envelope, outputText) {
  const candidates = [
    ...collectNestedCandidates(envelope),
    outputText
  ]

  for (const candidate of candidates) {
    const parsed = extractJsonObject(candidate)
    if (parsed && validateStageResult(stage, parsed)) {
      return parsed
    }
  }

  throw new Error(`Unable to parse ${stage} output into the expected schema`)
}

function createLineStream(onLine) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk.toString()
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (line.trim()) {
          onLine(line)
        }
        newlineIndex = buffer.indexOf('\n')
      }
    },
    flush() {
      if (buffer.trim()) {
        onLine(buffer.replace(/\r$/, ''))
        buffer = ''
      }
    }
  }
}

export async function runClaudeStage({
  cli = 'claude',
  stage,
  model,
  prompt,
  cwd,
  timeoutMs = 20 * 60 * 1000,
  permissionMode = 'bypassPermissions',
  onEvent = null,
  sessionId = null,
  resumeSessionId = null,
  onSessionStarted = null,
  onSpawn = null
}) {
  return await new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--permission-mode', permissionMode]
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    } else if (sessionId) {
      args.push('--session-id', sessionId)
    }
    const effectiveSessionId = resumeSessionId ?? sessionId ?? null
    if (effectiveSessionId && typeof onSessionStarted === 'function') {
      try { onSessionStarted(effectiveSessionId) } catch {}
    }
    const child = spawn(cli, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (typeof onSpawn === 'function') {
      try { onSpawn(child) } catch {}
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    const lineStream = onEvent
      ? createLineStream(line => {
          try {
            const parsed = JSON.parse(line)
            onEvent(parsed, line)
          } catch {
            // Non-JSON lines — ignore
          }
        })
      : null

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (lineStream) {
        lineStream.push(chunk)
      }
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', exitCode => {
      clearTimeout(timeout)
      if (lineStream) {
        lineStream.flush()
      }
      if (timedOut) {
        reject(new Error(`${stage} timed out after ${timeoutMs}ms`))
        return
      }
      if (exitCode !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${stage} exited with code ${exitCode}`))
        return
      }

      const envelope = parseEnvelope(stdout)
      const outputText = extractOutputText(envelope, stdout)
      const usage = extractUsage(envelope, prompt, outputText)
      let structured
      try {
        structured = extractStructuredPayload(stage, envelope, outputText)
      } catch (error) {
        const wrapped = new Error(error.message)
        wrapped.name = 'StageSchemaError'
        wrapped.stage = stage
        wrapped.outputText = outputText
        wrapped.stdout = stdout
        wrapped.stderr = stderr
        reject(wrapped)
        return
      }

      const envelopeSessionId = typeof envelope?.session_id === 'string'
        ? envelope.session_id
        : envelope?.structured?.session_id ?? null
      const resolvedSessionId = effectiveSessionId ?? envelopeSessionId ?? null
      if (resolvedSessionId && !effectiveSessionId && typeof onSessionStarted === 'function') {
        try { onSessionStarted(resolvedSessionId) } catch {}
      }

      resolve({
        exitCode,
        stdout,
        stderr,
        envelope,
        outputText,
        structured,
        usage,
        sessionId: resolvedSessionId
      })
    })
  })
}
