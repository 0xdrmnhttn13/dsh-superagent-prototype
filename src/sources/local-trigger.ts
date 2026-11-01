/** Pure event mapping for a future authenticated local investigation Source.
 * No file reads, network actions, authorization, or execution occur here.
 */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const LOCAL_SOURCE = 'local'
export const LocalEvidence = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().trim().min(1).max(160),
}).strict()

/** Caller MUST be trusted. Ingress must assign actor from authentication, not a user-supplied field. */
export const LocalInvestigationEvent = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  investigationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  actor: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  at: z.iso.datetime({ offset: true }),
  text: z.string().trim().min(1).max(16_384),
  evidence: z.array(LocalEvidence).max(16).default([]),
}).strict()
export type LocalInvestigationEvent = z.input<typeof LocalInvestigationEvent>

/** All follow-ups with the same investigationId subscribe to one persistent Thread.
 * Evidence payloads are intentionally not part of Trigger.text or Trigger.meta.
 */
export function localTrigger(input: LocalInvestigationEvent): Trigger {
  const event = LocalInvestigationEvent.parse(input)
  return {
    id: key(LOCAL_SOURCE, event.id),
    source: LOCAL_SOURCE,
    threads: [{ source: LOCAL_SOURCE, id: event.investigationId }],
    actor: { source: LOCAL_SOURCE, id: event.actor },
    human: true,
    addressed: 'direct',
    at: event.at,
    text: event.text,
    meta: {
      eventId: event.id,
      investigationId: event.investigationId,
      evidence: event.evidence,
    },
  }
}
