import type { Collaboration, Board } from './collaboration.ts'
import type { Store } from '../app/store.ts'

export const LEASE_MS = 6_000
export const MAX_TURNS = 4
const key = (ticketId: string) => `collaboration:presence:${ticketId}`
interface Presence { session: string; expiresAt: number; remaining: number; paused: boolean }

/** A Pi session must explicitly resume after a daemon restart; persisted leases never authorize new work on startup. */
export class PresenceManager {
  private readonly active = new Map<string, { session: string; controller: AbortController; running: boolean }>()
  private readonly activeTurns = new Set<object>()
  constructor(private readonly store: Store, private readonly collaboration: Collaboration,
    private readonly runner: (ticketId: string, taskId: string, agentId: string, signal: AbortSignal) => Promise<Board>) {}
  private current(ticketId: string): Presence | undefined { return this.store.get<Presence>(key(ticketId)) }
  /** File approvals cannot change a running model turn's capabilities. */
  requireIdle(ticketId: string): void {
    this.collaboration.board(ticketId)
    if (this.active.get(ticketId)?.running) throw new Error('Agent turn in progress; wait for it to finish before approving files')
  }
  authorizeTurn(ticketId: string, taskId: string, agentId: string, signal?: AbortSignal): void {
    const active = this.active.get(ticketId)
    if (!active?.running || signal !== active.controller.signal || signal?.aborted || !this.view(ticketId).active)
      throw new Error('Workspace turn is no longer authorized')
    const task = this.collaboration.board(ticketId).tasks.find(item => item.id === taskId)
    if (task?.state !== 'claimed' || task.claimedBy !== agentId) throw new Error('Workspace task is no longer assigned')
    const scope = this.store.get<{ head: string; paths: string[] }>(`collaboration:code-task:${ticketId}:${taskId}`)
    if (agentId !== 'coder' || !scope)
      throw new Error('Workspace edits require a separately approved coder task')
  }
  view(ticketId: string): { active: boolean; remaining: number; paused: boolean } {
    this.collaboration.board(ticketId)
    const state = this.current(ticketId)
    const active = this.active.get(ticketId)
    if (state && active && state.expiresAt <= Date.now()) {
      active.controller.abort()
      this.active.delete(ticketId)
      this.store.set(key(ticketId), { ...state, paused: true, expiresAt: 0 })
    }
    return { active: !!state && !state.paused && state.expiresAt > Date.now() && this.active.get(ticketId)?.session === state.session,
      remaining: state?.remaining ?? 0, paused: state?.paused ?? true }
  }
  resume(ticketId: string, session: string, maxTurns = MAX_TURNS): void {
    this.collaboration.board(ticketId)
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session) || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS)
      throw new Error('Invalid collaboration lease')
    const current = this.view(ticketId)
    const existing = this.active.get(ticketId)
    if (existing?.running) throw new Error('Cannot replace lease during an agent turn')
    if (current.active && existing?.session !== session) throw new Error('Another Pi session holds the Ticket')
    const previous = this.current(ticketId)
    // Repeated resume never replenishes the budget. A fresh grant requires a paused/expired lease and owner confirmation.
    const remaining = current.active ? Math.min(previous!.remaining, maxTurns) : maxTurns
    this.store.set(key(ticketId), { session, expiresAt: Date.now() + LEASE_MS, remaining, paused: false } satisfies Presence)
    if (!this.active.has(ticketId)) this.active.set(ticketId, { session, controller: new AbortController(), running: false })
  }
  heartbeat(ticketId: string, session: string): void {
    const state = this.current(ticketId)
    if (!this.view(ticketId).active || !state || state.session !== session) throw new Error('Collaboration paused; resume explicitly')
    this.store.set(key(ticketId), { ...state, expiresAt: Date.now() + LEASE_MS })
  }
  pause(ticketId: string, session: string): void {
    const state = this.current(ticketId)
    if (!state || state.session !== session) return
    this.store.set(key(ticketId), { ...state, paused: true, expiresAt: 0 })
    this.active.get(ticketId)?.controller.abort()
    this.active.delete(ticketId)
    this.collaboration.event(ticketId, session, 'paused', 'Pi session paused collaboration; no new agent calls')
  }
  pauseAll(): void {
    for (const [ticketId, active] of this.active) this.pause(ticketId, active.session)
  }
  /** Wait for a cancelled provider turn before its Store is closed. */
  async drain(): Promise<void> {
    while (this.activeTurns.size) await new Promise(resolve => setTimeout(resolve, 10))
  }
  /** Prepare one owner-approved local task without granting the agent new capabilities. */
  prepare(ticketId: string, session: string): Board {
    const state = this.current(ticketId)
    if (!state || state.session !== session || !this.view(ticketId).active) throw new Error('Collaboration paused; resume explicitly')
    const active = this.active.get(ticketId)
    const board = this.collaboration.board(ticketId)
    if (active?.running || state.remaining < 1 || board.proposals.some(item => item.state === 'pending')) return board
    const approved = this.collaboration.registry().agents.find(agent => agent.id === 'reviewer' && agent.kind === 'local' && agent.tickets.includes(ticketId))
    if (!approved) throw new Error('Local reviewer not approved for Ticket')
    const coder = this.collaboration.registry().agents.find(agent => agent.id === 'coder' && agent.kind === 'local' && agent.tickets.includes(ticketId))
    // Do not claim more work while an earlier turn is in progress or failed ambiguously.
    if (board.tasks.some(task => task.state === 'claimed')) return board
    const open = board.tasks.find(task => task.state === 'open')
    if (open) {
      const coding = this.store.get(`collaboration:code-task:${ticketId}:${open.id}`)
      if (coding && !coder) throw new Error('Approved coder is unavailable; coding task cannot be assigned to reviewer')
      return this.collaboration.claim(ticketId, open.id, coding ? coder!.id : approved.id)
    }
    return board
  }
  async step(ticketId: string, session: string): Promise<Board> {
    const state = this.current(ticketId)
    const active = this.active.get(ticketId)
    if (!state || !active || state.session !== session || !this.view(ticketId).active) throw new Error('Collaboration paused; resume explicitly')
    if (active.running) throw new Error('Agent turn already running')
    if (state.remaining < 1) throw new Error('Turn budget exhausted')
    const board = this.collaboration.board(ticketId)
    if (board.proposals.some(item => item.state === 'pending')) throw new Error('Proposal awaits owner approval')
    const task = board.tasks.find(item => item.state === 'claimed' && item.claimedBy
      && !this.store.get(`agent-turn:${ticketId}:${item.claimedBy}:${item.id}`))
    if (!task) throw new Error('No claimed task ready for agent turn')
    // Reserve budget before the provider call. Crash or cancellation never refunds an ambiguous turn.
    this.store.set(key(ticketId), { ...state, remaining: state.remaining - 1 })
    active.running = true
    const turn = {}
    this.activeTurns.add(turn)
    try {
      return await this.runner(ticketId, task.id, task.claimedBy!, active.controller.signal)
    } finally { active.running = false; this.activeTurns.delete(turn) }
  }
}
