import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  ensureDir,
  pathExists,
  resolveBundledPath,
} from './4coop-paths.mjs'

const DEFAULT_WINDOW_SIZE = '760,860'
const AUTO_BROWSER = 'auto'

function normalizeBrowserPreference(browser) {
  const raw = String(browser ?? AUTO_BROWSER).trim()
  return raw || AUTO_BROWSER
}

function looksLikeExecutablePath(value) {
  return /[\\/]/.test(value) || /\.(?:app|exe|cmd|bat)$/i.test(value)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function commandExists(command) {
  if (!command) {
    return false
  }

  if (process.platform === 'win32') {
    const whereProbe = spawnSync('where.exe', [command], { encoding: 'utf8' })
    if (!whereProbe.error && whereProbe.status === 0) {
      return true
    }

    const escaped = String(command).replace(/'/g, "''")
    const powershellProbe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-Command '${escaped}' -ErrorAction Stop | Out-Null`
    ], {
      encoding: 'utf8'
    })
    return !powershellProbe.error && powershellProbe.status === 0
  }

  const shellProbe = spawnSync('sh', [
    '-lc',
    `command -v ${shellQuote(command)} >/dev/null 2>&1`
  ], {
    encoding: 'utf8'
  })
  return !shellProbe.error && shellProbe.status === 0
}

function macAppExists(appName) {
  const probe = spawnSync('open', ['-Ra', appName], {
    encoding: 'utf8'
  })
  return !probe.error && probe.status === 0
}

function windowsBrowserCandidates(preference) {
  const normalized = preference.toLowerCase()
  if (normalized === 'auto') {
    return ['msedge', 'chrome', 'brave']
  }
  if (normalized === 'system') {
    return []
  }
  if (normalized === 'edge') {
    return ['msedge']
  }
  if (normalized === 'chrome') {
    return ['chrome']
  }
  if (normalized === 'brave') {
    return ['brave']
  }
  return [preference]
}

function macBrowserCandidates(preference) {
  const normalized = preference.toLowerCase()
  if (normalized === 'auto') {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser']
  }
  if (normalized === 'system') {
    return []
  }
  if (normalized === 'edge') {
    return ['Microsoft Edge']
  }
  if (normalized === 'chrome') {
    return ['Google Chrome']
  }
  if (normalized === 'brave') {
    return ['Brave Browser']
  }
  return [preference]
}

function linuxBrowserCandidates(preference) {
  const normalized = preference.toLowerCase()
  if (normalized === 'auto') {
    return ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'brave']
  }
  if (normalized === 'system') {
    return []
  }
  if (normalized === 'edge') {
    return ['microsoft-edge', 'microsoft-edge-stable']
  }
  if (normalized === 'chrome') {
    return ['google-chrome', 'chromium', 'chromium-browser']
  }
  if (normalized === 'brave') {
    return ['brave-browser', 'brave']
  }
  return [preference]
}

export function buildBrowserLaunchPlan({
  platform = process.platform,
  browser = AUTO_BROWSER,
  url,
  windowSize = DEFAULT_WINDOW_SIZE,
  availability = {
    command: () => true,
    macApp: () => true
  }
}) {
  const preference = normalizeBrowserPreference(browser)
  const appArg = `--app=${url}`
  const sizeArg = `--window-size=${windowSize}`

  if (platform === 'win32') {
    if (looksLikeExecutablePath(preference)) {
      return {
        command: preference,
        args: [appArg, sizeArg],
        mode: 'app'
      }
    }

    for (const candidate of windowsBrowserCandidates(preference)) {
      if (availability.command(candidate)) {
        return {
          command: 'cmd.exe',
          args: ['/c', 'start', '', candidate, appArg, sizeArg],
          mode: 'app'
        }
      }
    }

    return {
      command: 'cmd.exe',
      args: ['/c', 'start', '', url],
      mode: 'system'
    }
  }

  if (platform === 'darwin') {
    if (looksLikeExecutablePath(preference)) {
      return {
        command: preference,
        args: [appArg, sizeArg],
        mode: 'app'
      }
    }

    for (const candidate of macBrowserCandidates(preference)) {
      if (availability.macApp(candidate)) {
        return {
          command: 'open',
          args: ['-a', candidate, '--args', appArg, sizeArg],
          mode: 'app'
        }
      }
    }

    return {
      command: 'open',
      args: [url],
      mode: 'system'
    }
  }

  if (looksLikeExecutablePath(preference)) {
    return {
      command: preference,
      args: [appArg, sizeArg],
      mode: 'app'
    }
  }

  for (const candidate of linuxBrowserCandidates(preference)) {
    if (availability.command(candidate)) {
      return {
        command: candidate,
        args: [appArg, sizeArg],
        mode: 'app'
      }
    }
  }

  return {
    command: 'xdg-open',
    args: [url],
    mode: 'system'
  }
}

function spawnDetached(command, args) {
  spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  }).unref()
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 1200) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(resource, {
      ...options,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function isHealthy(port) {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/ping`, {}, 300)
    return response.ok
  } catch {
    return false
  }
}

async function findOpenPort(preferredPort = 0) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(preferredPort, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferredPort
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(port, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthy(port)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

function readPortFile(monitorPortFile) {
  if (!pathExists(monitorPortFile)) {
    return null
  }

  const raw = fs.readFileSync(monitorPortFile, 'utf8').trim()
  if (!raw) {
    return null
  }

  const numeric = Number(raw)
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric
  }

  try {
    const parsed = JSON.parse(raw)
    return Number(parsed.port) || null
  } catch {
    return null
  }
}

function launchBrowser(browser, port) {
  const url = `http://127.0.0.1:${port}`
  const plan = buildBrowserLaunchPlan({
    browser,
    url,
    availability: {
      command: commandExists,
      macApp: macAppExists
    }
  })
  spawnDetached(plan.command, plan.args)
}

export async function postMonitorState(port, state) {
  try {
    await fetchWithTimeout(`http://127.0.0.1:${port}/state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state })
    }, 200)
  } catch {
    return false
  }
  return true
}

export async function ensureMonitor(paths, config, initialState) {
  if (!config.monitor_window.enabled) {
    return { enabled: false, port: null, reused: false }
  }

  // Clean up stale error file from a previous launch so it can't poison this run
  const errorFile = path.join(paths.runtimeDir, '.monitor-listen-error.json')
  if (pathExists(errorFile)) {
    try { fs.unlinkSync(errorFile) } catch { /* best-effort */ }
  }

  const cachedPort = readPortFile(paths.monitorPortFile)
  if (cachedPort && await isHealthy(cachedPort)) {
    await postMonitorState(cachedPort, initialState)
    return { enabled: true, port: cachedPort, reused: true }
  }

  const desiredPort = config.monitor_window.port || 0
  const port = await findOpenPort(desiredPort)
  const scriptPath = resolveBundledPath('scripts', '4coop-monitor-server.mjs')
  const child = spawn(process.execPath, [scriptPath, '--port', String(port), '--error-dir', paths.runtimeDir], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()

  const healthy = await waitForHealth(port)
  if (!healthy) {
    let cause = `Monitor server did not become healthy on port ${port}`
    if (pathExists(errorFile)) {
      try {
        const detail = JSON.parse(fs.readFileSync(errorFile, 'utf8'))
        cause = `Monitor listen failed on port ${detail.port ?? port}: ${detail.code} (${detail.message})`
        // Clean up after reading
        fs.unlinkSync(errorFile)
      } catch { /* fall through with generic message */ }
    }
    throw new Error(cause)
  }

  ensureDir(path.dirname(paths.monitorPortFile))
  fs.writeFileSync(paths.monitorPortFile, `${port}\n`, 'utf8')
  await postMonitorState(port, initialState)

  if (config.monitor_window.auto_launch) {
    try {
      launchBrowser(config.monitor_window.browser || AUTO_BROWSER, port)
    } catch {
      // The monitor is supplemental. If auto-launch fails, keep the pipeline running.
    }
  }

  return { enabled: true, port, reused: false }
}

export async function shutdownMonitor(paths, port) {
  const targetPort = port ?? readPortFile(paths.monitorPortFile)
  if (!targetPort) {
    return
  }

  try {
    await fetchWithTimeout(`http://127.0.0.1:${targetPort}/shutdown`, {
      method: 'POST'
    }, 300)
  } catch {
    return
  } finally {
    if (pathExists(paths.monitorPortFile)) {
      fs.unlinkSync(paths.monitorPortFile)
    }
  }
}
