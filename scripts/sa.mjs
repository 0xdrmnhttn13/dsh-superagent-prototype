#!/usr/bin/env node
/** Minimal local socket client. No agent process is spawned and no GitHub data is uploaded. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
const args = process.argv.slice(2)
const cmd = args.shift()
const option = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const stateDir = option('--state-dir') || process.env.DSH_SUPERAGENT_STATE_DIR
if (!stateDir) {
  console.error('Set --state-dir or DSH_SUPERAGENT_STATE_DIR to the configured DSH stateDir')
  process.exit(2)
}
let input
if (cmd === 'status') input = { kind: 'status' }
else if (cmd === 'investigate' || cmd === 'followup') {
  const text = option('--prompt')
  if (!text) { console.error('Missing --prompt'); process.exit(2) }
  const investigationId = option('--id') || (cmd === 'investigate' ? randomUUID() : undefined)
  if (!investigationId) { console.error('followup needs --id'); process.exit(2) }
  const eventId = randomUUID()
  const evidenceFile = option('--evidence')
  const evidence = evidenceFile
    ? [{ label: evidenceFile.split('/').at(-1), base64: readFileSync(evidenceFile).toString('base64') }]
    : []
  input = { kind: 'submit', eventId, investigationId, text, evidence }
} else { console.error('Usage: node scripts/sa.mjs status|investigate|followup --state-dir DIR [--prompt TEXT] [--id ID] [--evidence FILE]'); process.exit(2) }
const socket = connect(join(stateDir, 'local.sock'))
socket.setTimeout(10_000, () => { console.error('Socket timeout'); socket.destroy(); process.exitCode = 1 })
const chunks = []
socket.on('connect', () => socket.end(JSON.stringify(input)))
socket.on('data', chunk => chunks.push(chunk))
socket.on('error', error => { console.error(error.message); process.exitCode = 1 })
socket.on('end', () => {
  const body = Buffer.concat(chunks).toString('utf8').trim()
  if (!body) { console.error('No response from local socket'); process.exitCode = 1; return }
  console.log(body)
  try { if (JSON.parse(body).ok !== true) process.exitCode = 1 } catch { process.exitCode = 1 }
})
