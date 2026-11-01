/** Owner-only Unix-socket intake for explicit local engineering investigations.
 * No TCP listener or arbitrary actor impersonation is supported.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import { localTrigger, LOCAL_SOURCE } from './local-trigger.ts'

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const MAX_EVIDENCE = 64 * 1024
const MAX_WIRE = 512 * 1024
const EvidenceUpload = z.object({
  label: z.string().trim().min(1).max(160).refine(label => !/[\\/]/.test(label), 'Use a filename, not a path'),
  base64: z.string().max(90_000),
}).strict()
const Submit = z.object({
  kind: z.literal('submit'),
  eventId: ID,
  investigationId: ID,
  text: z.string().trim().min(1).max(16_384),
  evidence: z.array(EvidenceUpload).max(4).default([]),
}).strict()
const Request = z.discriminatedUnion('kind', [Submit, z.object({ kind: z.literal('status') }).strict()])
export type LocalRequest = z.input<typeof Request>

export interface IngressHost {
  stateDir: string
  source: {
    config(kind: string): { acceptPrompts: boolean } | undefined
    receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
    triggers: { get(id: string): Trigger | undefined }
  }
  allowedActor(actor: string): boolean
}

/** Actor identity is derived from the daemon's OS uid, never from request JSON. */
export function localActor(): string {
  if (!process.getuid) throw new Error('Local socket requires an OS uid')
  return `uid-${process.getuid()}`
}

export const localSocketPath = (stateDir: string): string => join(stateDir, 'local.sock')

/** Reject directories which could expose sensitive evidence or the local socket to another OS user. */
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Refusing unsafe state directory permissions: ${path} (require owner-only 0700)`)
  }
}

function evidenceOf(stateDir: string, uploads: z.infer<typeof EvidenceUpload>[]) {
  if (!uploads.length) return []
  const dir = join(stateDir, 'local-evidence')
  privateDirectory(dir)
  return uploads.map(upload => {
    const data = Buffer.from(upload.base64, 'base64')
    if (!data.length || data.length > MAX_EVIDENCE || data.toString('base64') !== upload.base64) {
      throw new Error('Invalid evidence: expected canonical base64 of 1-65536 bytes')
    }
    const sha256 = createHash('sha256').update(data).digest('hex')
    const path = join(dir, sha256)
    if (!existsSync(path)) {
      try { writeFileSync(path, data, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stored = lstatSync(path)
    if (!stored.isFile() || (stored.mode & 0o077) !== 0 || (process.getuid && stored.uid !== process.getuid())
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) {
      throw new Error('Unsafe or invalid stored evidence')
    }
    return { id: sha256, sha256, label: upload.label }
  })
}

/** Verify enablement and allowlist before storing private evidence or routing a Trigger into the Engine. */
export async function processLocalRequest(host: IngressHost, input: unknown): Promise<Record<string, unknown>> {
  const request = Request.parse(input)
  const actor = localActor()
  const enabled = host.source.config(LOCAL_SOURCE)?.acceptPrompts === true
  const allowed = host.allowedActor(actor)
  if (request.kind === 'status') return { ok: true, actor, enabled, allowed }
  if (!enabled || !allowed) return { ok: false, error: !enabled ? 'local_intake_disabled' : 'local_actor_not_allowlisted', actor }
  const id = key(LOCAL_SOURCE, request.eventId)
  if (host.source.triggers.get(id)) return { ok: true, status: 'duplicate', triggerId: id, investigationId: request.investigationId }
  const evidence = evidenceOf(host.stateDir, request.evidence)
  const trigger = localTrigger({
    id: request.eventId, investigationId: request.investigationId, actor,
    at: new Date().toISOString(), text: request.text, evidence,
  })
  const status = await host.source.receive(trigger)
  return { ok: status === 'stored' || status === 'duplicate', status, triggerId: trigger.id,
    investigationId: request.investigationId, evidence }
}

/** Bind an owner-only Unix socket. A crashed instance's stale socket is removed only after probing it. */
export async function listenLocalIngress(host: IngressHost): Promise<() => Promise<void>> {
  privateDirectory(host.stateDir)
  const path = localSocketPath(host.stateDir)
  if (Buffer.byteLength(path) > 95) throw new Error('Local socket path is too long; use a shorter stateDir')
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (!existing.isSocket() || (process.getuid && existing.uid !== process.getuid())) throw new Error('Refusing to remove a foreign local socket')
    const alive = await new Promise<boolean>(resolve => {
      const probe = connect(path)
      probe.once('connect', () => { probe.destroy(); resolve(true) })
      probe.once('error', () => { probe.destroy(); resolve(false) })
    })
    if (alive) throw new Error('Local socket already has a running listener')
    unlinkSync(path)
  }
  const server: Server = createServer({ allowHalfOpen: true }, socket => {
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false
    socket.setTimeout(10_000, () => { socket.destroy() })
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_WIRE) { tooLarge = true; socket.destroy(); return }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      if (tooLarge) return
      void (async () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          const result = await processLocalRequest(host, value)
          socket.end(JSON.stringify(result) + '\n')
        } catch (error) {
          const message = error instanceof z.ZodError ? 'invalid_request' : error instanceof SyntaxError ? 'invalid_json' : 'request_failed'
          socket.end(JSON.stringify({ ok: false, error: message }) + '\n')
        }
      })()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    })
    chmodSync(path, 0o600)
  } catch (error) {
    server.close()
    throw error
  }
  return async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path)
  }
}
