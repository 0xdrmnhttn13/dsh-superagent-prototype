import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/standalone/runtime.ts'
import { localActor, processLocalRequest } from '../src/sources/local-ingress.ts'
import { runAgent, publicEndpoint } from '../src/standalone/agents.ts'
import type { SessionFactory } from '../src/standalone/pi.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dir = () => { const result = mkdtempSync(join(tmpdir(), 'sa-collab-')); chmodSync(result, 0o700); dirs.push(result); return result }
const fake: SessionFactory = async id => ({ id: `fake:${id}`, tools: ['sa_context', 'sa_evidence', 'sa_report'],
  prompt: async () => {}, abort: async () => {}, dispose: () => {} })
const submit = (id: string, event: string) => ({ kind: 'submit', investigationId: id, eventId: event, text: 'Synthetic investigation', evidence: [] })
const make = async () => {
  const runtime = new LocalRuntime({ stateDir: dir(), sessionFactory: fake,
    agentRunner: async () => ({ message: 'Synthetic bounded subagent result', done: true }) })
  await runtime.start()
  const result = await processLocalRequest(runtime.host, submit('approved', 'event-1'))
  expect(result.ok).toBe(true)
  const ticket = runtime.store.tickets.list()[0]!
  expect(ticket).toBeTruthy()
  return { runtime, ticket }
}

describe('ticket-scoped collaboration', () => {
  it('lists and inspects owner Tickets across Pi sessions without exposing foreign or missing Tickets', async () => {
    const { runtime, ticket } = await make()
    const second = await processLocalRequest(runtime.host, submit('another-pi-session', 'event-2'))
    expect(second.ok).toBe(true)
    const list = await processLocalRequest(runtime.host, { kind: 'list_tickets' })
    expect(list.ok).toBe(true)
    expect(list.tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketId: ticket.id, investigationId: 'approved' }),
      expect.objectContaining({ investigationId: 'another-pi-session' }),
    ]))
    expect(await processLocalRequest(runtime.host, { kind: 'inspect_ticket', ticketId: ticket.id }))
      .toMatchObject({ ok: true, investigationId: 'approved', ticketId: ticket.id })
    expect(await processLocalRequest(runtime.host, { kind: 'inspect_ticket', ticketId: 'missing' }))
      .toMatchObject({ ok: false, error: 'unknown_ticket' })
    await runtime.shutdown()
    const restored = new LocalRuntime({ stateDir: dirs[0]!, sessionFactory: fake })
    await restored.start()
    expect((await processLocalRequest(restored.host, { kind: 'list_tickets' })).tickets).toHaveLength(2)
    await restored.shutdown()
  })
  it('does not list Tickets if local intake or Policy is disabled', async () => {
    const { runtime } = await make()
    const settings = runtime.store.settings()
    runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
      local: { admission: {}, allowed: [] },
    } } })
    expect(await processLocalRequest(runtime.host, { kind: 'list_tickets' })).toMatchObject({ ok: false, error: 'local_actor_not_allowlisted' })
    await runtime.shutdown()
  })
  it('rejects local/metadata IP destinations and accepts only public IPv4 literals', async () => {
    for (const host of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.168.1.2', '172.16.0.1', '::1', '2001:4860:4860::8888', '192.0.2.1'])
      await expect(publicEndpoint(host)).rejects.toThrow('non-public')
    await expect(publicEndpoint('1.1.1.1')).resolves.toBe('1.1.1.1')
  })
  it('requires an Engine-approved Ticket, per-Ticket agent approval, claim, and records one bounded turn durably', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    expect(() => collab.board('missing')).toThrow('Ticket not authorized')
    const board = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Analyze synthetic error' })
    const taskId = board.tasks[0]!.id
    expect(() => collab.claim(ticket.id, taskId, 'peer')).toThrow('not approved')
    collab.approve(ticket.id, { id: 'peer', kind: 'local', tickets: [] })
    expect(() => collab.act('other', { op: 'message', ticketId: ticket.id, text: 'intrusion' })).toThrow('not approved')
    collab.claim(ticket.id, taskId, 'peer')
    expect(() => collab.claim(ticket.id, taskId, 'peer')).toThrow('unavailable')
    runtime.presence.resume(ticket.id, 'pi-test', 1)
    const done = await runtime.presence.step(ticket.id, 'pi-test')
    expect(done.tasks[0]).toMatchObject({ state: 'done', claimedBy: 'peer' })
    expect(done.messages[0]).toMatchObject({ actor: 'peer', taskId, text: 'Synthetic bounded subagent result' })
    await expect(runtime.presence.step(ticket.id, 'pi-test')).rejects.toThrow('budget')
    await runtime.shutdown()
    const restored = new LocalRuntime({ stateDir: dirs[0]!, sessionFactory: fake })
    await restored.start()
    expect(restored.collaboration.board(ticket.id).messages).toHaveLength(1)
    await restored.shutdown()
  })

  it('does not replay ambiguous turns after runner failure and rejects cross-ticket task reuse', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    collab.approve(ticket.id, { id: 'peer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Check config' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'peer')
    const broken = async () => { throw new Error('Synthetic crash') }
    await expect(runAgent(runtime.store, collab, ticket.id, taskId, 'peer', broken)).rejects.toThrow('Synthetic crash')
    await expect(runAgent(runtime.store, collab, ticket.id, taskId, 'peer', broken)).rejects.toThrow('no automatic replay')
    expect(collab.board(ticket.id).messages).toHaveLength(0)
    collab.revoke(ticket.id, 'peer')
    expect(() => collab.claim(ticket.id, taskId, 'peer')).toThrow('not approved')
    await runtime.shutdown()
  })

  it('pauses on missing Pi presence, restart, expiry, and enforces a non-refillable turn budget', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration, presence = runtime.presence
    collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Synthetic review' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'reviewer')
    await expect(presence.step(ticket.id, 'pi-session')).rejects.toThrow('paused')
    presence.resume(ticket.id, 'pi-session', 1)
    expect(presence.view(ticket.id)).toMatchObject({ active: true, remaining: 1 })
    presence.resume(ticket.id, 'pi-session', 4)
    expect(presence.view(ticket.id).remaining).toBe(1)
    await presence.step(ticket.id, 'pi-session')
    expect(presence.view(ticket.id).remaining).toBe(0)
    await expect(presence.step(ticket.id, 'pi-session')).rejects.toThrow('budget')
    presence.pause(ticket.id, 'pi-session')
    expect(presence.view(ticket.id).active).toBe(false)
    await expect(presence.step(ticket.id, 'pi-session')).rejects.toThrow('paused')
    await runtime.shutdown()
    const restored = new LocalRuntime({ stateDir: dirs[0]!, sessionFactory: fake })
    await restored.start()
    expect(restored.presence.view(ticket.id).active).toBe(false)
    await expect(restored.presence.step(ticket.id, 'pi-session')).rejects.toThrow('paused')
    await restored.shutdown()
  })

  it('records agent proposals and explicit explanations, but applies neither task nor invite without owner approval', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Synthetic review' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'reviewer')
    const reply = async () => ({ message: 'Only synthetic evidence exists', done: true,
      explanation: 'Inspected the Ticket summary; no concrete broker configuration is attached.',
      proposals: [{ kind: 'task' as const, title: 'Collect redacted broker logs', reason: 'Need a correlated validation error' },
        { kind: 'invite' as const, agentId: 'validator', reason: 'Need independent validation' }] })
    await runAgent(runtime.store, collab, ticket.id, taskId, 'reviewer', reply)
    let board = collab.board(ticket.id)
    expect(board.tasks).toHaveLength(1)
    expect(board.proposals).toHaveLength(2)
    expect(board.progress.find(item => item.kind === 'result')?.explanation).toContain('no concrete broker configuration')
    expect(() => collab.resolve(ticket.id, board.proposals[1]!.id, true)).toThrow('not approved')
    board = collab.resolve(ticket.id, board.proposals[0]!.id, true)
    expect(board.tasks).toHaveLength(2)
    board = collab.resolve(ticket.id, board.proposals[1]!.id, false)
    expect(board.proposals.map(item => item.state)).toEqual(['approved', 'rejected'])
    await runtime.shutdown()
  })

  it('aborts an in-flight turn when Pi pauses and never commits its late reply or replays it', async () => {
    const stateDir = dir()
    let finish!: (value: { message: string; done: boolean }) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const runtime = new LocalRuntime({ stateDir, sessionFactory: fake,
      agentRunner: async () => { entered(); return new Promise(resolve => { finish = resolve }) } })
    await runtime.start()
    await processLocalRequest(runtime.host, submit('paused', 'pause-event'))
    const ticket = runtime.store.tickets.list()[0]!
    runtime.collaboration.approve(ticket.id, { id: 'peer', kind: 'local', tickets: [] })
    const taskId = runtime.collaboration.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Check pause' }).tasks[0]!.id
    runtime.collaboration.claim(ticket.id, taskId, 'peer')
    runtime.presence.resume(ticket.id, 'pi-paused', 1)
    const turn = runtime.presence.step(ticket.id, 'pi-paused')
    await started
    runtime.presence.pause(ticket.id, 'pi-paused')
    finish({ message: 'Late result must not appear', done: true })
    await expect(turn).rejects.toThrow('cancelled')
    expect(runtime.collaboration.board(ticket.id).messages).toHaveLength(0)
    runtime.presence.resume(ticket.id, 'pi-paused', 1)
    await expect(runtime.presence.step(ticket.id, 'pi-paused')).rejects.toThrow('No claimed task ready')
    await runtime.shutdown()
  })

  it('requires a live Pi lease for socket-driven turns and stops at pending proposals', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Synthetic review' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'reviewer')
    const step = { kind: 'collaboration', ticketId: ticket.id, session: 'pi-live', op: 'step' }
    await expect(processLocalRequest(runtime.host, step)).rejects.toThrow('paused')
    await processLocalRequest(runtime.host, { ...step, op: 'resume' })
    collab.act('reviewer', { op: 'propose_task', ticketId: ticket.id, title: 'Inspect settings', reason: 'Missing settings' })
    await expect(processLocalRequest(runtime.host, step)).rejects.toThrow('Proposal awaits owner approval')
    const pending = collab.board(ticket.id).proposals[0]!
    await processLocalRequest(runtime.host, { kind: 'resolve_proposal', ticketId: ticket.id, proposalId: pending.id, approve: false })
    expect((await processLocalRequest(runtime.host, step)).ok).toBe(true)
    await processLocalRequest(runtime.host, { ...step, op: 'pause' })
    expect(runtime.presence.view(ticket.id).active).toBe(false)
    await runtime.shutdown()
  })

  it('rejects HTTP endpoints, missing credentials, cross-ticket access, and post-revocation access', async () => {
    const { runtime, ticket } = await make()
    const token = 'synthetic-token-at-least-32-characters'
    process.env.SA_TEST_AGENT_TOKEN = token
    const agent = { id: 'remote', kind: 'external' as const, endpoint: 'https://example.invalid/agent', tokenEnv: 'SA_TEST_AGENT_TOKEN', tickets: [] }
    try {
      expect(() => runtime.collaboration.approve(ticket.id, { ...agent, endpoint: 'http://example.invalid/agent' }, token)).toThrow()
      expect(() => runtime.collaboration.approve(ticket.id, agent, 'wrong-token-at-least-32-characters')).toThrow()
      runtime.collaboration.approve(ticket.id, agent, token)
      expect(() => runtime.collaboration.authorized(ticket.id, 'remote', 'invalid')).toThrow('Invalid agent credential')
      expect(runtime.collaboration.authorized(ticket.id, 'remote', token).id).toBe('remote')
      runtime.collaboration.revoke(ticket.id, 'remote')
      expect(() => runtime.collaboration.authorized(ticket.id, 'remote', token)).toThrow('not approved')
    } finally { delete process.env.SA_TEST_AGENT_TOKEN; await runtime.shutdown() }
  })
})
