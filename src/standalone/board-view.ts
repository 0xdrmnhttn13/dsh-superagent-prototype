import type { Board } from './collaboration.ts'

const wib = (at: string) => `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(at))} WIB (UTC+7)`
const legend = 'TASK = work status · MESSAGE = discussion · PROGRESS = checkpoint/event · PROPOSAL = awaiting owner decision'
const taskLine = (task: Board['tasks'][number]) => `TASK ${task.state.toUpperCase()} ${task.id}\n${task.title}\nOwner: ${task.claimedBy ?? 'unclaimed'} · updated ${wib(task.updatedAt)}`

/** The default/latest page repeats a bounded status summary; historic pages remain complete and unchanged. */
export function renderBoard(board: Board, page = 1): { pages: number; text: string } {
  const tasks = board.tasks.map(taskLine)
  const activity = [
    ...board.messages.map(message => ({ at: message.at, text: `MESSAGE ${wib(message.at)} · ${message.actor}${message.taskId ? ` · task ${message.taskId}` : ''}\n${message.text}` })),
    ...board.proposals.map(proposal => ({ at: proposal.at, text: `PROPOSAL ${proposal.state.toUpperCase()} ${proposal.kind} ${proposal.id}\nBy ${proposal.actor} · ${wib(proposal.at)} · ${proposal.reason}\n${proposal.paths?.map(path => `- ${path}`).join('\n') ?? proposal.title ?? proposal.agentId ?? ''}` })),
    ...board.progress.map(event => ({ at: event.at, text: `PROGRESS ${wib(event.at)} · ${event.kind} · ${event.actor}${event.taskId ? ` · task ${event.taskId}` : ''}\n${event.explanation}` })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const entries = [...tasks, ...activity.map(item => item.text)]
  // Split on entries, not characters: never cut a finding, file path, or approval ID in half.
  const chunks: string[][] = []
  let current: string[] = []
  let length = 0
  for (const entry of entries) {
    if (current.length && (current.length >= 5 || length + entry.length > 6000)) {
      chunks.push(current); current = []; length = 0
    }
    current.push(entry)
    length += entry.length
  }
  if (current.length) chunks.push(current)
  if (!chunks.length) chunks.push(['No tasks, discussion, proposals or progress yet.'])
  const pages = chunks.length
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`Board page must be 1-${pages}`)
  // Show current work even if activity has pushed its TASK entry onto an earlier page.
  const recentTasks = board.tasks.slice(-3).map(task => `TASK ${task.state.toUpperCase()} · ${task.title}\nID: ${task.id} · ${task.claimedBy ?? 'unclaimed'}`)
  const pending = board.proposals.filter(proposal => proposal.state === 'pending')
  const summary = page === pages && board.tasks.length
    ? `Latest task statuses (showing ${recentTasks.length} of ${board.tasks.length}) · proposals needing approval: ${pending.length}\n${recentTasks.join('\n')}${pending.length ? `\nPending: ${pending.map(item => item.id).join(', ')}` : ''}\n\n`
    : ''
  return { pages, text: `Ticket ${board.ticketId} · page ${page}/${pages}\nUse /board ${board.ticketId} <page> to navigate.\n${legend}\nTimes are shown in WIB (UTC+7), independent of your computer’s timezone.\n\n${summary}${chunks[page - 1]!.join('\n\n')}` }
}
