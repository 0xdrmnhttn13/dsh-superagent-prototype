#!/usr/bin/env node
/** Owner-only local CLI. Starts a detached standalone Pi-powered investigation daemon. */
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { join } from 'node:path'
const args = process.argv.slice(2)
const cmd = args.shift()
const option = name => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) { console.error(`${name} needs a value`); process.exit(2) }
  return value
}
const stateDir = option('--state-dir') || process.env.SA_STATE_DIR || `${homedir()}/.superagent`
if (cmd === 'start') {
  const entry = new URL('../lib/daemon.mjs', import.meta.url)
  if (!existsSync(entry)) { console.error('Build first with pnpm build'); process.exit(2) }
  const child = spawn(process.execPath, [entry.pathname, stateDir],
    { detached: true, stdio: 'ignore' })
  child.unref()
  console.log(`Starting Superagent in ${stateDir} (pid ${child.pid}). Run sa status to verify.`)
  process.exit(0)
}
if (cmd === 'stop') {
  try {
    const pid = Number(readFileSync(join(stateDir, 'sa.pid'), 'utf8'))
    process.kill(pid, 'SIGTERM')
    console.log(`Stopping Superagent (pid ${pid})`)
  } catch (error) { console.error(`Cannot stop Superagent: ${error.message}`); process.exitCode = 1 }
  if (!process.exitCode) process.exit(0)
  process.exit(1)
}
let input
if (cmd === 'status') input = { kind: 'status' }
else if (cmd === 'tickets') input = { kind: 'list_tickets' }
else if (cmd === 'show') {
  const investigationId = option('--id')
  if (!investigationId) { console.error('show needs --id'); process.exit(2) }
  input = { kind: 'show', investigationId }
} else if (cmd === 'investigate' || cmd === 'followup') {
  const text = option('--prompt')
  if (!text) { console.error('Missing --prompt'); process.exit(2) }
  const investigationId = option('--id') || (cmd === 'investigate' ? randomUUID() : undefined)
  if (!investigationId) { console.error('followup needs --id'); process.exit(2) }
  const eventId = option('--event-id') || randomUUID()
  const evidenceFile = option('--evidence')
  const evidence = evidenceFile
    ? [{ label: evidenceFile.split('/').at(-1), base64: readFileSync(evidenceFile).toString('base64') }]
    : []
  input = { kind: 'submit', eventId, investigationId, text, evidence }
} else { console.error('Usage: sa start|status|tickets|investigate|followup|show|stop [--state-dir DIR] [--prompt TEXT] [--id ID] [--event-id ID] [--evidence FILE]'); process.exit(2) }
const socket = connect(join(stateDir, 'local.sock'))
socket.setTimeout(10_000, () => { console.error('Socket timeout'); socket.destroy(); process.exitCode = 1 })
const chunks = []
socket.on('connect', () => socket.end(JSON.stringify(input)))
socket.on('data', chunk => chunks.push(chunk))
socket.on('error', error => { console.error(`Cannot reach Superagent at ${stateDir}: ${error.message}. Run sa start --state-dir ${stateDir}`); process.exitCode = 1 })
socket.on('end', () => {
  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) { console.error('No response from local socket'); process.exitCode = 1; return }
  console.log(body)
  try { if (JSON.parse(body).ok !== true) process.exitCode = 1 } catch { process.exitCode = 1 }
})
