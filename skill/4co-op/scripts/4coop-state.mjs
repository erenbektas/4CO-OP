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
    metrics: null
  }
}

export function loadRunState(paths, runId) {
  const runtimePaths = paths.runId === runId ? paths : { ...paths, runId, stateFile: paths.stateFile }
  return readJsonIfExists(runtimePaths.stateFile)
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
  const nextState = updater(structuredClone(current)) ?? current
  writeJson(paths.stateFile, nextState)
  return nextState
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
