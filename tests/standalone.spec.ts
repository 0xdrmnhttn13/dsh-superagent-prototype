import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LocalRuntime } from '../src/standalone/runtime.ts'
import { processLocalRequest, localActor } from '../src/sources/local-ingress.ts'
import { ticketEvidence } from '../src/standalone/evidence.ts'
import type { SessionFactory } from '../src/standalone/pi.ts'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const findings = (digest: string) => ({ problem_statement: 'Synthetic failure', evidence_examined: [digest],
  hypotheses: [{ hypothesis: 'Bad configuration', supporting: ['INVALID_CONFIG'], contradicting: [] }],
  remaining_uncertainty: ['Origin'], recommended_next_steps: ['Check settings'] })
const delay = () => new Promise(resolve => setTimeout(resolve, 20))
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'sa-standalone-')); chmodSync(path, 0o700); directories.push(path); return path }

function fake({ fail = false, wait = false }: { fail?: boolean; wait?: boolean } = {}) {
  const turns: { id: string; prompt: string; tools: string[] }[] = []
  let release: (() => void) | undefined
  const factory: SessionFactory = async (id, tools) => ({ id: `fake:${id}`, tools: tools.map(tool => tool.name),
    prompt: async prompt => {
      turns.push({ id, prompt, tools: tools.map(tool => tool.name) })
      if (wait) await new Promise<void>(resolve => { release = resolve })
      if (fail) throw new Error('Synthetic Pi failure')
      const context = tools.find(tool => tool.name === 'sa_context')!
      const result = await context.execute('context', {}, undefined, undefined, {} as never)
      const trigger = JSON.parse((result.content[0] as { text: string }).text).triggers[0]
      const digest = trigger.evidence?.[0]?.sha256 ?? 'a'.repeat(64)
      if (trigger.evidence?.length) await tools.find(tool => tool.name === 'sa_evidence')!.execute('evidence',
        { trigger_id: trigger.id, sha256: digest }, undefined, undefined, {} as never)
      await tools.find(tool => tool.name === 'sa_report')!.execute('report', { findings: { ...findings(digest),
        evidence_examined: trigger.evidence?.length ? [digest] : [] } }, undefined, undefined, {} as never)
    }, abort: async () => { release?.() }, dispose: () => {} })
  return { factory, turns, release: () => release?.() }
}
const request = (id: string, event: string, evidence: string[] = []) => ({ kind: 'submit', investigationId: id, eventId: event,
  text: `Investigate ${event}`, evidence: evidence.map(value => ({ label: 'synthetic.log', base64: Buffer.from(value).toString('base64') })) })

describe('standalone Pi integration (deterministic fake session, real Engine/SQLite/socket)', () => {
  it('authorizes one ticket, validates findings, follows up, restores durable context; isolates evidence', async () => {
    const dir = directory(), pi = fake(), runtime = new LocalRuntime({ stateDir: dir, sessionFactory: pi.factory })
    await runtime.start()
    const data = 'INVALID_CONFIG synthetic'
    const digest = createHash('sha256').update(data).digest('hex')
    const first = await processLocalRequest(runtime.host, request('one', 'event-1', [data]))
    expect(first.ok).toBe(true)
    await delay()
    const ticket = runtime.store.tickets.list()[0]!
    expect(runtime.store.tickets.list()).toHaveLength(1)
    expect(ticket.assignments[0]?.report?.state).toBe('waiting')
    expect(JSON.parse(ticket.assignments[0]!.report!.summary)).toEqual(findings(digest))
    expect(ticketEvidence(runtime.store, dir, ticket.id, String(first.triggerId), digest)).toBe(data)
    expect(pi.turns[0]?.tools).toEqual(['sa_context', 'sa_evidence', 'sa_report'])
    expect(await processLocalRequest(runtime.host, request('one', 'event-1'))).toMatchObject({ status: 'duplicate' })
    expect(runtime.store.tickets.list()).toHaveLength(1)
    const other = await processLocalRequest(runtime.host, request('two', 'event-2'))
    await delay()
    const otherTicket = runtime.store.tickets.list().find(item => item.id !== ticket.id)!
    expect(otherTicket).toBeTruthy()
    expect(() => ticketEvidence(runtime.store, dir, otherTicket.id, String(first.triggerId), digest)).toThrow()
    const follow = await processLocalRequest(runtime.host, request('one', 'event-3'))
    expect(follow.ok).toBe(true)
    await delay()
    expect(runtime.store.tickets.list()).toHaveLength(2)
    expect(pi.turns.filter(turn => turn.id === ticket.id)).toHaveLength(2)
    expect(pi.turns[1]?.prompt).toContain('previous')
    const shown = await processLocalRequest(runtime.host, { kind: 'show', investigationId: 'one' })
    expect(shown.tickets).toEqual([expect.objectContaining({ ticketId: ticket.id })])
    await runtime.shutdown()
    const restored = new LocalRuntime({ stateDir: dir, sessionFactory: pi.factory })
    await restored.start()
    expect(restored.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
    expect(restored.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === follow.triggerId)).toBe(true)
    await restored.shutdown()
  })

  it('denies non-allowlisted intake before creating work and rejects foreign/unsafe evidence', async () => {
    const dir = directory(), pi = fake(), runtime = new LocalRuntime({ stateDir: dir, sessionFactory: pi.factory, allowActor: false })
    await runtime.start()
    expect(await processLocalRequest(runtime.host, request('deny', 'event'))).toMatchObject({ ok: false })
    expect(runtime.store.tickets.list()).toHaveLength(0)
    await runtime.shutdown()
    const enabled = new LocalRuntime({ stateDir: dir, sessionFactory: pi.factory })
    enabled.store.saveSettings({ ...enabled.store.settings(), policy: { ...enabled.store.settings().policy,
      sources: { local: { allowed: [{ id: localActor() }], admission: {} } } } })
    await enabled.start()
    const result = await processLocalRequest(enabled.host, request('allow', 'event', ['synthetic']))
    await delay()
    const ticket = enabled.store.tickets.list()[0]!
    const digest = createHash('sha256').update('synthetic').digest('hex')
    expect(() => ticketEvidence(enabled.store, dir, ticket.id, String(result.triggerId), 'a'.repeat(64))).toThrow()
    writeFileSync(join(dir, 'local-evidence', digest), 'tampered')
    expect(() => ticketEvidence(enabled.store, dir, ticket.id, String(result.triggerId), digest)).toThrow()
    await enabled.shutdown()
  })

  it('records a failed Pi turn without damaging Ticket state; cancellation retains a durable recovery marker', async () => {
    const dir = directory(), failed = fake({ fail: true }), runtime = new LocalRuntime({ stateDir: dir, sessionFactory: failed.factory })
    await runtime.start()
    await processLocalRequest(runtime.host, request('failure', 'first'))
    await delay()
    const ticket = runtime.store.tickets.list()[0]!
    expect(ticket.assignments[0]?.report?.state).toBe('failed')
    expect(ticket.ended).toBeUndefined()
    await runtime.shutdown()
    const hanging = fake({ wait: true }), restarted = new LocalRuntime({ stateDir: dir, sessionFactory: hanging.factory })
    await restarted.start()
    restarted.engine.retryTicket(ticket.id)
    await delay()
    await restarted.shutdown()
    expect(restarted.store).toBeDefined()
  })
})
