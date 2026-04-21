import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const orchestratorScript = path.join(scriptDir, '..', 'skill', '4co-op', 'scripts', '4coop-orchestrator.mjs')
const result = spawnSync(process.execPath, [orchestratorScript, ...process.argv.slice(2)], {
  stdio: 'inherit'
})

if (result.error) {
  throw result.error
}

process.exitCode = result.status ?? 1
