import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateProjectConfig } from '../skill/4co-op/scripts/4coop-config.mjs'
import { getRuntimePaths } from '../skill/4co-op/scripts/4coop-paths.mjs'

function makeProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '4coop-migrate-'))
}

function writeProjectOverride(projectRoot, value) {
  const paths = getRuntimePaths(projectRoot)
  fs.mkdirSync(path.dirname(paths.projectConfigOverridePath), { recursive: true })
  fs.writeFileSync(paths.projectConfigOverridePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return paths.projectConfigOverridePath
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('migrateProjectConfig rewrites v1 "auto" browser default to "system"', () => {
  const projectRoot = makeProjectRoot()
  const overridePath = writeProjectOverride(projectRoot, {
    version: 1,
    monitor_window: { enabled: true, port: 0, auto_launch: true, browser: 'auto' }
  })

  const result = migrateProjectConfig(projectRoot)
  assert.equal(result.migrated, true)
  assert.equal(result.to, 2)

  const updated = readJson(overridePath)
  assert.equal(updated.monitor_window.browser, 'system')
  assert.equal(updated.version, 2)
})

test('migrateProjectConfig preserves explicit non-auto browser values on v1', () => {
  const projectRoot = makeProjectRoot()
  const overridePath = writeProjectOverride(projectRoot, {
    version: 1,
    monitor_window: { enabled: true, port: 0, auto_launch: true, browser: 'chrome' }
  })

  const result = migrateProjectConfig(projectRoot)
  assert.equal(result.migrated, true)

  const updated = readJson(overridePath)
  assert.equal(updated.monitor_window.browser, 'chrome', 'explicit user choice is preserved')
  assert.equal(updated.version, 2)
})

test('migrateProjectConfig preserves explicit "auto" set on v2 (user choice, not stale default)', () => {
  const projectRoot = makeProjectRoot()
  const overridePath = writeProjectOverride(projectRoot, {
    version: 2,
    monitor_window: { enabled: true, port: 0, auto_launch: true, browser: 'auto' }
  })

  const result = migrateProjectConfig(projectRoot)
  assert.equal(result.migrated, false)

  const updated = readJson(overridePath)
  assert.equal(updated.monitor_window.browser, 'auto')
  assert.equal(updated.version, 2)
})

test('migrateProjectConfig is a no-op when no project override exists', () => {
  const projectRoot = makeProjectRoot()
  const result = migrateProjectConfig(projectRoot)
  assert.equal(result.migrated, false)
  assert.equal(result.reason, 'no-project-config')
})

test('migrateProjectConfig promotes stale gpt-5.3-codex defaults to gpt-5.4 for builder and fixer', () => {
  const projectRoot = makeProjectRoot()
  const overridePath = writeProjectOverride(projectRoot, {
    version: 1,
    models: {
      builder: { cli: 'codex', model: 'gpt-5.3-codex', tag_display: '5.3-Codex' },
      fixer: { cli: 'codex', model: 'gpt-5.3-codex', tag_display: '5.3-Codex' }
    }
  })

  const result = migrateProjectConfig(projectRoot)
  assert.equal(result.migrated, true)

  const updated = readJson(overridePath)
  assert.equal(updated.models.builder.model, 'gpt-5.4')
  assert.equal(updated.models.builder.tag_display, '5.4')
  assert.equal(updated.models.fixer.model, 'gpt-5.4')
  assert.equal(updated.models.fixer.tag_display, '5.4')
  assert.equal(updated.version, 2)
})

test('migrateProjectConfig preserves an explicit non-default model choice for builder', () => {
  const projectRoot = makeProjectRoot()
  const overridePath = writeProjectOverride(projectRoot, {
    version: 1,
    models: {
      builder: { cli: 'codex', model: 'gpt-5.3', tag_display: '5.3' },
      fixer: { cli: 'codex', model: 'gpt-5.3-codex', tag_display: '5.3-Codex' }
    }
  })

  migrateProjectConfig(projectRoot)
  const updated = readJson(overridePath)
  assert.equal(updated.models.builder.model, 'gpt-5.3', 'explicit builder choice preserved')
  assert.equal(updated.models.builder.tag_display, '5.3')
  assert.equal(updated.models.fixer.model, 'gpt-5.4', 'stale fixer default still migrated')
})
