import { z } from 'zod'
import { reached, type Ticket, type Trigger } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { localActor, readLocalEvidence } from '../sources/local-ingress.ts'

export const Findings = z.object({
  problem_statement: z.string().trim().min(1).max(4000),
  evidence_examined: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64),
  hypotheses: z.array(z.object({ hypothesis: z.string().trim().min(1).max(4000),
    supporting: z.array(z.string().max(2000)).max(32), contradicting: z.array(z.string().max(2000)).max(32) }).strict()).max(24),
  remaining_uncertainty: z.array(z.string().max(2000)).max(32),
  recommended_next_steps: z.array(z.string().max(2000)).max(32),
}).strict()
export type Findings = z.infer<typeof Findings>

/** No unscoped evidence read is exposed to a Pi session. */
export function ticketEvidence(store: Store, stateDir: string, ticketId: string, triggerId: string, digest: string): string {
  const config = store.settings().sources.local
  if (!config?.enabled || config.config.acceptPrompts !== true || config.config.allowEvidenceRead !== true) throw new Error('Evidence reading disabled')
  const ticket = store.tickets.get(ticketId)
  const trigger = store.triggers.get(triggerId)
  if (!ticket || !trigger || ticket.ended?.by === 'human' || ticket.mandate.actor.source !== 'local'
    || ticket.mandate.actor.id !== localActor() || trigger.source !== 'local' || trigger.actor.id !== ticket.mandate.actor.id
    || !reached(ticket, trigger, key => store.threads.get(key)) && !ticket.origin.triggerIds.includes(triggerId)) {
    throw new Error('Evidence not authorized for ticket')
  }
  const refs = Array.isArray(trigger.meta.evidence) ? trigger.meta.evidence : []
  if (!refs.some(ref => typeof ref === 'object' && ref !== null && 'sha256' in ref && ref.sha256 === digest && 'id' in ref && ref.id === digest)) {
    throw new Error('Evidence digest not attached to trigger')
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(readLocalEvidence(stateDir, digest))
  if (decoded.includes('\0')) throw new Error('Binary evidence is not readable as text')
  return decoded
}

export function validateFindings(store: Store, stateDir: string, ticket: Ticket, value: unknown): Findings {
  const findings = Findings.parse(value)
  const triggers: Trigger[] = [ticket.origin.triggerId, ...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])]
    .flatMap(id => store.triggers.get(id) ?? [])
  for (const digest of findings.evidence_examined) {
    const trigger = triggers.find(item => Array.isArray(item.meta.evidence) && item.meta.evidence.some(ref =>
      typeof ref === 'object' && ref !== null && 'sha256' in ref && ref.sha256 === digest))
    if (!trigger) throw new Error('Finding cites evidence outside ticket')
    ticketEvidence(store, stateDir, ticket.id, trigger.id, digest)
  }
  return findings
}
