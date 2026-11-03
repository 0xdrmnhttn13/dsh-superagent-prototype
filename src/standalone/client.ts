import { connect } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { BoardAction, AgentConfig, Board } from './collaboration.ts'
import { CodingProfile } from './coding-profile.ts'

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
export const ClientRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status') }).strict(),
  z.object({ kind: z.literal('list_tickets') }).strict(),
  z.object({ kind: z.literal('inspect_ticket'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('ticket_followup'), ticketId: ID, eventId: ID, text: z.string().trim().min(1).max(16_384) }).strict(),
  z.object({ kind: z.literal('submit'), investigationId: ID, eventId: ID, text: z.string().min(1).max(16_384), evidence: z.array(z.never()).default([]) }).strict(),
  z.object({ kind: z.literal('show'), investigationId: ID }).strict(),
  z.object({ kind: z.literal('board'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('workspace_bind'), ticketId: ID, source: z.string().min(1).max(1024), language: z.enum(['go', 'rust', 'cpp']).default('go') }).strict(),
  z.object({ kind: z.literal('workspace_grant'), ticketId: ID, paths: z.array(z.string()).min(1).max(12) }).strict(),
  z.object({ kind: z.literal('workspace_revoke'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('workspace_approve_write'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('workspace_inspect'), ticketId: ID, path: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal('workspace_list'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('workspace_diff'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('workspace_format'), ticketId: ID }).strict(),
  z.object({ kind: z.literal('board_action'), action: BoardAction }).strict(),
  z.object({ kind: z.literal('code_task'), ticketId: ID, title: z.string().trim().min(1).max(493), head: z.string().regex(/^[a-f0-9]{40,64}$/),
    paths: z.array(z.string()).min(1).max(12), profile: CodingProfile.default('default') }).strict(),
  z.object({ kind: z.literal('approve_agent'), ticketId: ID, agent: AgentConfig.omit({ tickets: true }), token: z.string().optional() }).strict(),
  z.object({ kind: z.literal('revoke_agent'), ticketId: ID, agentId: ID }).strict(),
  z.object({ kind: z.literal('claim_agent'), ticketId: ID, taskId: ID, agentId: ID }).strict(),
  z.object({ kind: z.literal('resolve_proposal'), ticketId: ID, proposalId: ID, approve: z.boolean() }).strict(),
  z.object({ kind: z.literal('collaboration'), ticketId: ID, session: ID, op: z.enum(['resume', 'heartbeat', 'pause', 'prepare', 'step']) }).strict(),
])
export type ClientRequest = z.input<typeof ClientRequest>

/** Owner-only socket client. UI approval is separate; the daemon never trusts this client's assertion of consent. */
export async function requestLocal(stateDir: string, input: ClientRequest): Promise<Record<string, unknown>> {
  const request = ClientRequest.parse(input)
  return await new Promise((resolve, reject) => {
    const socket = connect(join(stateDir, 'local.sock'))
    const chunks: Buffer[] = []
    let size = 0
    socket.setTimeout(request.kind === 'collaboration' && request.op === 'step' ? 60_000 : 10_000,
      () => socket.destroy(new Error('Superagent socket timeout')))
    socket.once('connect', () => socket.end(JSON.stringify(request)))
    socket.on('data', chunk => {
      size += chunk.length
      if (size > 1024 * 1024) socket.destroy(new Error('Superagent response too large'))
      else chunks.push(chunk)
    })
    socket.once('error', reject)
    socket.once('end', () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        if (response.ok !== true) reject(new Error(String(response.error ?? 'Superagent request failed')))
        else resolve(response)
      } catch (error) { reject(error) }
    })
  })
}

export function readBoard(response: Record<string, unknown>): z.infer<typeof Board> {
  return Board.parse(response.board)
}
