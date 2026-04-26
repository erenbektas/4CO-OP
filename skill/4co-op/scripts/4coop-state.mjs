import fs from 'node:fs'
import { ensureDir, pathExists, readJsonIfExists, writeJson } from './4coop-paths.mjs'

export function createInitialRunState({ runId, featureRequest, worktree = null, monitorPort = null, logFile = null }) {
  return {
    run_id: runId,
    feature_request: featureRequest,
    created_at: new Date().toISOString(),
    status: 'planning',
    log_file: logFile,
    monitor_port: monitorPort,
    plan: {
      path: null,
      acceptance_checklist: [],
      file_structure_hint: [],
      definition_of_done: ''
    },
    worktree: worktree ?? {
      path: null,
      branch: null,
      base: null
    },
    builder: {
      codex_session_id: null,
      commit_sha: null,
      files_changed: [],
      tests_added: [],
      build: null,
      tests: null,
      lint: null
    },
    spec_check: {
      results: [],
      escalated_ids: []
    },
    github: {
      repo: null,
      url: null
    },
    pr: null,
    reviewer: {
      issues: []
    },
    fixer: {
      iterations: 0,
      commits: []
    },
    gatekeeper: {
      iteration: 0,
      verdict: null,
      severity: null,
      issues: []
    },
    narrator_log: [],
    metrics: null,
    sessions: {},
    suspended_at: null,
    suspend_reason: null,
    resume_count: 0,
    last_stage: null
  }
}

export function loadRunState(paths, runId) {
  const runtimePaths = paths.runId === runId ? paths : { ...paths, runId, stateFile: paths.stateFile }
  const state = readJsonIfExists(runtimePaths.stateFile)
  if (!state) return null
  return backfillStateDefaults(state)
}

export function backfillStateDefaults(state) {
  if (!state.sessions || typeof state.sessions !== 'object') {
    state.sessions = {}
  }
  if (!('suspended_at' in state)) state.suspended_at = null
  if (!('suspend_reason' in state)) state.suspend_reason = null
  if (!('resume_count' in state)) state.resume_count = 0
  if (!('last_stage' in state)) state.last_stage = null
  return state
}

export function saveRunState(paths, state) {
  ensureDir(paths.runDir)
  writeJson(paths.stateFile, state)
  return state
}

export function updateRunState(paths, updater) {
  const current = readJsonIfExists(paths.stateFile)
  if (!current) {
    throw new Error(`Run state not found at ${paths.stateFile}`)
  }
  const nextState = updater(structuredClone(backfillStateDefaults(current))) ?? current
  writeJson(paths.stateFile, nextState)
  return nextState
}

export function recordSessionId(paths, { stage, callIndex, sessionId, tool }) {
  if (!sessionId) return null
  return updateRunState(paths, state => {
    state.sessions = state.sessions ?? {}
    state.sessions[stage] = state.sessions[stage] ?? {}
    state.sessions[stage][String(callIndex)] = {
      session_id: sessionId,
      tool: tool ?? null,
      captured_at: new Date().toISOString()
    }
    if (stage === 'builder' && tool === 'codex') {
      state.builder = state.builder ?? {}
      state.builder.codex_session_id = sessionId
    }
    return state
  })
}

export function getLatestSessionId(state, stage) {
  const bucket = state?.sessions?.[stage]
  if (!bucket) return null
  const indexes = Object.keys(bucket).map(key => Number(key)).filter(Number.isFinite)
  if (!indexes.length) return null
  const latest = Math.max(...indexes)
  return bucket[String(latest)]?.session_id ?? null
}

export function markStateSuspended(paths, reason) {
  return updateRunState(paths, state => {
    state.status = 'suspended'
    state.suspend_reason = reason ?? state.suspend_reason ?? 'user'
    state.suspended_at = new Date().toISOString()
    return state
  })
}

export function markStateResumed(paths, nextStatus = 'running') {
  return updateRunState(paths, state => {
    state.status = nextStatus
    state.resume_count = (state.resume_count ?? 0) + 1
    return state
  })
}

export function writeStageInFlight(paths, { stage, callIndex, tool, sessionId = null, promptPath = null }) {
  if (!paths.stageInFlightFile) return null
  const payload = {
    stage,
    call_index: callIndex,
    tool,
    session_id: sessionId,
    prompt_path: promptPath,
    pid: process.pid,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  }
  writeJson(paths.stageInFlightFile, payload)
  return payload
}

export function touchStageInFlight(paths, patch = {}) {
  if (!paths.stageInFlightFile) return null
  const current = readJsonIfExists(paths.stageInFlightFile)
  if (!current) return null
  const next = {
    ...current,
    ...patch,
    heartbeat_at: new Date().toISOString()
  }
  writeJson(paths.stageInFlightFile, next)
  return next
}

export function readStageInFlight(paths) {
  if (!paths.stageInFlightFile) return null
  return readJsonIfExists(paths.stageInFlightFile)
}

export function clearStageInFlight(paths) {
  if (!paths.stageInFlightFile) return
  if (pathExists(paths.stageInFlightFile)) {
    fs.unlinkSync(paths.stageInFlightFile)
  }
}

export function loadActiveSession(paths) {
  return readJsonIfExists(paths.activeFile)
}

export function saveActiveSession(paths, session) {
  writeJson(paths.activeFile, session)
  return session
}

export function clearActiveSession(paths) {
  if (pathExists(paths.activeFile)) {
    fs.unlinkSync(paths.activeFile)
  }
}

export function appendNarratorEntry(paths, entry) {
  return updateRunState(paths, state => {
    state.narrator_log.push(entry)
    return state
  })
}
