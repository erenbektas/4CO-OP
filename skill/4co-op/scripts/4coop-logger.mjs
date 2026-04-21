import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, formatLogTimestamp } from './4coop-paths.mjs'

const REDACTED_KEY_PATTERN = /(prompt|input|output|path|file|branch|url|plan_markdown|body_markdown|quote|feature_request|feature)/i
const MAX_STRING_LENGTH = 200
const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s]*/g
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/gi
const RELATIVE_PATH_PATTERN = /(^|[\s(])(?:\.{1,2}[\\/]|[\\/])[^\s)]+/g
const COMMIT_SHA_PATTERN = /\b[0-9a-f]{7,40}\b/gi

function redactLongString(value) {
  return `[redacted-long-string length=${value.length}]`
}

function redactSensitiveString() {
  return '[redacted-sensitive-string]'
}

function sanitizeString(value) {
  if (value.length > MAX_STRING_LENGTH) {
    return redactLongString(value)
  }

  if (
    WINDOWS_PATH_PATTERN.test(value) ||
    URL_PATTERN.test(value) ||
    RELATIVE_PATH_PATTERN.test(value) ||
    COMMIT_SHA_PATTERN.test(value)
  ) {
    WINDOWS_PATH_PATTERN.lastIndex = 0
    URL_PATTERN.lastIndex = 0
    RELATIVE_PATH_PATTERN.lastIndex = 0
    COMMIT_SHA_PATTERN.lastIndex = 0
    return redactSensitiveString()
  }

  WINDOWS_PATH_PATTERN.lastIndex = 0
  URL_PATTERN.lastIndex = 0
  RELATIVE_PATH_PATTERN.lastIndex = 0
  COMMIT_SHA_PATTERN.lastIndex = 0
  return value
}

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return sanitizeString(value)
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item)).filter(item => item !== undefined)
  }
  if (typeof value === 'object' && value !== null) {
    const nextObject = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      if (REDACTED_KEY_PATTERN.test(key)) {
        continue
      }
      nextObject[key] = sanitizeValue(nestedValue)
    }
    return nextObject
  }
  return value
}

export function createLogger({ projectRoot, logDir, existingFile = null }) {
  const resolvedDir = path.isAbsolute(logDir) ? logDir : path.join(projectRoot, logDir)
  ensureDir(resolvedDir)
  const filePath = existingFile ?? path.join(resolvedDir, `${formatLogTimestamp()}.log`)

  return {
    filePath,
    write(type, payload = {}) {
      const line = {
        type,
        ts: Date.now(),
        ...sanitizeValue(payload)
      }
      fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8')
      return line
    }
  }
}
