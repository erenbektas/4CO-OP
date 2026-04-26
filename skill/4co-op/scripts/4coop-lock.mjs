import fs from 'node:fs'
import { pathExists, readJsonIfExists, writeJson } from './4coop-paths.mjs'

const DEFAULT_HEARTBEAT_STALE_MS = 120 * 1000
const DEFAULT_MAX_AGE_HOURS = 24

function processAlive(pid) {
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function readLock(paths) {
  return readJsonIfExists(paths.lockFile)
}

export function lockIsFresh(lock, maxAgeHours = DEFAULT_MAX_AGE_HOURS, heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS) {
  if (!lock) return false

  if (lock.suspended === true) {
    return true
  }

  if (lock.pid && !processAlive(lock.pid)) {
    return false
  }

  if (lock.heartbeat_at) {
    const heartbeatTime = new Date(lock.heartbeat_at).getTime()
    if (Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime > heartbeatStaleMs) {
      return false
    }
  }

  if (!lock.started_at) {
    return Boolean(lock.pid)
  }
  const startedAt = new Date(lock.started_at).getTime()
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000
  return Number.isFinite(startedAt) && Date.now() - startedAt < maxAgeMs
}

export function acquireLock(paths, payload) {
  const now = new Date().toISOString()
  const lock = {
    pid: process.pid,
    heartbeat_at: now,
    ...payload,
    started_at: payload?.started_at ?? now
  }
  writeJson(paths.lockFile, lock)
  return lock
}

export function touchLockHeartbeat(paths, patch = {}) {
  const lock = readLock(paths)
  if (!lock) return null
  const updated = {
    ...lock,
    ...patch,
    heartbeat_at: new Date().toISOString()
  }
  writeJson(paths.lockFile, updated)
  return updated
}

export function markLockSuspended(paths, reason) {
  const lock = readLock(paths)
  if (!lock) return null
  const updated = {
    ...lock,
    suspended: true,
    suspend_reason: reason ?? lock.suspend_reason ?? 'user',
    suspended_at: new Date().toISOString()
  }
  writeJson(paths.lockFile, updated)
  return updated
}

export function markLockResumed(paths) {
  const lock = readLock(paths)
  if (!lock) return null
  const { suspended, suspend_reason, suspended_at, ...rest } = lock
  const updated = {
    ...rest,
    pid: process.pid,
    heartbeat_at: new Date().toISOString()
  }
  writeJson(paths.lockFile, updated)
  return updated
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
