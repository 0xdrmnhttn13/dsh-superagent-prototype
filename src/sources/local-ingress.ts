/** Owner-only Unix-socket intake for explicit local engineering investigations.
 * No TCP listener or arbitrary actor impersonation is supported.
 */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { key, latestReport, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { localTrigger, LOCAL_SOURCE } from './local-trigger.ts'
import { BoardAction, AgentConfig, type Board, type Registry } from '../standalone/collaboration.ts'

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
const Show = z.object({ kind: z.literal('show'), investigationId: ID }).strict()
const Request = z.discriminatedUnion('kind', [Submit, Show, z.object({ kind: z.literal('status') }).strict(),
  z.object({ kind: z.literal('list_tickets') }).strict(),
  z.object({ kind: z.literal('inspect_ticket'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('board'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('board_action'), action: BoardAction }).strict(),
  z.object({ kind: z.literal('approve_agent'), ticketId: ID, agent: AgentConfig.omit({ tickets: true }), token: z.string().optional() }).strict(),
  z.object({ kind: z.literal('revoke_agent'), ticketId: ID, agentId: ID }).strict(),
  z.object({ kind: z.literal('claim_agent'), ticketId: ID, taskId: ID, agentId: ID }).strict(),
  z.object({ kind: z.literal('resolve_proposal'), ticketId: ID, proposalId: ID, approve: z.boolean() }).strict(),
  z.object({ kind: z.literal('collaboration'), ticketId: ID, session: ID, op: z.enum(['resume', 'heartbeat', 'pause', 'prepare', 'step']) }).strict(),
])
export type LocalRequest = z.input<typeof Request>

export interface IngressHost {
  stateDir: string
  source: {
    config(kind: string): { acceptPrompts: boolean } | undefined
    receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
    threads?: { get(key: string): { subscriptions: string[] } | undefined }
    tickets?: { get(id: string): Ticket | undefined; list?(): Ticket[] }
    triggers: { get(id: string): Trigger | undefined; latest?(thread: string): Trigger | undefined }
  }
  allowedActor(actor: string): boolean
  collaboration?: {
    board(ticketId: string): Board
    act(actorId: string, action: z.infer<typeof BoardAction>, token?: string): Board
    approve(ticketId: string, agent: z.infer<typeof AgentConfig>, token?: string): void
    revoke(ticketId: string, agentId: string): void
    registry(): Registry
    claim?(ticketId: string, taskId: string, agentId: string): Board
    resolve?(ticketId: string, proposalId: string, approve: boolean): Board
    presence?: {
      view(ticketId: string): { active: boolean; remaining: number; paused: boolean }
      resume(ticketId: string, session: string, maxTurns?: number): void
      heartbeat(ticketId: string, session: string): void
      pause(ticketId: string, session: string): void
      step(ticketId: string, session: string): Promise<Board>
      prepare?(ticketId: string, session: string): Board
    }
  }
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
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) {
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
    if (!stored.isFile() || (stored.mode & 0o777) !== 0o600 || (process.getuid && stored.uid !== process.getuid())
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) {
      throw new Error('Unsafe or invalid stored evidence')
    }
    return { id: sha256, sha256, label: upload.label }
  })
}

/** Read one local evidence blob by immutable digest.
 * This is an in-process primitive for a future authorized evidence reader, not a socket endpoint or worker tool.
 * Caller authorization and redaction are intentionally outside this function.
 */
export function readLocalEvidence(stateDir: string, sha256: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid evidence digest')
  const directory = join(stateDir, 'local-evidence')
  privateDirectory(directory)
  const path = join(directory, sha256)
  // O_NOFOLLOW prevents the final path from being replaced with a symbolic link.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_EVIDENCE || stat.size === 0
      || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Unsafe evidence file')
    }
    const data = readFileSync(fd)
    if (createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new Error('Evidence digest mismatch')
    }
    return data
  } finally {
    closeSync(fd)
  }
}

/** Verify enablement and allowlist before storing private evidence or routing a Trigger into the Engine. */
export async function processLocalRequest(host: IngressHost, input: unknown): Promise<Record<string, unknown>> {
  const request = Request.parse(input)
  const actor = localActor()
  const enabled = host.source.config(LOCAL_SOURCE)?.acceptPrompts === true
  const allowed = host.allowedActor(actor)
  if (request.kind === 'status') return { ok: true, actor, enabled, allowed }
  if (!enabled || !allowed) return { ok: false, error: !enabled ? 'local_intake_disabled' : 'local_actor_not_allowlisted', actor }
  const owned = (ticket: Ticket): boolean => ticket.mandate.actor.source === LOCAL_SOURCE && ticket.mandate.actor.id === actor
    && host.source.triggers.get(ticket.origin.triggerId)?.source === LOCAL_SOURCE
    && host.source.triggers.get(ticket.origin.triggerId)?.actor.id === actor
  if (request.kind === 'list_tickets') return { ok: true, tickets: (host.source.tickets?.list?.() ?? []).filter(owned)
    .slice(0, 100).map(ticket => ({ ticketId: ticket.id, title: ticket.title, investigationId:
      host.source.triggers.get(ticket.origin.triggerId)?.meta.investigationId, ended: ticket.ended ?? null,
      latestReport: latestReport(ticket)?.state ?? null })) }
  if (request.kind === 'inspect_ticket') {
    const ticket = host.source.tickets?.get(request.ticketId)
    if (!ticket || !owned(ticket)) return { ok: false, error: 'unknown_ticket' }
    return { ok: true, ticketId: ticket.id, title: ticket.title, investigationId:
      host.source.triggers.get(ticket.origin.triggerId)?.meta.investigationId, ended: ticket.ended ?? null,
      latestReport: latestReport(ticket)?.state ?? null }
  }
  if (request.kind === 'board') return { ok: true, board: host.collaboration?.board(request.ticketId) }
  if (request.kind === 'board_action') return { ok: true, board: host.collaboration?.act(actor, request.action) }
  if (request.kind === 'approve_agent') {
    host.collaboration?.approve(request.ticketId, { ...request.agent, tickets: [] }, request.token)
    return { ok: true }
  }
  if (request.kind === 'revoke_agent') { host.collaboration?.revoke(request.ticketId, request.agentId); return { ok: true } }
  if (request.kind === 'resolve_proposal') {
    if (!host.collaboration?.resolve) return { ok: false, error: 'proposal_unavailable' }
    return { ok: true, board: host.collaboration.resolve(request.ticketId, request.proposalId, request.approve) }
  }
  if (request.kind === 'collaboration') {
    const presence = host.collaboration?.presence
    if (!presence) return { ok: false, error: 'collaboration_unavailable' }
    if (request.op === 'resume') presence.resume(request.ticketId, request.session)
    else if (request.op === 'heartbeat') presence.heartbeat(request.ticketId, request.session)
    else if (request.op === 'pause') presence.pause(request.ticketId, request.session)
    else if (request.op === 'prepare') return { ok: true, board: presence.prepare?.(request.ticketId, request.session), presence: presence.view(request.ticketId) }
    else return { ok: true, board: await presence.step(request.ticketId, request.session), presence: presence.view(request.ticketId) }
    return { ok: true, presence: presence.view(request.ticketId) }
  }
  if (request.kind === 'claim_agent') {
    if (!host.collaboration?.claim) return { ok: false, error: 'agent_claim_unavailable' }
    return { ok: true, board: host.collaboration.claim(request.ticketId, request.taskId, request.agentId) }
  }
  if (request.kind === 'show') {
    const thread = host.source.threads?.get(`local:${request.investigationId}`)
    const tickets = (thread?.subscriptions ?? []).flatMap(id => host.source.tickets?.get(id) ?? [])
      .filter(ticket => ticket.mandate.actor.source === LOCAL_SOURCE && ticket.mandate.actor.id === actor
        && host.source.triggers.get(ticket.origin.triggerId)?.meta.investigationId === request.investigationId)
    const triggers = tickets.flatMap(ticket => [ticket.origin.triggerId, ...ticket.origin.triggerIds,
      ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])
      .map(id => host.source.triggers.get(id)).filter((trigger): trigger is Trigger => !!trigger && trigger.source === LOCAL_SOURCE
        && trigger.actor.id === actor && trigger.meta.investigationId === request.investigationId)
      .filter((trigger, index, all) => all.findIndex(item => item.id === trigger.id) === index)
    if (!tickets.length) return { ok: false, error: 'unknown_investigation' }
    return { ok: true, investigationId: request.investigationId,
      triggers: triggers.map(trigger => ({ triggerId: trigger.id, at: trigger.at, text: trigger.text, evidence: trigger.meta.evidence })),
      tickets: tickets.map(ticket => ({ ticketId: ticket.id, title: ticket.title, ended: ticket.ended ?? null,
        inputs: ticket.inputs.map(input => input.kind === 'trigger' ? { kind: input.kind, triggerId: input.triggerId, at: input.at }
          : { kind: input.kind, at: input.at }),
        assignments: ticket.assignments.map(assignment => ({ id: assignment.id, state: assignment.state,
          report: assignment.report ? { state: assignment.report.state, at: assignment.report.at,
            findings: (() => { try { return JSON.parse(assignment.report.summary) as unknown } catch { return assignment.report.summary } })() } : null })),
        latestReport: latestReport(ticket)?.state ?? null })) }
  }
  const id = key(LOCAL_SOURCE, request.eventId)
  const previous = host.source.triggers.get(id)
  if (previous) return previous.source === LOCAL_SOURCE && previous.actor.id === actor
    && previous.meta.investigationId === request.investigationId
    ? { ok: true, status: 'duplicate', triggerId: id, investigationId: request.investigationId }
    : { ok: false, error: 'event_id_conflict' }
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
    socket.setTimeout(60_000, () => { socket.destroy() })
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
