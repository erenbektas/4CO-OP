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

function extractOutputText(envelope, stdout) {
  if (!envelope) {
    return stdout.trim()
  }

  const candidates = [
    envelope.result,
    envelope.output,
    envelope.message,
    envelope.content,
    envelope.response
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate.trim()
    }
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map(item => typeof item === 'string' ? item : item?.text)
        .filter(Boolean)
        .join('\n')
      if (joined) {
        return joined.trim()
      }
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

function extractStructured(stage, envelope, outputText) {
  const candidates = [
    envelope?.result,
    envelope?.response,
    envelope?.output,
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

export async function runClaudeStage({
  cli = 'claude',
  stage,
  model,
  prompt,
  cwd,
  timeoutMs = 20 * 60 * 1000
}) {
  return await new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'json']
    const child = spawn(cli, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
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
      const structured = extractStructured(stage, envelope, outputText)

      resolve({
        exitCode,
        stdout,
        stderr,
        envelope,
        outputText,
        structured,
        usage
      })
    })
  })
}
