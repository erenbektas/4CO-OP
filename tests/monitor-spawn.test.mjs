import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowserLaunchPlan } from '../skill/4co-op/scripts/4coop-monitor-spawn.mjs'

const url = 'http://127.0.0.1:43121'

function availability({ commands = [], apps = [] } = {}) {
  return {
    command(command) {
      return commands.includes(command)
    },
    macApp(appName) {
      return apps.includes(appName)
    }
  }
}

test('windows auto prefers an app-capable browser when available', () => {
  const plan = buildBrowserLaunchPlan({
    platform: 'win32',
    browser: 'auto',
    url,
    availability: availability({ commands: ['msedge'] })
  })

  assert.equal(plan.command, 'cmd.exe')
  assert.deepEqual(plan.args, ['/c', 'start', '', 'msedge', `--app=${url}`, '--window-size=760,860'])
  assert.equal(plan.mode, 'app')
})

test('windows can fall back to the system URL opener', () => {
  const plan = buildBrowserLaunchPlan({
    platform: 'win32',
    browser: 'system',
    url,
    availability: availability()
  })

  assert.equal(plan.command, 'cmd.exe')
  assert.deepEqual(plan.args, ['/c', 'start', '', url])
  assert.equal(plan.mode, 'system')
})

test('macOS auto uses open -a with a supported installed app browser', () => {
  const plan = buildBrowserLaunchPlan({
    platform: 'darwin',
    browser: 'auto',
    url,
    availability: availability({ apps: ['Google Chrome'] })
  })

  assert.equal(plan.command, 'open')
  assert.deepEqual(plan.args, ['-a', 'Google Chrome', '--args', `--app=${url}`, '--window-size=760,860'])
  assert.equal(plan.mode, 'app')
})

test('linux auto uses an installed app-capable browser command', () => {
  const plan = buildBrowserLaunchPlan({
    platform: 'linux',
    browser: 'auto',
    url,
    availability: availability({ commands: ['chromium-browser'] })
  })

  assert.equal(plan.command, 'chromium-browser')
  assert.deepEqual(plan.args, [`--app=${url}`, '--window-size=760,860'])
  assert.equal(plan.mode, 'app')
})

test('linux falls back to xdg-open when no app browser is available', () => {
  const plan = buildBrowserLaunchPlan({
    platform: 'linux',
    browser: 'auto',
    url,
    availability: availability()
  })

  assert.equal(plan.command, 'xdg-open')
  assert.deepEqual(plan.args, [url])
  assert.equal(plan.mode, 'system')
})

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

// Smoke test: verify the error handler writes a valid error file on listen failure
test('error handler writes parsable error file on EADDRINUSE', () => {
  // Find an available port, bind a dummy server to it, then try to launch
  // our monitor server on the same port — it should fail with EADDRINUSE
  // and write .monitor-listen-error.json
  return new Promise((resolve, reject) => {
    const blocker = http.createServer((req, res) => { res.end('blocked') })
    blocker.listen(0, '127.0.0.1', () => {
      const blockedPort = blocker.address().port
      const tmpDir = path.join(process.cwd(), '.test-monitor-error-' + process.pid)
      fs.mkdirSync(tmpDir, { recursive: true })

      try {
        // Try to spawn monitor server on the already-bound port
        execFileSync(
          process.execPath,
          [
            'skill/4co-op/scripts/4coop-monitor-server.mjs',
            '--port', String(blockedPort),
            '--error-dir', tmpDir
          ],
          {
            timeout: 5000,
            stdio: 'pipe'
          }
        )
        // If we get here without error, the test is inconclusive
        blocker.close()
        reject(new Error('Expected server to exit with error but it succeeded'))
      } catch (err) {
        // Expected — server should have failed and written error file
        const errorFile = path.join(tmpDir, '.monitor-listen-error.json')
        if (!fs.existsSync(errorFile)) {
          blocker.close()
          reject(new Error(`Error file not found at ${errorFile}; stderr: ${err.stderr?.toString()}`))
          return
        }

        let detail
        try {
          detail = JSON.parse(fs.readFileSync(errorFile, 'utf8'))
        } catch (parseErr) {
          blocker.close()
          reject(new Error(`Error file contains invalid JSON: ${parseErr.message}`))
          return
        }

        // Validate required fields
        assert.equal(detail.code, 'EADDRINUSE', `Expected EADDRINUSE, got: ${detail.code}`)
        assert.ok(detail.message, 'message should be present')
        assert.ok(typeof detail.requested_port === 'number', 'requested_port should be a number')
        assert.equal(detail.requested_port, blockedPort, `requested_port should match bound port`)
        assert.ok(detail.pid, 'pid should be present')
        assert.ok(detail.timestamp, 'timestamp should be present')
        assert.match(detail.timestamp, /^\d{4}-\d{2}-\d{2}/, 'timestamp should be ISO format')

        blocker.close()
        // Cleanup
        try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* best-effort */ }
        resolve()
      }
    })
  })
})
