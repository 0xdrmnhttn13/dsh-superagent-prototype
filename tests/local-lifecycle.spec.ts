import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine, type Candidate, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { localKind } from '../src/sources/local.ts'
import { localActor, processLocalRequest, readLocalEvidence } from '../src/sources/local-ingress.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function rig(stateDir: string) {
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { local: { allowed: [{ id: localActor() }] } } },
    sources: { local: { enabled: true, config: { acceptPrompts: true } } },
  })
  store.saveSettings(settings)
  const sources = new SourceRegistry(() => store.settings())
  sources.register(localKind)
  const assessments: Candidate[] = []
  const launches: string[] = []
  const deliveries: string[] = []
  const engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: candidate => { assessments.push(candidate) } },
    executor: { start: ticket => { launches.push(ticket.id) },
      deliver: ticket => { deliveries.push(ticket.id) }, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
  })
  const host = {
    stateDir,
    source: {
      config: (kind: string) => kind === 'local' ? sources.instance<{ acceptPrompts: boolean }>('local')?.config : undefined,
      receive: (trigger: Trigger) => engine.receive(trigger),
      triggers: { get: (id: string) => store.triggers.get(id) },
    },
    allowedActor: (actor: string) => actor === localActor(),
  }
  return { store, sources, engine, assessments, launches, deliveries, host }
}

describe('local investigation lifecycle (real Engine and SQLite; simulated assessor/executor)', () => {
  it('ingests, authorizes, creates a ticket, delivers a follow-up, and restores persisted context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-e2e-'))
    dirs.push(dir)
    const r = rig(dir)
    const raw = 'synthetic INVALID_CONFIG'
    const evidence = [{ label: 'synthetic.log', base64: Buffer.from(raw).toString('base64') }]
    const first = await processLocalRequest(r.host, {
      kind: 'submit', eventId: 'event-1', investigationId: 'investigation-1',
      text: 'Investigate synthetic INVALID_CONFIG without modifying code', evidence,
    })
    expect(first).toMatchObject({ ok: true, status: 'stored', investigationId: 'investigation-1' })
    const digest = createHash('sha256').update(raw).digest('hex')
    expect(readLocalEvidence(dir, digest).toString('utf8')).toBe(raw)
    expect(JSON.stringify(r.store.triggers.get(String(first.triggerId)))).not.toContain(raw)
    r.engine.evaluateDue()
    expect(r.assessments).toHaveLength(1)
    expect(r.assessments[0]!.strength).toBe('explicit')
    const candidate = r.assessments[0]!
    const decision = r.engine.decide(String(first.triggerId), {
      evalId: candidate.evalId, kind: 'accept', title: 'Investigate local config', scope: 'Synthetic test only', reason: 'Explicit local request',
    })
    expect(decision.kind).toBe('accept')
    const ticketId = decision.ticketId!
    expect(r.launches).toContain(ticketId)
    expect(r.store.threads.get('local:investigation-1')?.subscriptions).toContain(ticketId)
    const assignment = r.store.tickets.get(ticketId)!.assignments[0]!
    r.engine.assignmentStarted(ticketId, assignment.id)
    const second = await processLocalRequest(r.host, {
      kind: 'submit', eventId: 'event-2', investigationId: 'investigation-1',
      text: 'Follow-up: broker rejected topic configuration', evidence: [],
    })
    expect(second).toMatchObject({ ok: true, status: 'stored' })
    expect(r.store.tickets.get(ticketId)?.inputs).toEqual([
      expect.objectContaining({ kind: 'trigger', triggerId: second.triggerId }),
    ])
    expect(r.deliveries).toContain(ticketId)
    const inputId = r.store.tickets.get(ticketId)!.inputs[0]!.id
    r.engine.inputsDelivered(ticketId, assignment.id, [inputId])
    r.engine.inputsRead(ticketId, [inputId])
    expect(await processLocalRequest(r.host, {
      kind: 'submit', eventId: 'event-2', investigationId: 'investigation-1', text: 'ignored duplicate',
    })).toMatchObject({ status: 'duplicate' })
    r.store.close()

    const restored = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      expect(restored.tickets.get(ticketId)?.origin.triggerId).toBe(first.triggerId)
      expect(restored.tickets.get(ticketId)?.inputs).toEqual([
        expect.objectContaining({ triggerId: second.triggerId, readAt: expect.any(String) }),
      ])
      expect(restored.read.threadTriggers('local:investigation-1').map(t => t.id)).toEqual([
        first.triggerId, second.triggerId,
      ])
      expect(readLocalEvidence(dir, digest).toString('utf8')).toBe(raw)
    } finally { restored.close() }
  })
  it('rejects a changed evidence digest and unsafe filesystem objects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-evidence-'))
    dirs.push(dir)
    const r = rig(dir)
    const raw = 'synthetic'
    await processLocalRequest(r.host, { kind: 'submit', eventId: 'x', investigationId: 'y', text: 'inspect',
      evidence: [{ label: 'safe.log', base64: Buffer.from(raw).toString('base64') }] })
    const digest = createHash('sha256').update(raw).digest('hex')
    writeFileSync(join(dir, 'local-evidence', digest), 'tampered')
    expect(() => readLocalEvidence(dir, digest)).toThrow('digest mismatch')
    expect(() => readLocalEvidence(dir, '../secrets')).toThrow('Invalid evidence digest')
    r.store.close()
  })
})
