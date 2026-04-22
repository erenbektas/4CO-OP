import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, formatLogTimestamp } from './4coop-paths.mjs'

const MAX_STRING_LENGTH = 2000

function sanitizeString(value) {
  if (value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`
  }
  return value
}

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return sanitizeString(value)
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item))
  }
  if (typeof value === 'object' && value !== null) {
    const nextObject = {}
    for (const [key, nestedValue] of Object.entries(value)) {
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
