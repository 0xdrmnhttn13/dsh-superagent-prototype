import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { requestLocal, readBoard } from './client.ts'
import { renderBoard } from './board-view.ts'
import { BoardNotifications } from './board-notifications.ts'
import { availableCodingProfiles, CodingProfile } from './coding-profile.ts'
import { TicketPanel, openTicketViewer, type WorkspaceDiff } from './panel.ts'

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
  let notices: { ticketId: string; session: string; tracker: BoardNotifications } | undefined
  let noticeTimer: ReturnType<typeof setInterval> | undefined
  let noticePending = false
  const notifyBoard = (board: ReturnType<typeof readBoard>, ctx: ExtensionContext) => {
    if (!bound || notices?.session !== bound.session || notices.ticketId !== board.ticketId) return
    for (const item of notices.tracker.update(board)) {
      // Pi notifications expose info/warning/error, not a success variant. Apply the active theme's
      // success color to text; do not present a checkpoint as a completed task.
      ctx.ui.notify(ctx.mode === 'tui' ? ctx.ui.theme.fg('success', `✓ ${item.text}`) : `✓ ${item.text}`, 'info')
    }
  }
  const supervise = (current: { ticketId: string; session: string }, ctx: ExtensionCommandContext) => {
    if (loop) { pendingRestart = { current, ctx }; return }
    loop = (async () => {
      const initialBoard = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: current.ticketId }))
      let seen = initialBoard.progress.length
      if (!notices || notices.session !== current.session) notices = { ticketId: current.ticketId, session: current.session, tracker: new BoardNotifications(initialBoard) }
      while (bound === current) {
        try {
          const snapshot = await requestLocal(dir(), { kind: 'collaboration', ...current, op: 'heartbeat' })
          if (typeof snapshot.presence === 'object' && snapshot.presence !== null && 'remaining' in snapshot.presence
            && snapshot.presence.remaining === 0) { ctx.ui.setStatus('superagent', 'Superagent: turn budget exhausted'); break }
          const prepared = readBoard(await requestLocal(dir(), { kind: 'collaboration', ...current, op: 'prepare' }))
          if (bound !== current) break
          notifyBoard(prepared, ctx)
          const pending = prepared.proposals.filter(item => item.state === 'pending')
          if (pending.length) {
            ctx.ui.setStatus('superagent', `Superagent: ${pending.length} proposal(s) need approval`)
            ctx.ui.notify(`Review proposals with /board ${current.ticketId} then /proposal ${current.ticketId} <proposal-id>`, 'warning')
            break
          }
          const ready = prepared.tasks.some(item => item.state === 'claimed' && (item.claimedBy === 'reviewer' || item.claimedBy === 'coder'))
          if (!ready) { ctx.ui.setStatus('superagent', 'Superagent: no tasks ready'); break }
          const blocked = prepared.tasks.find(item => item.state === 'claimed' && (item.claimedBy === 'reviewer' || item.claimedBy === 'coder'))
          if (blocked && prepared.progress.some(event => event.taskId === blocked.id && (event.kind === 'result' || event.kind === 'handback' || event.kind === 'failed' || event.kind === 'paused'))) {
            ctx.ui.setStatus('superagent', 'Superagent: task needs owner review')
            break
          }
          ctx.ui.setStatus('superagent', `Superagent ${blocked?.claimedBy ?? 'agent'}: working`)
          ctx.ui.notify(`${blocked?.claimedBy ?? 'Agent'} working; user-facing checkpoints will appear here.`, 'info')
          const step = requestLocal(dir(), { kind: 'collaboration', ...current, op: 'step' })
          let settled = false
          void step.then(() => { settled = true }, () => { settled = true })
          while (bound === current && !settled) {
            await delay(600)
            if (bound !== current) break
            try {
              const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: current.ticketId }))
              notifyBoard(board, ctx)
              for (const event of board.progress.slice(seen)) {
                if (event.kind === 'checkpoint' || event.kind === 'result' || event.kind === 'handback' || event.kind === 'failed') ctx.ui.notify(`${event.actor}: ${event.explanation}`, 'info')
              }
              seen = board.progress.length
            } catch { /* Poll failures do not hide the actual step result. */ }
          }
          await step
          if (bound === current) {
            const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: current.ticketId }))
            notifyBoard(board, ctx)
            for (const event of board.progress.slice(seen)) {
              if (event.kind === 'checkpoint' || event.kind === 'result' || event.kind === 'handback' || event.kind === 'failed') ctx.ui.notify(`${event.actor}: ${event.explanation}`, 'info')
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
    if (noticeTimer) clearInterval(noticeTimer)
    heartbeat = undefined
    noticeTimer = undefined
    noticePending = false
    heartbeatPending = false
    const current = bound
    bound = undefined
    pendingRestart = undefined
    notices = undefined
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
    if (!await ctx.ui.confirm('Approve local reviewer?', `Reviewer can read Ticket context, discover permitted filenames, and read separately approved files. Reviewer cannot edit. A separately approved coder task may edit its granted paths directly; no shell, test execution, commit or push.`))
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
    notices = { ticketId, session, tracker: new BoardNotifications(readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))) }
    noticeTimer = setInterval(() => {
      if (bound !== current || noticePending) return
      noticePending = true
      void requestLocal(dir(), { kind: 'board', ticketId }).then(response => {
        if (bound === current) notifyBoard(readBoard(response), ctx)
      }).catch(() => { /* The next poll can recover; a failed read never starts work. */ })
        .finally(() => { noticePending = false })
    }, 1500)
    ctx.ui.setStatus('superagent', `Superagent ${ticketId.slice(0, 8)}: active`)
    heartbeat = setInterval(() => {
      const current = bound
      if (!current || heartbeatPending) return
      heartbeatPending = true
      void requestLocal(dir(), { kind: 'collaboration', ...current, op: 'heartbeat' })
        .catch(() => { if (bound === current) void pause(ctx) })
        .finally(() => { heartbeatPending = false })
    }, 2000)
    ctx.ui.notify(`Collaboration active; /board ${ticketId} opens the full-screen viewer. Esc returns to chat without stopping work.`, 'info')
    supervise(current, ctx)
    if (ctx.mode === 'tui') {
      try {
        const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))
        const pages = renderBoard(board).pages
        await openTicketViewer(ctx, new TicketPanel({ kind: 'board', ticketId,
          text: renderBoard(board, pages).text, page: pages, pages }), dir())
      } finally {
        if (bound === current) {
          const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId }))
          notifyBoard(board, ctx)
        }
      }
    }
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
    const resultBoard = readBoard(result)
    ctx.ui.notify(renderBoard(resultBoard, renderBoard(resultBoard).pages).text, 'info')
  }) })
  pi.registerCommand('proposal', { description: 'Review an agent proposal: /proposal <ticket-id> <proposal-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, proposalId] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(proposalId ?? '') || !ctx.hasUI) throw new Error('Usage: /proposal <ticket-id> <proposal-id>')
    await ownedTicket(ticketId!)
    const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: ticketId! }))
    const proposal = board.proposals.find(item => item.id === proposalId && item.state === 'pending')
    if (!proposal) throw new Error('No pending proposal')
    const approve = await ctx.ui.confirm('Approve proposal?', `${JSON.stringify(proposal)}${proposal.kind === 'files' ? '\nApproval permits READ ONLY for these original tracked Go files; contents may go to your configured Pi provider. Editing requires a separate /workspace-write-approve confirmation. No commit/push.' : ''}`)
    const result = await requestLocal(dir(), { kind: 'resolve_proposal', ticketId: ticketId!, proposalId: proposalId!, approve })
    ctx.ui.notify(`Proposal ${proposalId}: ${approve ? 'approved' : 'rejected'}. ${readBoard(result).proposals.find(item => item.id === proposalId)?.reason ?? ''}`, 'info')
    if (approve && proposal.kind === 'files') ctx.ui.notify(`Read-only file access granted. Review paths; for editing separately approve /workspace-write-approve ${ticketId}, then create a new owner-approved /task. No turn is replayed.`, 'info')
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
  pi.registerCommand('ticket-followup', { description: 'Send an owner-approved follow-up Trigger into an existing Ticket Thread', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !words.length || !ctx.hasUI) throw new Error('Usage: /ticket-followup <ticket-id> <text>')
    await ownedTicket(ticketId!)
    const text = words.join(' ')
    if (text.length > 16_384) throw new Error('Follow-up text too long')
    if (!await ctx.ui.confirm('Submit follow-up Trigger?', `Ticket ${ticketId}\n\n${text}\n\nThis enters the Engine on the original Thread and may be sent to the configured Pi provider. It is not a direct Assignment report.`)) return
    const result = await requestLocal(dir(), { kind: 'ticket_followup', ticketId: ticketId!, eventId: randomUUID(), text })
    ctx.ui.notify(`Follow-up ${result.status} on ${ticketId}; inspect /tickets or sa show for the new Report.`, 'info')
  }) })
  pi.registerCommand('workspace-bind', { description: 'Bind a repository to a Ticket with an explicit language profile', handler: async (args, ctx) => run(ctx, async () => {
    const parts = args.trim().split(/\s+/)
    const [ticketId, source, profile] = parts
    const language = profile ?? 'go'
    if (parts.length < 2 || parts.length > 3 || !ID.test(ticketId ?? '') || !source?.startsWith('/')
      || !['go', 'rust', 'cpp'].includes(language) || !ctx.hasUI)
      throw new Error('Usage: /workspace-bind <ticket-id> <absolute-repository-root> [go|rust|cpp]')
    await ownedTicket(ticketId!)
    if (!await ctx.ui.confirm('Bind repository filenames to Ticket?', `${ticketId}\n${source}\nProfile: ${language}. Eligible tracked source filenames under profile-specific directories become visible; no file contents or edits until separate path approval.`)) return
    const result = await requestLocal(dir(), { kind: 'workspace_bind', ticketId: ticketId!, source: source!, language: language as 'go' | 'rust' | 'cpp' })
    ctx.ui.notify(`Repository bound; ${JSON.stringify(result.workspace)}. /collaborate ${ticketId} lets reviewer propose files.`, 'info')
  }) })
  pi.registerCommand('workspace-write-approve', { description: 'Separately allow edits to an existing read-only file grant', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId) || !ctx.hasUI) throw new Error('Usage: /workspace-write-approve <ticket-id>')
    await ownedTicket(ticketId)
    const info = await requestLocal(dir(), { kind: 'workspace_list', ticketId })
    if (!await ctx.ui.confirm('Approve direct working-tree edits?', `Ticket ${ticketId}\n${JSON.stringify(info.workspace)}\n\nReviewer may EDIT ALL listed original Go files directly in the working tree during a supervised turn. No shell, tests, commit or push. Review every path before approval.`)) return
    const result = await requestLocal(dir(), { kind: 'workspace_approve_write', ticketId })
    ctx.ui.notify(`Write access approved: ${JSON.stringify(result.workspace)}`, 'info')
  }) })
  pi.registerCommand('workspace-revoke', { description: 'Revoke approved file access before any edit', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId) || !ctx.hasUI) throw new Error('Usage: /workspace-revoke <ticket-id>')
    await ownedTicket(ticketId)
    const info = await requestLocal(dir(), { kind: 'workspace_list', ticketId })
    if (!await ctx.ui.confirm('Revoke Ticket file access?', `Revoke ${JSON.stringify(info.workspace)}. Only allowed before any file edit; a new file proposal will be required.`)) return
    await requestLocal(dir(), { kind: 'workspace_revoke', ticketId })
    ctx.ui.notify('File access revoked; repo binding and Ticket remain.', 'info')
  }) })
  pi.registerCommand('workspace-inspect', { description: 'Inspect interrupted file edit without replaying it', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, path] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !path || !ctx.hasUI) throw new Error('Usage: /workspace-inspect <ticket-id> <approved-path>')
    await ownedTicket(ticketId!)
    const result = await requestLocal(dir(), { kind: 'workspace_inspect', ticketId: ticketId!, path })
    ctx.ui.notify(`Interrupted edit (NOT automatically resolved): ${JSON.stringify(result.intent)}. Compare Git diff and investigate manually; no automatic replay.`, 'warning')
  }) })
  pi.registerCommand('workspace-files', { description: 'Show approved files and changed paths for a Ticket', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId)) throw new Error('Usage: /workspace-files <ticket-id>')
    await ownedTicket(ticketId)
    const result = await requestLocal(dir(), { kind: 'workspace_list', ticketId })
    ctx.ui.notify(JSON.stringify(result.workspace), 'info')
  }) })
  pi.registerCommand('workspace-format', { description: 'Check gofmt of Ticket edits without modifying the repository', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId) || !ctx.hasUI) throw new Error('Usage: /workspace-format <ticket-id>')
    await ownedTicket(ticketId)
    if (!await ctx.ui.confirm('Check Go formatting (read-only)?', `For Go-profile Ticket ${ticketId}, run gofmt with approved Ticket file contents via stdin. Other language profiles return unsupported; no tests, shell, repository writes, or network access is requested.`)) return
    const result = await requestLocal(dir(), { kind: 'workspace_format', ticketId })
    ctx.ui.notify(`gofmt status (NOT test results): ${JSON.stringify(result.format)}`, 'info')
  }) })
  pi.registerCommand('workspace-diff', { description: 'Review approved source edits already made in the bound working tree', handler: async (args, ctx) => run(ctx, async () => {
    const ticketId = args.trim()
    if (!ID.test(ticketId)) throw new Error('Usage: /workspace-diff <ticket-id>')
    await ownedTicket(ticketId)
    const result = await requestLocal(dir(), { kind: 'workspace_diff', ticketId })
    const diff = result.diff as WorkspaceDiff
    if (ctx.mode === 'tui') {
      await openTicketViewer(ctx, new TicketPanel({ kind: 'diff', ticketId, diff, index: 0 }), dir())
      return
    }
    for (const file of diff.files) {
      const rendered = JSON.stringify(file)
      if (rendered.length > 16_000) ctx.ui.notify(`${file.path}: diff too large for Pi notification; use interactive TUI to view the full file`, 'warning')
      else ctx.ui.notify(rendered, 'info')
    }
    if (!diff.files.length) ctx.ui.notify('No workspace changes', 'info')
  }) })
  const createCodingTask = async (ticketId: string, description: string, profile: string, ctx: ExtensionCommandContext) => {
    if (!ID.test(ticketId) || !description || !ctx.hasUI) throw new Error('Usage: /task <ticket-id> --code [--profile=name] <specific change>')
    CodingProfile.parse(profile)
    if (!availableCodingProfiles().includes(profile)) throw new Error(`Unknown Pi prompt profile: ${profile}`)
    await ownedTicket(ticketId)
    const workspace = (await requestLocal(dir(), { kind: 'workspace_list', ticketId })).workspace as { mode: string; head: string; paths: string[]; changed: string[] }
    if (workspace.mode !== 'write' || workspace.changed.length) throw new Error('Coding needs a fresh write-approved scope with no previous edits')
    if (!await ctx.ui.confirm('Approve coder and direct repository edits?', `Ticket ${ticketId}\nProfile: ${profile}\nTask: ${description}\nFiles: ${workspace.paths.join('\n')}\n\nLocal coder may read/edit ALL these tracked files directly. No shell, tests, commit or push. Review /workspace-diff afterward.`)) return
    const latest = (await requestLocal(dir(), { kind: 'workspace_list', ticketId })).workspace as { mode: string; head: string; paths: string[]; changed: string[] }
    if (latest.mode !== 'write' || latest.head !== workspace.head || latest.changed.length
      || JSON.stringify(latest.paths) !== JSON.stringify(workspace.paths)) throw new Error('Workspace scope changed; coding task not created')
    const result = await requestLocal(dir(), { kind: 'code_task', ticketId, title: description,
      paths: workspace.paths, head: workspace.head, profile })
    ctx.ui.notify(`Coder task added: ${readBoard(result).tasks.at(-1)?.id}; /collaborate ${ticketId} runs it with a bounded lease. No tests are run automatically.`, 'info')
    const current = bound
    if (current && current.ticketId === ticketId) supervise(current, ctx)
  }
  pi.registerCommand('code-task', { description: 'Alias for /task <ticket-id> --code <change>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    await createCodingTask(ticketId ?? '', words.join(' '), 'default', ctx)
  }) })
  pi.registerCommand('task', { description: 'Create task: /task <ticket-id> [--code [--profile=name]] <description>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, ...words] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !words.length || !ctx.hasUI) throw new Error('Usage: /task <ticket-id> [--code [--profile=name]] <description>')
    if (words[0] === '--code') {
      const names = availableCodingProfiles()
      // An explicit profile is unambiguous as --profile=<name>; the remaining words are the task.
      const requested = words[1]?.startsWith('--profile=') ? words[1].slice('--profile='.length) : undefined
      const profile = requested ?? 'default'
      if (!names.includes(profile)) throw new Error(`Unknown Pi prompt profile: ${profile}`)
      const description = words.slice(requested ? 2 : 1).join(' ')
      await createCodingTask(ticketId!, description, profile, ctx)
      return
    }
    await ownedTicket(ticketId!)
    const title = words.join(' ')
    if (!await ctx.ui.confirm('Add task to Ticket?', `${ticketId}\n${title}`)) return
    const result = await requestLocal(dir(), { kind: 'board_action', action: { op: 'task', ticketId: ticketId!, title } })
    ctx.ui.notify(`Task added: ${readBoard(result).tasks.at(-1)?.id}`, 'info')
  }) })
  pi.registerCommand('board', { description: 'Readable Ticket board: /board <ticket-id> [page]', handler: async (args, ctx) => run(ctx, async () => {
    const parts = args.trim().split(/\s+/)
    const [ticketId, pageText] = parts
    if (parts.length > 2 || !ID.test(ticketId ?? '') || (pageText !== undefined && !/^[1-9]\d*$/.test(pageText)))
      throw new Error('Usage: /board <ticket-id> [page]')
    await ownedTicket(ticketId!)
    const board = readBoard(await requestLocal(dir(), { kind: 'board', ticketId: ticketId! }))
    const { pages } = renderBoard(board)
    // Default to the latest page, where new results and proposals appear.
    const rendered = renderBoard(board, pageText ? Number(pageText) : pages)
    if (ctx.mode === 'tui') await openTicketViewer(ctx, new TicketPanel({ kind: 'board', ticketId: ticketId!,
      text: rendered.text, page: pageText ? Number(pageText) : pages, pages }), dir())
    else ctx.ui.notify(rendered.text, 'info')
  }) })
  pi.registerCommand('approve-agent', { description: 'Approve local subagent: /approve-agent <ticket-id> <agent-id>', handler: async (args, ctx) => run(ctx, async () => {
    const [ticketId, agentId] = args.trim().split(/\s+/)
    if (!ID.test(ticketId ?? '') || !ID.test(agentId ?? '') || !ctx.hasUI) throw new Error('Usage: /approve-agent <ticket-id> <agent-id> (interactive Pi only)')
    await ownedTicket(ticketId!)
    if (!await ctx.ui.confirm('Approve local subagent for this Ticket?', `${agentId} may claim explicitly assigned tasks and post discussion on ${ticketId}. Only a separately approved coder task can edit approved source files. No shell or network tools.`)) return
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
    const resultBoard = readBoard(result)
    ctx.ui.notify(renderBoard(resultBoard, renderBoard(resultBoard).pages).text, 'info')
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
