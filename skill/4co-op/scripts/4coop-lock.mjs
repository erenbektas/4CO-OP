import fs from 'node:fs'
import { pathExists, readJsonIfExists, writeJson } from './4coop-paths.mjs'

export function readLock(paths) {
  return readJsonIfExists(paths.lockFile)
}

export function lockIsFresh(lock, maxAgeHours = 24) {
  if (!lock?.started_at) {
    return false
  }
  const startedAt = new Date(lock.started_at).getTime()
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000
  return Number.isFinite(startedAt) && Date.now() - startedAt < maxAgeMs
}

export function acquireLock(paths, payload) {
  writeJson(paths.lockFile, payload)
  return payload
}

export function releaseLock(paths) {
  if (pathExists(paths.lockFile)) {
    fs.unlinkSync(paths.lockFile)
  }
}

export function readQueue(paths) {
  return readJsonIfExists(paths.queueFile) ?? []
}

export function writeQueue(paths, queue) {
  writeJson(paths.queueFile, queue)
  return queue
}

export function enqueue(paths, item) {
  const queue = readQueue(paths)
  queue.push(item)
  writeQueue(paths, queue)
  return queue
}

export function shiftQueue(paths) {
  const queue = readQueue(paths)
  const next = queue.shift() ?? null
  writeQueue(paths, queue)
  return { next, queue }
}
