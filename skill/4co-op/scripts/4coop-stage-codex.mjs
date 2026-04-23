import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { extractJsonObject, validateStageResult } from './4coop-schemas.mjs'

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
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

function pluckText(value) {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(item => pluckText(item)).filter(Boolean).join('\n')
  }
  if (typeof value === 'object' && value !== null) {
    return [value.text, value.delta, value.content, value.message]
      .map(item => pluckText(item))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractUsage(events, prompt, outputText) {
  let inputTokens = null
  let outputTokens = null
  let totalTokens = null

  for (const event of events) {
    if (typeof event.token_count === 'number') {
      totalTokens = Math.max(totalTokens ?? 0, event.token_count)
    }
    if (typeof event.input_tokens === 'number') {
      inputTokens = Math.max(inputTokens ?? 0, event.input_tokens)
    }
    if (typeof event.output_tokens === 'number') {
      outputTokens = Math.max(outputTokens ?? 0, event.output_tokens)
    }
    if (event.usage && typeof event.usage === 'object') {
      if (typeof event.usage.input_tokens === 'number') {
        inputTokens = Math.max(inputTokens ?? 0, event.usage.input_tokens)
      }
      if (typeof event.usage.output_tokens === 'number') {
        outputTokens = Math.max(outputTokens ?? 0, event.usage.output_tokens)
      }
      if (typeof event.usage.total_tokens === 'number') {
        totalTokens = Math.max(totalTokens ?? 0, event.usage.total_tokens)
      }
    }
  }

  if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      exact: true
    }
  }

  if (Number.isFinite(totalTokens)) {
    return {
      input_tokens: estimateTokens(prompt),
      output_tokens: Math.max(totalTokens - estimateTokens(prompt), 1),
      exact: false
    }
  }

  return {
    input_tokens: estimateTokens(prompt),
    output_tokens: estimateTokens(outputText),
    exact: false
  }
}

function extractSessionId(events) {
  for (const event of events) {
    if (event.type === 'thread.started' || event.type === 'session.started') {
      return event.thread_id ?? event.session_id ?? event.id ?? null
    }
  }
  return null
}

function extractOutputText(events, outputFile) {
  if (outputFile && fs.existsSync(outputFile)) {
    return fs.readFileSync(outputFile, 'utf8').trim()
  }

  const text = events.map(event => {
    return [
      event.output_text,
      event.text,
      event.delta,
      pluckText(event.message),
      pluckText(event.content)
    ].find(Boolean)
  }).filter(Boolean).join('\n').trim()

  return text
}

function extractStructured(stage, outputText, stdout, stderr) {
  const parsed = extractJsonObject(outputText)
  if (parsed && validateStageResult(stage, parsed)) {
    return parsed
  }
  const err = new Error(`Unable to parse ${stage} result from Codex output`)
  err.name = 'StageSchemaError'
  err.stage = stage
  err.outputText = outputText
  err.stdout = stdout
  err.stderr = stderr
  throw err
}

async function runCodex(args, { prompt, cwd, timeoutMs, outputFile, rawOutputPath, stage, onEvent, onSessionStarted, onSpawn }) {
  return await new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (typeof onSpawn === 'function') {
      try { onSpawn(child) } catch {}
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let sessionIdCaptured = null
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    const handleEventInternal = parsed => {
      if (!sessionIdCaptured && (parsed?.type === 'thread.started' || parsed?.type === 'session.started')) {
        const id = parsed.thread_id ?? parsed.session_id ?? parsed.id ?? null
        if (id) {
          sessionIdCaptured = id
          if (typeof onSessionStarted === 'function') {
            try { onSessionStarted(id) } catch {}
          }
        }
      }
    }

    const lineStream = createLineStream(line => {
      try {
        const parsed = JSON.parse(line)
        handleEventInternal(parsed)
        if (onEvent) onEvent(parsed, line)
      } catch {
        // Non-JSON lines (startup banners, warnings) — ignore for event stream
      }
    })

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      lineStream.push(chunk)
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
      lineStream.flush()
      if (rawOutputPath) {
        fs.writeFileSync(rawOutputPath, stdout, 'utf8')
      }
      if (timedOut) {
        reject(new Error(`${stage} timed out after ${timeoutMs}ms`))
        return
      }
      if (exitCode !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${stage} exited with code ${exitCode}`))
        return
      }

      const events = parseJsonLines(stdout)
      const outputText = extractOutputText(events, outputFile)
      const usage = extractUsage(events, prompt, outputText)
      let structured
      try {
        structured = extractStructured(stage, outputText, stdout, stderr)
      } catch (error) {
        reject(error)
        return
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        events,
        outputText,
        structured,
        usage,
        sessionId: sessionIdCaptured ?? extractSessionId(events) ?? structured.session_id ?? null
      })
    })

    child.stdin.end(prompt)
  })
}

export async function runCodexExec({
  stage,
  model,
  prompt,
  cwd,
  schemaPath = null,
  outputFile,
  rawOutputPath = null,
  sandboxMode = 'workspace-write',
  timeoutMs = 60 * 60 * 1000,
  onEvent = null,
  onSessionStarted = null,
  onSpawn = null
}) {
  const args = ['exec', '--cd', cwd, '-m', model, '--color', 'never', '--json', '-o', outputFile]
  if (sandboxMode === 'workspace-write') {
    args.push('--full-auto')
  } else {
    args.push('-s', sandboxMode)
  }
  if (schemaPath) {
    args.push('--output-schema', schemaPath)
  }
  args.push('-')

  return await runCodex(args, {
    prompt,
    cwd,
    timeoutMs,
    outputFile,
    rawOutputPath,
    stage,
    onEvent,
    onSessionStarted,
    onSpawn
  })
}

export async function runCodexResume({
  stage,
  sessionId,
  model,
  prompt,
  cwd,
  outputFile,
  rawOutputPath = null,
  timeoutMs = 60 * 60 * 1000,
  onEvent = null,
  onSessionStarted = null,
  onSpawn = null
}) {
  const args = ['exec', 'resume', sessionId, '-m', model, '--full-auto', '--json', '-o', outputFile, '-']
  return await runCodex(args, {
    prompt,
    cwd,
    timeoutMs,
    outputFile,
    rawOutputPath,
    stage,
    onEvent,
    onSessionStarted: onSessionStarted ?? (id => { /* noop, caller already has sessionId */ }),
    onSpawn
  })
}
