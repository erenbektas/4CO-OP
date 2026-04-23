import dns from 'node:dns/promises'

const DEFAULT_ENDPOINTS = ['https://api.anthropic.com', 'https://api.openai.com']
const DEFAULT_SILENCE_MS = 90 * 1000
const DEFAULT_PROBE_TIMEOUT_MS = 8 * 1000
const DEFAULT_MAX_FAILURES = 3

function hostname(url) {
  try { return new URL(url).hostname } catch { return null }
}

async function probeDns(host) {
  if (!host) return false
  try {
    const records = await dns.lookup(host)
    return Boolean(records?.address)
  } catch {
    return false
  }
}

async function probeHttp(endpoint, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, { method: 'HEAD', signal: controller.signal })
    // Any HTTP response (including 401/404) means the network reached the auth layer.
    return typeof response?.status === 'number'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function networkProbe({ endpoints = DEFAULT_ENDPOINTS, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  for (const endpoint of endpoints) {
    const host = hostname(endpoint)
    const dnsOk = await probeDns(host)
    if (!dnsOk) continue
    const httpOk = await probeHttp(endpoint, timeoutMs)
    if (httpOk) return { ok: true, endpoint }
  }
  return { ok: false, endpoint: null }
}

export function createNetworkWatchdog({
  endpoints = DEFAULT_ENDPOINTS,
  silenceTimeoutMs = DEFAULT_SILENCE_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  maxConsecutiveFailures = DEFAULT_MAX_FAILURES,
  onNetworkLoss = () => {},
  onNetworkRecovered = () => {}
} = {}) {
  let consecutiveFailures = 0
  let silenceTimer = null
  let stopped = false
  let lastActivityAt = Date.now()

  async function runProbe() {
    if (stopped) return
    const result = await networkProbe({ endpoints, timeoutMs: probeTimeoutMs })
    if (result.ok) {
      if (consecutiveFailures > 0) {
        consecutiveFailures = 0
        try { onNetworkRecovered(result.endpoint) } catch {}
      }
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= maxConsecutiveFailures) {
      try { onNetworkLoss({ consecutiveFailures }) } catch {}
    }
  }

  function schedule() {
    if (stopped) return
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(async () => {
      if (stopped) return
      if (Date.now() - lastActivityAt >= silenceTimeoutMs) {
        await runProbe()
      }
      schedule()
    }, silenceTimeoutMs)
    silenceTimer.unref?.()
  }

  return {
    recordActivity() {
      lastActivityAt = Date.now()
    },
    async forceProbe() {
      await runProbe()
    },
    start() {
      stopped = false
      lastActivityAt = Date.now()
      schedule()
    },
    stop() {
      stopped = true
      if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
      }
    }
  }
}
