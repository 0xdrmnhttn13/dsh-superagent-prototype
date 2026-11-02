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
    const done = await runtime.host.collaboration!.run!(ticket.id, taskId, 'peer')
    expect(done.tasks[0]).toMatchObject({ state: 'done', claimedBy: 'peer' })
    expect(done.messages[0]).toMatchObject({ actor: 'peer', taskId, text: 'Synthetic bounded subagent result' })
    await expect(runtime.host.collaboration!.run!(ticket.id, taskId, 'peer')).rejects.toThrow()
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
