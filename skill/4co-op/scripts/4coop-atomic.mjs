import fs from 'node:fs'
import path from 'node:path'

export function writeFileAtomic(targetPath, data, encoding = 'utf8') {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  const handle = fs.openSync(tmpPath, 'w')
  try {
    fs.writeFileSync(handle, data, { encoding })
    try {
      fs.fsyncSync(handle)
    } catch {
      // fsync is best-effort; some filesystems don't support it.
    }
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(tmpPath, targetPath)
  return targetPath
}

export function writeJsonAtomic(targetPath, value) {
  return writeFileAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJsonSafe(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return null
  }
  const raw = fs.readFileSync(targetPath, 'utf8')
  if (!raw.trim()) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
