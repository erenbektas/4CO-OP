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
