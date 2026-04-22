import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

async function getOpenPort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  server.close()
  await once(server, 'close')
  return address.port
}

async function startMonitorServer(port) {
  const child = spawn(process.execPath, ['skill/4co-op/scripts/4coop-monitor-server.mjs', '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe']
  })

  let stderr = ''
  const onData = (chunk) => {
    stderr += chunk.toString()
  }
  child.stderr.on('data', onData)

  const deadline = Date.now() + 5000
  while (!stderr.includes('[monitor] listening')) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`monitor failed to start: ${stderr}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  return child
}

test('sanitizeCall keeps useful metadata when payload exceeds total cap', async (t) => {
  const port = await getOpenPort()
  const child = await startMonitorServer(port)

  t.after(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' })
    } catch {
      child.kill('SIGKILL')
    }
  })

  const hugeOutputParts = Array.from({ length: 20 }, () => 'x'.repeat(25000))
  const payload = {
    state: {
      rows: [
        {
          key: 'build',
          label: 'Build',
          tokens: 1,
          runtime_ms: 2,
          calls: 3,
          active: false,
          last_call: {
            started_at: '2026-04-21T00:00:00.000Z',
            ended_at: '2026-04-21T00:00:01.000Z',
            stage: 'builder',
            error_type: 'validation_error',
            call_id: 42,
            output_parts: hugeOutputParts
          }
        }
      ]
    }
  }

  const postResponse = await fetch(`http://127.0.0.1:${port}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  assert.equal(postResponse.status, 200)

  const detailResponse = await fetch(`http://127.0.0.1:${port}/stage/build/detail`)
  assert.equal(detailResponse.status, 200)
  const detailPayload = await detailResponse.json()
  assert.equal(detailPayload.ok, true)
  assert.equal(detailPayload.detail._truncated, true)
  assert.equal(detailPayload.detail.stage, 'builder')
  assert.equal(detailPayload.detail.error_type, 'validation_error')
  assert.equal(detailPayload.detail.call_id, 42)
})
