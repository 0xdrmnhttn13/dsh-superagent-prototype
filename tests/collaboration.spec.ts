import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, chmodSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/standalone/runtime.ts'
import { localActor, processLocalRequest } from '../src/sources/local-ingress.ts'
import { key } from '../src/core/index.ts'
import { runAgent, publicEndpoint, workspaceGuidance, agentResources } from '../src/standalone/agents.ts'
import { renderBoard } from '../src/standalone/board-view.ts'
import { BoardNotifications } from '../src/standalone/board-notifications.ts'
import { TicketPanel } from '../src/standalone/panel.ts'
import { availableCodingProfiles, profileInstructions } from '../src/standalone/coding-profile.ts'
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
  it('uses an explicit coding system prompt without enabling discovered resources for the coder', () => {
    const coder = agentResources('coder')
    expect(coder.getSystemPrompt()).toContain('may read and edit only the files')
    expect(coder.getSystemPrompt()).not.toContain('No modifications or external actions are permitted')
    expect(agentResources('reviewer').getSystemPrompt()).toContain('No modifications or external actions are permitted')
    expect(coder.getExtensions().extensions).toEqual([])
    expect(coder.getSkills().skills).toEqual([])
  })

  it('discovers owner Pi prompt templates dynamically without enabling skills, tools or symlinks', () => {
    const prompts = dir()
    writeFileSync(join(prompts, 'specialist.md'), '---\ndescription: sample\n---\nOnly test instructions: $ARGUMENTS\n')
    writeFileSync(join(prompts, 'ignored.txt'), 'not a template')
    symlinkSync(join(prompts, 'specialist.md'), join(prompts, 'linked.md'))
    expect(availableCodingProfiles(prompts)).toEqual(['default', 'specialist'])
    expect(profileInstructions('specialist', prompts)).toContain('Only test instructions: [Ticket task provided separately]')
    expect(() => profileInstructions('linked', prompts)).toThrow('Unknown or unsafe')
    expect(() => profileInstructions('../secret', prompts)).toThrow()
    expect(profileInstructions('default')).toContain('General coding')
    const unsafe = dir()
    mkdirSync(join(unsafe, 'prompts'))
    expect(() => profileInstructions('specialist', join(unsafe, 'prompts'))).toThrow()
  })

  it('guides source reading when files are already approved and avoids repeat proposals', () => {
    const ticketId = 'synthetic'
    const workspace = { isBound: () => true, has: () => true, language: () => 'go' as const,
      list: () => ({ head: 'a'.repeat(40), paths: ['internal/processor/processor_prepare.go'], changed: [], mode: 'read' as const }) }
    const text = workspaceGuidance(workspace, ticketId)
    expect(text).toContain('sa_workspace_read now')
    expect(text).toContain('read-only')
    expect(text).toContain('Do NOT propose the same files again')
    expect(workspaceGuidance({ ...workspace, has: () => false }, ticketId)).toContain('propose relevant paths')
  })

  it('renders all board entries without truncation and defaults to navigable pages', async () => {
    const { runtime, ticket } = await make()
    try {
      runtime.collaboration.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
      const task = runtime.collaboration.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Inspect' }).tasks[0]!
      const finding = 'verified-result-' + 'x'.repeat(3800)
      runtime.collaboration.act('reviewer', { op: 'message', ticketId: ticket.id, taskId: task.id, text: finding })
      const proposal = runtime.collaboration.act('reviewer', { op: 'propose_files', ticketId: ticket.id,
        paths: ['internal/processor/processor_prepare.go'], reason: 'Inspect approved path' }).proposals[0]!
      const board = runtime.collaboration.board(ticket.id)
      const pages = Array.from({ length: renderBoard(board).pages }, (_, index) => renderBoard(board, index + 1).text)
      expect(pages.join('\n')).toContain(finding)
      expect(pages.join('\n')).toContain(proposal.id)
      expect(pages.join('\n')).toContain('internal/processor/processor_prepare.go')
      expect(() => renderBoard(board, pages.length + 1)).toThrow('page')
    } finally { await runtime.shutdown() }
  })

  it('shows the latest task state on the default/latest page even when history is paginated', async () => {
    const { runtime, ticket } = await make()
    try {
      runtime.collaboration.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
      const task = runtime.collaboration.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Check concurrency' }).tasks[0]!
      runtime.collaboration.claim(ticket.id, task.id, 'reviewer')
      await runAgent(runtime.store, runtime.collaboration, ticket.id, task.id, 'reviewer', async () => ({ message: 'Finished', done: true }))
      for (let index = 0; index < 15; index++) runtime.collaboration.event(ticket.id, 'reviewer', 'checkpoint', `step ${index}`, task.id)
      const board = runtime.collaboration.board(ticket.id)
      const last = renderBoard(board, renderBoard(board).pages).text
      expect(last).toContain('TASK DONE · Check concurrency')
      expect(last).toContain('TASK = work status · MESSAGE = discussion')
      expect(last).toContain('Times are shown in WIB (UTC+7)')
      expect(last).toContain(`ID: ${task.id}`)
      expect(last).toContain('PROGRESS')
      expect(renderBoard(board, 1).text).toContain(`TASK DONE ${task.id}`)
    } finally { await runtime.shutdown() }
  })

  it('notifies only new persisted messages and done tasks, never checkpoint or replay', async () => {
    const { runtime, ticket } = await make()
    try {
      const collab = runtime.collaboration
      collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
      const task = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Verify code' }).tasks[0]!
      collab.claim(ticket.id, task.id, 'reviewer')
      const watcher = new BoardNotifications(collab.board(ticket.id))
      collab.event(ticket.id, 'reviewer', 'checkpoint', 'still working', task.id)
      expect(watcher.update(collab.board(ticket.id))).toEqual([])
      collab.act('reviewer', { op: 'message', ticketId: ticket.id, taskId: task.id, text: 'Review complete' })
      const message = watcher.update(collab.board(ticket.id))
      expect(message).toMatchObject([{ kind: 'message', text: expect.stringContaining('reviewer') }])
      expect(watcher.update(collab.board(ticket.id))).toEqual([])
      collab.act('reviewer', { op: 'complete', ticketId: ticket.id, taskId: task.id })
      expect(watcher.update(collab.board(ticket.id))).toMatchObject([{ kind: 'done', text: expect.stringContaining('Verify code') }])
      expect(watcher.update(collab.board(ticket.id))).toEqual([])
      expect(new BoardNotifications(collab.board(ticket.id)).update(collab.board(ticket.id))).toEqual([])
    } finally { await runtime.shutdown() }
  })

  it('navigates complete per-file snapshots without truncating the underlying diff', () => {
    const big = 'x'.repeat(20_000)
    const model = new TicketPanel({ kind: 'diff', ticketId: 'demo', index: 0, diff: { files: [
      { path: 'internal/a.go', before: big, after: 'changed' },
      { path: 'internal/b.go', before: 'old', after: 'new' },
    ] } })
    expect(model.lines().join('\n')).toContain(big)
    model.moveFile(1)
    expect(model.lines().join('\n')).toContain('internal/b.go')
    expect(model.lines().join('\n')).not.toContain(big)
    model.moveFile(1)
    expect(model.data.kind === 'diff' && model.data.index).toBe(1)
    model.moveFile(-1)
    expect(model.lines().join('\n')).toContain(big)
    expect(model.viewport(40, 4)).toHaveLength(4)
  })

  it('keeps board page navigation bounded and tracks the latest page', () => {
    const model = new TicketPanel({ kind: 'board', ticketId: 'demo', text: 'TASK DONE', page: 3, pages: 3 })
    model.movePage(-1)
    expect(model.data.kind === 'board' && model.data.page).toBe(2)
    expect(model.followLatest).toBe(false)
    model.movePage(5)
    expect(model.data.kind === 'board' && model.data.page).toBe(3)
    expect(model.followLatest).toBe(true)
  })

  it('does not persist duplicate file proposals from an agent turn', async () => {
    const { runtime, ticket } = await make()
    try {
      const collab = runtime.collaboration
      collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
      const paths = ['internal/processor/processor_prepare.go']
      const pending = collab.act('reviewer', { op: 'propose_files', ticketId: ticket.id, paths, reason: 'Already pending' })
      expect(() => collab.act('reviewer', { op: 'propose_files', ticketId: ticket.id, paths, reason: 'Duplicate' })).toThrow('already pending')
      const task = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Review' }).tasks[0]!
      collab.claim(ticket.id, task.id, 'reviewer')
      const result = await runAgent(runtime.store, collab, ticket.id, task.id, 'reviewer', async () => ({
        message: 'No source read', done: true,
        proposals: [{ kind: 'files' as const, paths, reason: 'Duplicate' }],
      }))
      expect(result.proposals.map(item => item.id)).toEqual(pending.proposals.map(item => item.id))
    } finally { await runtime.shutdown() }
  })

  it('routes owner-approved follow-ups through the same Thread and Subscription after another Pi session', async () => {
    const { runtime, ticket } = await make()
    const follow = { kind: 'ticket_followup', ticketId: ticket.id, eventId: 'followup-durable', text: 'Review approved coding progress; tests not run' }
    try {
      expect(await processLocalRequest(runtime.host, follow)).toMatchObject({ ok: true, status: 'stored', ticketId: ticket.id, investigationId: 'approved' })
      const current = runtime.store.tickets.get(ticket.id)!
      expect(current.inputs.some(input => input.kind === 'trigger' && input.triggerId === key('local', 'followup-durable'))).toBe(true)
      expect(await processLocalRequest(runtime.host, follow)).toMatchObject({ ok: true, status: 'duplicate' })
      expect(await processLocalRequest(runtime.host, { ...follow, text: 'Conflicting content' })).toMatchObject({ ok: false, error: 'event_id_conflict' })
      expect(await processLocalRequest(runtime.host, { ...follow, ticketId: 'missing' })).toMatchObject({ ok: false, error: 'unknown_ticket' })
    } finally { await runtime.shutdown() }
    const restored = new LocalRuntime({ stateDir: dirs[0]!, sessionFactory: fake })
    await restored.start()
    try {
      expect(await processLocalRequest(restored.host, follow)).toMatchObject({ ok: true, status: 'duplicate' })
      expect(restored.store.threads.get('local:approved')?.subscriptions).toContain(ticket.id)
    } finally { await restored.shutdown() }
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
  it('requires an active lease and local approval before preparing one task, and never claims past pending proposals or ambiguous turns', async () => {
    const { runtime, ticket } = await make()
    const taskId = runtime.collaboration.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Synthetic task' }).tasks[0]!.id
    expect(() => runtime.presence.prepare(ticket.id, 'pi-auto')).toThrow('paused')
    runtime.presence.resume(ticket.id, 'pi-auto', 1)
    expect(() => runtime.presence.prepare(ticket.id, 'pi-auto')).toThrow('not approved')
    runtime.collaboration.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    expect(runtime.presence.prepare(ticket.id, 'pi-auto').tasks[0]).toMatchObject({ id: taskId, state: 'claimed', claimedBy: 'reviewer' })
    const second = runtime.collaboration.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Next task' }).tasks[1]!.id
    expect(runtime.presence.prepare(ticket.id, 'pi-auto').tasks[1]).toMatchObject({ id: second, state: 'open' })
    runtime.collaboration.act('reviewer', { op: 'propose_task', ticketId: ticket.id, title: 'Other', reason: 'Await owner' })
    expect(runtime.presence.prepare(ticket.id, 'pi-auto').tasks[1]?.state).toBe('open')
    await runtime.shutdown()
  })

  it('publishes bounded user-facing checkpoints before final result; cancellation cannot publish late updates', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Synthetic' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'reviewer')
    let finish!: (reply: { message: string; done: boolean }) => void
    let send!: (text: string) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const turn = runAgent(runtime.store, collab, ticket.id, taskId, 'reviewer', async (_request, _signal, checkpoint) => {
      send = checkpoint!
      send('Checking only the synthetic Ticket summary')
      entered()
      return new Promise(resolve => { finish = resolve })
    })
    await started
    expect(collab.board(ticket.id).progress.map(item => item.kind)).toEqual(['started', 'checkpoint'])
    for (let i = 0; i < 8; i++) send(`Checkpoint ${i}`)
    expect(collab.board(ticket.id).progress.filter(item => item.kind === 'checkpoint')).toHaveLength(6)
    finish({ message: 'No diagnostic evidence', done: true })
    await turn
    expect(collab.board(ticket.id).progress.at(-1)?.kind).toBe('result')
    await runtime.shutdown()
  })

  it('never writes checkpoints after cancellation or after the reply is committed', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Synthetic cancel' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'reviewer')
    const controller = new AbortController()
    let send!: (text: string) => void
    let finish!: (reply: { message: string; done: boolean }) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const turn = runAgent(runtime.store, collab, ticket.id, taskId, 'reviewer', async (_request, _signal, checkpoint) => {
      send = checkpoint!; entered()
      return new Promise(resolve => { finish = resolve })
    }, controller.signal)
    await started
    controller.abort()
    send('must not appear')
    finish({ message: 'late', done: true })
    await expect(turn).rejects.toThrow('cancelled')
    expect(collab.board(ticket.id).progress.some(item => item.kind === 'checkpoint')).toBe(false)
    await runtime.shutdown()
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

  it('handback stops a task with explicit scope reason and no automatic replay', async () => {
    const { runtime, ticket } = await make()
    const collab = runtime.collaboration
    collab.approve(ticket.id, { id: 'reviewer', kind: 'local', tickets: [] })
    const taskId = collab.act(localActor(), { op: 'task', ticketId: ticket.id, title: 'Review missing Go file' }).tasks[0]!.id
    collab.claim(ticket.id, taskId, 'reviewer')
    const board = await runAgent(runtime.store, collab, ticket.id, taskId, 'reviewer', async () => ({
      message: 'File not in approved scope', done: false, handback: 'Need owner approval for relevant Go file before editing',
      proposals: [{ kind: 'task' as const, title: 'Seek approved file scope', reason: 'Owner approval required' }],
    }))
    expect(board.tasks[0]?.state).toBe('done')
    expect(board.progress.some(item => item.kind === 'handback' && item.explanation.includes('owner approval'))).toBe(true)
    expect(board.proposals[0]?.state).toBe('pending')
    await expect(runAgent(runtime.store, collab, ticket.id, taskId, 'reviewer', async () => ({ message: 'replayed', done: true })))
      .rejects.toThrow()
    await runtime.shutdown()
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
