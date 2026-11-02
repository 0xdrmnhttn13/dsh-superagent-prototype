import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { requestLocal, readBoard } from './client.ts'

const ID = /^[a-zA-Z0-9_-]{1,100}$/
const dir = () => process.env.SA_STATE_DIR || `${homedir()}/.superagent`
const ticketBinding = (sessionId: string) => `pi-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 90)}`
const ticketIds = (response: Record<string, unknown>): string[] => {
  const tickets = response.tickets
  return Array.isArray(tickets) ? tickets.flatMap(item => item && typeof item === 'object' && typeof item.ticketId === 'string' ? [item.ticketId] : []) : []
}
const ensureStatus = async () => {
  const status = await requestLocal(dir(), { kind: 'status' })
  if (status.enabled !== true || status.allowed !== true) throw new Error('Local intake or owner Policy disabled')
}
async function run(ctx: ExtensionCommandContext, action: () => Promise<void>) {
  try { await ensureStatus(); await action() } catch (error) { ctx.ui.notify(`Superagent: ${error instanceof Error ? error.message : String(error)}. Start daemon with node scripts/sa.mjs start`, 'error') }
}

/** Explicit commands only: an ordinary Pi prompt never creates a Ticket. */
export default function superagent(pi: ExtensionAPI) {
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
    })
  } })
  pi.registerCommand('tickets', { description: 'Show approved Tickets for this Pi session', handler: async (_args, ctx) => run(ctx, async () => {
    const investigationId = ticketBinding(ctx.sessionManager.getSessionId())
    const shown = await requestLocal(dir(), { kind: 'show', investigationId })
    const summary = Array.isArray(shown.tickets) ? shown.tickets.map(value => JSON.stringify(value)).join('\n') : ''
    ctx.ui.notify(summary.slice(0, 8000) || 'No Tickets', 'info')
  }) })
  pi.registerCommand('task', { description: 'Create an owner-approved task: /task <ticket-id> <description>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !words.length || !ctx.hasUI) throw new Error('Usage: /task <ticket-id> <description> (interactive Pi only)')
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId!)) throw new Error('Ticket not bound to this Pi session')
    const title = words.join(' ')
    if (!await ctx.ui.confirm('Add task to Ticket?', `${ticketId}\n${title}`)) return
    const result = await requestLocal(dir(), { kind: 'board_action', action: { op: 'task', ticketId: ticketId!, title } })
    ctx.ui.notify(`Task added: ${readBoard(result).tasks.at(-1)?.id}`, 'info')
  }) })
  pi.registerCommand('board', { description: 'Show task and discussion board: /board <ticket-id>', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId)) throw new Error('Usage: /board <ticket-id>')
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId)) throw new Error('Ticket not bound to this Pi session')
    ctx.ui.notify(JSON.stringify(readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))).slice(0, 8000), 'info')
  }) })
  pi.registerCommand('approve-agent', { description: 'Approve local subagent: /approve-agent <ticket-id> <agent-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, agentId] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(agentId ?? '') || !ctx.hasUI) throw new Error('Usage: /approve-agent <ticket-id> <agent-id> (interactive Pi only)')
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId!)) throw new Error('Ticket not bound to this Pi session')
    if (!await ctx.ui.confirm('Approve local subagent for this Ticket?', `${agentId} may claim tasks and post discussion on ${ticketId}. No file/shell/network tools.`)) return
    await requestLocal(dir(), { kind: 'approve_agent', ticketId: ticketId!, agent: { id: agentId!, kind: 'local' } })
    ctx.ui.notify(`Approved ${agentId} on ${ticketId}`, 'info')
  }) })
  pi.registerCommand('approve-external', { description: 'Approve external HTTPS agent: /approve-external <ticket-id> <agent-id> <https-url> <TOKEN_ENV>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, agentId, endpoint, tokenEnv] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(agentId ?? '') || !/^https:\/\/[^\s]+$/.test(endpoint ?? '')
      || !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv ?? '') || !ctx.hasUI)
      throw new Error('Usage: /approve-external <ticket-id> <agent-id> <https-url> <TOKEN_ENV> (interactive Pi only)')
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId!)) throw new Error('Ticket not bound to this Pi session')
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
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId!)) throw new Error('Ticket not bound to this Pi session')
    if (!await ctx.ui.confirm('Assign task to agent?', `${taskId} on ${ticketId} → ${agentId}`)) return
    const result = await requestLocal(dir(), { kind: 'claim_agent', ticketId: ticketId!, taskId: taskId!, agentId: agentId! })
    ctx.ui.notify(JSON.stringify(readBoard(result)).slice(0, 8000), 'info')
  }) })
  pi.registerCommand('run-agent', { description: 'Run one approved agent turn: /run-agent <ticket-id> <task-id> <agent-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, taskId, agentId] = args.trim().split(/\s+/)
    if (![ticketId, taskId, agentId].every(value => ID.test(value ?? '')) || !ctx.hasUI) throw new Error('Usage: /run-agent <ticket-id> <task-id> <agent-id> (interactive Pi only)')
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId!)) throw new Error('Ticket not bound to this Pi session')
    if (!await ctx.ui.confirm('Run approved agent?', `${agentId} will see Ticket context and discussion for task ${taskId}; external agents receive data over HTTPS.`)) return
    const result = await requestLocal(dir(), { kind: 'run_agent', ticketId: ticketId!, taskId: taskId!, agentId: agentId! })
    ctx.ui.notify(JSON.stringify(readBoard(result)).slice(0, 8000), 'info')
  }) })
  pi.registerCommand('discuss', { description: 'Post an owner message: /discuss <ticket-id> <message>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !words.length || !ctx.hasUI) throw new Error('Usage: /discuss <ticket-id> <message> (interactive Pi only)')
    const shown = await requestLocal(dir(), { kind: 'show', investigationId: ticketBinding(ctx.sessionManager.getSessionId()) })
    if (!ticketIds(shown).includes(ticketId!)) throw new Error('Ticket not bound to this Pi session')
    const text = words.join(' ')
    if (!await ctx.ui.confirm('Post to Ticket discussion?', `${ticketId}\n${text}`)) return
    await requestLocal(dir(), { kind: 'board_action', action: { op: 'message', ticketId: ticketId!, text } })
    ctx.ui.notify('Message recorded', 'info')
  }) })
}
