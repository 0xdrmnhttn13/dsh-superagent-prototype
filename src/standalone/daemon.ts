import { LocalRuntime } from './runtime.ts'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'

const stateDir = resolve(process.argv[2] ?? `${homedir()}/.superagent`)
const pidFile = resolve(stateDir, 'sa.pid')
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try { process.kill(pid, 0); throw new Error(`Superagent already running (pid ${pid})`) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  unlinkSync(pidFile)
}
const runtime = new LocalRuntime({ stateDir })
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  try { await runtime.shutdown() } finally { if (existsSync(pidFile) && readFileSync(pidFile, 'utf8') === String(process.pid)) unlinkSync(pidFile) }
}
try {
  await runtime.start()
  const fd = openSync(pidFile, 'wx', 0o600)
  writeFileSync(fd, String(process.pid)); closeSync(fd)
  console.log(`Superagent listening at ${stateDir}`)
  process.on('SIGTERM', () => { void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
  process.on('SIGINT', () => { void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
} catch (error) {
  console.error(error)
  if (existsSync(pidFile) && readFileSync(pidFile, 'utf8') === String(process.pid)) unlinkSync(pidFile)
  process.exitCode = 1
}
