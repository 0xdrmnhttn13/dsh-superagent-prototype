import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { requestLocal, readBoard } from './client.ts'

const ID = /^[a-zA-Z0-9_-]{1,100}$/
const dir = () => process.env.SA_STATE_DIR || `${homedir()}/.superagent`
const ticketBinding = (sessionId: string) => `pi-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 90)}`
const ownedTicket = async (ticketId: string) => {
  if (!ID.test(ticketId)) throw new Error('Invalid Ticket ID')
  return requestLocal(dir(), { kind: 'inspect_ticket', ticketId })
}
const ensureStatus = async () => {
  const status = await requestLocal(dir(), { kind: 'status' })
  if (status.enabled !== true || status.allowed !== true) throw new Error('Local intake or owner Policy disabled')
}
async function run(ctx: ExtensionCommandContext, action: () => Promise<void>) {
  try { await ensureStatus(); await action() }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(message.includes('ENOENT') || message.includes('ECONNREFUSED')
      ? `Superagent daemon unavailable at ${dir()}; start it with node scripts/sa.mjs start --state-dir ${dir()}`
      : `Superagent (${dir()}): ${message}`, 'error')
  }
}

/** Explicit commands only: an ordinary Pi prompt never creates a Ticket. */
export default function superagent(pi: ExtensionAPI) {
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let bound: { ticketId: string; session: string } | undefined
  let heartbeatPending = false
  let loop: Promise<void> | undefined
  let pendingRestart: { current: { ticketId: string; session: string }; ctx: ExtensionCommandContext } | undefined
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const supervise = (current: { ticketId: string; session: string }, ctx: ExtensionCommandContext) => {
    if (loop) { pendingRestart = { current, ctx }; return }
    loop = (async () => {
      let seen = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: current.ticketId })).progress.length
      while (bound === current) {
        try {
          const snapshot = await requestLocal(dir(), { kind: 'collaboration', ...current, op: 'heartbeat' })
          if (typeof snapshot.presence === 'object' && snapshot.presence !== null && 'remaining' in snapshot.presence
            && snapshot.presence.remaining === 0) { ctx.ui.setStatus('superagent', 'Superagent: turn budget exhausted'); break }
          const prepared = readBoard(await requestLocal(dir(), { kind: 'collaboration', ...current, op: 'prepare' }))
          if (bound !== current) break
          const pending = prepared.proposals.filter(item => item.state === 'pending')
          if (pending.length) {
            ctx.ui.setStatus('superagent', `Superagent: ${pending.length} proposal(s) need approval`)
            ctx.ui.notify(`Review proposals with /board ${current.ticketId} then /proposal ${current.ticketId} <proposal-id>`, 'warning')
            break
          }
          const ready = prepared.tasks.some(item => item.state === 'claimed' && item.claimedBy === 'reviewer')
          if (!ready) { ctx.ui.setStatus('superagent', 'Superagent: no tasks ready'); break }
          const blocked = prepared.tasks.find(item => item.state === 'claimed' && item.claimedBy === 'reviewer')
          if (blocked && prepared.progress.some(event => event.taskId === blocked.id && (event.kind === 'result' || event.kind === 'failed' || event.kind === 'paused'))) {
            ctx.ui.setStatus('superagent', 'Superagent: task needs owner review')
            break
          }
          ctx.ui.setStatus('superagent', 'Superagent reviewer: working')
          ctx.ui.notify('Reviewer working; user-facing checkpoints will appear here.', 'info')
          const step = requestLocal(dir(), { kind: 'collaboration', ...current, op: 'step' })
          let settled = false
          void step.then(() => { settled = true }, () => { settled = true })
          while (bound === current && !settled) {
            await delay(600)
            if (bound !== current) break
            try {
              const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: current.ticketId }))
              for (const event of board.progress.slice(seen)) {
                if (event.kind === 'checkpoint' || event.kind === 'result' || event.kind === 'failed') ctx.ui.notify(`${event.actor}: ${event.explanation}`, 'info')
              }
              seen = board.progress.length
            } catch { /* Poll failures do not hide the actual step result. */ }
          }
          await step
          if (bound === current) {
            const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: current.ticketId }))
            for (const event of board.progress.slice(seen)) {
              if (event.kind === 'checkpoint' || event.kind === 'result' || event.kind === 'failed') ctx.ui.notify(`${event.actor}: ${event.explanation}`, 'info')
            }
            seen = board.progress.length
          }
          if (bound !== current) break
        } catch (error) {
          if (bound === current) ctx.ui.notify(`Collaboration stopped: ${error instanceof Error ? error.message : String(error)}`, 'warning')
          break
        }
      }
    })().catch(error => {
      if (bound === current) ctx.ui.notify(`Collaboration stopped: ${error instanceof Error ? error.message : String(error)}`, 'warning')
    }).finally(() => {
      loop = undefined
      const next = pendingRestart
      pendingRestart = undefined
      if (next && bound === next.current) supervise(next.current, next.ctx)
    })
  }
  const pause = async (ctx?: ExtensionContext) => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
    heartbeatPending = false
    const current = bound
    bound = undefined
    pendingRestart = undefined
    if (current) {
      try { await requestLocal(dir(), { kind: 'collaboration', ...current, op: 'pause' }) } catch { /* lease expires even if daemon is gone */ }
    }
    ctx?.ui.setStatus('superagent', undefined)
  }
  pi.on('session_shutdown', async (_event, ctx) => { await pause(ctx) })
  pi.on('session_start', async (_event, ctx) => {
    await pause(ctx) // Do not resume a previous Pi session without a new owner confirmation.
  })
  pi.registerCommand('collaborate', { description: 'Resume bounded collaboration for this Pi session: /collaborate <ticket-id>', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId) || !ctx.hasUI) throw new Error('Usage: /collaborate <ticket-id> (interactive Pi only)')
    const session = ticketBinding(ctx.sessionManager.getSessionId())
    await ownedTicket(ticketId)
    if (!await ctx.ui.confirm('Resume supervised collaboration?', `Ticket ${ticketId}: up to 4 agent turns, only while this Pi session stays open. Agent proposals stop for approval. Provider calls may cost money.`)) return
    const initial = readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))
    if (!await ctx.ui.confirm('Approve local reviewer?', `Reviewer can read Ticket context and post progress, discussion and proposals on ${ticketId}. No file, shell, or network tools.`))
      throw new Error('Local reviewer was not approved; collaboration was not started')
    if (!initial.tasks.length) {
      const ticket = await ownedTicket(ticketId)
      const title = String(ticket.title ?? '').slice(0, 500)
      if (title) await requestLocal(dir(), { kind: 'board_action', action: { op: 'task', ticketId, title } })
    }
    await requestLocal(dir(), { kind: 'approve_agent', ticketId, agent: { id: 'reviewer', kind: 'local' } })
    await pause(ctx)
    await requestLocal(dir(), { kind: 'collaboration', ticketId, session, op: 'resume' })
    const current = { ticketId, session }
    bound = current
    ctx.ui.setStatus('superagent', `Superagent ${ticketId.slice(0, 8)}: active`)
    heartbeat = setInterval(() => {
      const current = bound
      if (!current || heartbeatPending) return
      heartbeatPending = true
      void requestLocal(dir(), { kind: 'collaboration', ...current, op: 'heartbeat' })
        .catch(() => { if (bound === current) void pause(ctx) })
        .finally(() => { heartbeatPending = false })
    }, 2000)
    ctx.ui.notify('Collaboration active. Ready tasks run automatically; /pause-collaboration stops it.', 'info')
    supervise(current, ctx)
  }) })
  pi.registerCommand('pause-collaboration', { description: 'Pause all agent work for this Pi session', handler: async (_args, ctx) => {
    await pause(ctx)
    ctx.ui.notify('Collaboration paused', 'info')
  } })
  pi.registerCommand('next-agent', { description: 'Manual fallback: run one bounded turn while Pi is present', handler: async (args, ctx) => run(ctx, async () => {
    if (loop) throw new Error('Automatic supervision is active; wait or pause it before manual step')
    const ticketId = args.trim()
    if (!bound || bound.ticketId !== ticketId || !ctx.hasUI) throw new Error('Use /collaborate <ticket-id> first')
    const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))
    if (board.proposals.some(item => item.state === 'pending')) throw new Error('Approve or reject pending proposals first')
    const task = board.tasks.find(item => item.state === 'claimed')
    if (!task) throw new Error('No claimed task ready')
    ctx.ui.notify(`Starting ${task.claimedBy} on ${task.title}; outcome and explicit explanation appear in /board`, 'info')
    const result = await requestLocal(dir(), { kind: 'collaboration', ...bound, op: 'step' })
    ctx.ui.notify(JSON.stringify(readBoard(result)).slice(0, 8000), 'info')
  }) })
  pi.registerCommand('proposal', { description: 'Review an agent proposal: /proposal <ticket-id> <proposal-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, proposalId] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(proposalId ?? '') || !ctx.hasUI) throw new Error('Usage: /proposal <ticket-id> <proposal-id>')
    await ownedTicket(ticketId!)
    const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: ticketId! }))
    const proposal = board.proposals.find(item => item.id === proposalId && item.state === 'pending')
    if (!proposal) throw new Error('No pending proposal')
    const approve = await ctx.ui.confirm('Approve proposal?', JSON.stringify(proposal))
    const result = await requestLocal(dir(), { kind: 'resolve_proposal', ticketId: ticketId!, proposalId: proposalId!, approve })
    ctx.ui.notify(JSON.stringify(readBoard(result)).slice(0, 8000), 'info')
    const current = bound
    if (current && current.ticketId === ticketId) supervise(current, ctx)
  }) })
  pi.registerCommand('ticket', { description: 'Propose a Ticket and ask for explicit approval', handler: async (args, ctx) => {
    if (!ctx.hasUI) { ctx.ui.notify('Ticket approval requires an interactive Pi UI', 'error'); return }
    const text = args.trim()
    if (!text) { ctx.ui.notify('Usage: /ticket <investigation goal>', 'warning'); return }
    if (text.length > 16_384) { ctx.ui.notify('Ticket text too long', 'error'); return }
    const investigationId = ticketBinding(ctx.sessionManager.getSessionId())
    // No network or SQLite mutation before approval. Show exact submitted text.
    if (!await ctx.ui.confirm('Approve Superagent Ticket?', `Investigation ${investigationId}\n\n${text}\n\nThis sends text to your configured Pi provider; do not include secrets.`)) return
    await run(ctx, async () => {
      const result = await requestLocal(dir(), { kind: 'submit', investigationId, eventId: randomUUID(), text, evidence: [] })
      ctx.ui.notify(`Ticket submitted: ${investigationId}; /tickets to see status (${result.status})`, 'info')
      const tickets = await requestLocal(dir(), { kind: 'list_tickets' })
      const ticket = Array.isArray(tickets.tickets) ? tickets.tickets.find(item =>
        typeof item === 'object' && item !== null && 'investigationId' in item && item.investigationId === investigationId) : undefined
      if (result.status === 'stored' && ticket && typeof ticket === 'object' && 'ticketId' in ticket && typeof ticket.ticketId === 'string') {
        const ticketId = ticket.ticketId
        const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))
        if (!board.tasks.length) {
          await requestLocal(dir(), { kind: 'board_action', action: { op: 'task', ticketId, title: text.slice(0, 500) } })
          ctx.ui.notify(`Initial task created. /collaborate ${ticketId} to approve a local reviewer and start.`, 'info')
        }
      }
    })
  } })
  pi.registerCommand('tickets', { description: 'List local Tickets across Pi sessions in this state directory', handler: async (_args, ctx) => run(ctx, async () => {
    const shown = await requestLocal(dir(), { kind: 'list_tickets' })
    const summary = Array.isArray(shown.tickets) ? shown.tickets.map(value => JSON.stringify(value)).join('\n') : ''
    ctx.ui.notify(summary.slice(0, 8000) || `No local Tickets in ${dir()}; check SA_STATE_DIR used when creating the Ticket`, 'info')
  }) })
  pi.registerCommand('task', { description: 'Create an owner-approved task: /task <ticket-id> <description>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !words.length || !ctx.hasUI) throw new Error('Usage: /task <ticket-id> <description> (interactive Pi only)')
    await ownedTicket(ticketId!)
    const title = words.join(' ')
    if (!await ctx.ui.confirm('Add task to Ticket?', `${ticketId}\n${title}`)) return
    const result = await requestLocal(dir(), { kind: 'board_action', action: { op: 'task', ticketId: ticketId!, title } })
    ctx.ui.notify(`Task added: ${readBoard(result).tasks.at(-1)?.id}`, 'info')
  }) })
  pi.registerCommand('board', { description: 'Show task and discussion board: /board <ticket-id>', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId)) throw new Error('Usage: /board <ticket-id>')
    await ownedTicket(ticketId)
    ctx.ui.notify(JSON.stringify(readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))).slice(0, 8000), 'info')
  }) })
  pi.registerCommand('approve-agent', { description: 'Approve local subagent: /approve-agent <ticket-id> <agent-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, agentId] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(agentId ?? '') || !ctx.hasUI) throw new Error('Usage: /approve-agent <ticket-id> <agent-id> (interactive Pi only)')
    await ownedTicket(ticketId!)
    if (!await ctx.ui.confirm('Approve local subagent for this Ticket?', `${agentId} may claim tasks and post discussion on ${ticketId}. No file/shell/network tools.`)) return
    await requestLocal(dir(), { kind: 'approve_agent', ticketId: ticketId!, agent: { id: agentId!, kind: 'local' } })
    ctx.ui.notify(`Approved ${agentId} on ${ticketId}`, 'info')
  }) })
  pi.registerCommand('approve-external', { description: 'Approve external HTTPS agent: /approve-external <ticket-id> <agent-id> <https-url> <TOKEN_ENV>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, agentId, endpoint, tokenEnv] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(agentId ?? '') || !/^https:\/\/[^\s]+$/.test(endpoint ?? '')
      || !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv ?? '') || !ctx.hasUI)
      throw new Error('Usage: /approve-external <ticket-id> <agent-id> <https-url> <TOKEN_ENV> (interactive Pi only)')
    await ownedTicket(ticketId!)
    const token = process.env[tokenEnv!]
    if (!token || token.length < 32) throw new Error('Set a token of at least 32 characters in the daemon and Pi environments')
    if (!await ctx.ui.confirm('Approve outbound external agent?', `${agentId} at ${endpoint} receives Ticket context and discussion over HTTPS. Token env: ${tokenEnv}; no secrets shown.`)) return
    await requestLocal(dir(), { kind: 'approve_agent', ticketId: ticketId!, agent: { id: agentId!, kind: 'external', endpoint: endpoint!, tokenEnv: tokenEnv! }, token })
    ctx.ui.notify(`Approved external agent ${agentId} on ${ticketId}`, 'info')
  }) })
  pi.registerCommand('claim-task', { description: 'Assign an open task to an approved agent: /claim-task <ticket-id> <task-id> <agent-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, taskId, agentId] = args.trim().split(/\s+/)
    if (![ticketId, taskId, agentId].every(value => ID.test(value ?? '')) || !ctx.hasUI)
      throw new Error('Usage: /claim-task <ticket-id> <task-id> <agent-id> (interactive Pi only)')
    await ownedTicket(ticketId!)
    if (!await ctx.ui.confirm('Assign task to agent?', `${taskId} on ${ticketId} → ${agentId}`)) return
    const result = await requestLocal(dir(), { kind: 'claim_agent', ticketId: ticketId!, taskId: taskId!, agentId: agentId! })
    ctx.ui.notify(JSON.stringify(readBoard(result)).slice(0, 8000), 'info')
    const current = bound
    if (current && current.ticketId === ticketId) supervise(current, ctx)
  }) })
  pi.registerCommand('run-agent', { description: 'Deprecated: use /collaborate then /next-agent', handler: async (_args, ctx) => {
    ctx.ui.notify('Use /collaborate <ticket-id> for supervised automatic turns. Unsupervised turns are disabled.', 'warning')
  } })
  pi.registerCommand('discuss', { description: 'Post an owner message: /discuss <ticket-id> <message>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !words.length || !ctx.hasUI) throw new Error('Usage: /discuss <ticket-id> <message> (interactive Pi only)')
    await ownedTicket(ticketId!)
    const text = words.join(' ')
    if (!await ctx.ui.confirm('Post to Ticket discussion?', `${ticketId}\n${text}`)) return
    await requestLocal(dir(), { kind: 'board_action', action: { op: 'message', ticketId: ticketId!, text } })
    ctx.ui.notify('Message recorded', 'info')
  }) })
}
