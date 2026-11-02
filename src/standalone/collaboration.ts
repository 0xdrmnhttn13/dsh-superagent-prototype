import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
// Actor identity is OS-derived, never accepted from request JSON.

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const Task = z.object({ id: ID, title: z.string().trim().min(1).max(500), state: z.enum(['open', 'claimed', 'done']),
  claimedBy: ID.optional(), createdAt: z.string(), updatedAt: z.string() }).strict()
const Message = z.object({ id: ID, taskId: ID.optional(), actor: ID, text: z.string().trim().min(1).max(4000), at: z.string() }).strict()
export const Board = z.object({ ticketId: ID, tasks: z.array(Task).max(100), messages: z.array(Message).max(500) }).strict()
export type Board = z.infer<typeof Board>
export const AgentConfig = z.object({ id: ID, kind: z.enum(['local', 'external']), endpoint: z.url().optional(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), tickets: z.array(ID).max(100) }).strict()
export const Registry = z.object({ agents: z.array(AgentConfig).max(32) }).strict()
export type Registry = z.infer<typeof Registry>
export type Agent = z.infer<typeof AgentConfig>

export const BoardAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('task'), ticketId: ID, title: Task.shape.title }).strict(),
  z.object({ op: z.literal('claim'), ticketId: ID, taskId: ID }).strict(),
  z.object({ op: z.literal('complete'), ticketId: ID, taskId: ID }).strict(),
  z.object({ op: z.literal('message'), ticketId: ID, taskId: ID.optional(), text: Message.shape.text }).strict(),
])
export type BoardAction = z.infer<typeof BoardAction>
const key = (ticketId: string) => `collaboration:board:${ticketId}`
const agentsKey = 'collaboration:agents'
const approvalKey = (ticketId: string, agentId: string) => `collaboration:approval:${ticketId}:${agentId}`
const tokenHash = (token: string) => createHash('sha256').update(token).digest()
const owner = () => {
  if (!process.getuid) throw new Error('Local actor requires an OS uid')
  return `uid-${process.getuid()}`
}

export class Collaboration {
  private readonly store: Store
  constructor(store: Store) { this.store = store }
  private ticket(ticketId: string) {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.ended || ticket.mandate.actor.source !== 'local' || ticket.mandate.actor.id !== owner())
      throw new Error('Ticket not authorized or no longer open')
    return ticket
  }
  board(ticketId: string): Board {
    this.ticket(ticketId)
    return Board.parse(this.store.get(key(ticketId)) ?? { ticketId, tasks: [], messages: [] })
  }
  registry(): Registry { return Registry.parse(this.store.get(agentsKey) ?? { agents: [] }) }
  /** Owner approval is required even when an agent is already in the registry. Never persist plaintext tokens. */
  approve(ticketId: string, agent: Agent, token?: string): void {
    this.ticket(ticketId)
    const parsed = AgentConfig.parse(agent)
    if (parsed.kind === 'external') {
      const url = new URL(parsed.endpoint ?? '')
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !parsed.tokenEnv || !token || token.length < 32
        || process.env[parsed.tokenEnv] !== token)
        throw new Error('External agent requires HTTPS and a matching environment token of at least 32 characters')
    } else if (parsed.endpoint || parsed.tokenEnv || token) throw new Error('Local agent cannot have an external credential')
    this.store.atomic(() => {
      const registry = this.registry()
      const previous = registry.agents.find(item => item.id === parsed.id)
      if (previous && (previous.kind !== parsed.kind || previous.endpoint !== parsed.endpoint || previous.tokenEnv !== parsed.tokenEnv))
        throw new Error('Agent identity already registered with different configuration')
      const next = { ...parsed, tickets: [...new Set([...(previous?.tickets ?? []), ticketId])] }
      this.store.set(agentsKey, Registry.parse({ agents: [...registry.agents.filter(item => item.id !== parsed.id), next] }))
      if (token) this.store.set(approvalKey(ticketId, parsed.id), tokenHash(token).toString('hex'))
    })
  }
  revoke(ticketId: string, agentId: string): void {
    this.ticket(ticketId)
    this.store.atomic(() => {
      const registry = this.registry()
      this.store.set(agentsKey, { agents: registry.agents.map(agent => agent.id === agentId
        ? { ...agent, tickets: agent.tickets.filter(id => id !== ticketId) } : agent) })
      this.store.delete(approvalKey(ticketId, agentId))
    })
  }
  approved(ticketId: string, agentId: string): Agent {
    this.ticket(ticketId)
    const agent = this.registry().agents.find(item => item.id === agentId && item.tickets.includes(ticketId))
    if (!agent) throw new Error('Agent not approved for Ticket')
    return agent
  }
  authorized(ticketId: string, agentId: string, token?: string): Agent {
    const agent = this.approved(ticketId, agentId)
    if (agent.kind === 'external') {
      const saved = this.store.get<string>(approvalKey(ticketId, agentId))
      if (!saved || !token || !/^[a-f0-9]{64}$/.test(saved) || !timingSafeEqual(Buffer.from(saved, 'hex'), tokenHash(token)))
        throw new Error('Invalid agent credential')
    }
    return agent
  }
  claim(ticketId: string, taskId: string, agentId: string): Board {
    return this.store.atomic(() => {
      this.approved(ticketId, agentId)
      const board = this.board(ticketId)
      const task = board.tasks.find(item => item.id === taskId)
      if (!task || task.state !== 'open') throw new Error('Task unavailable for claim')
      task.state = 'claimed'; task.claimedBy = agentId; task.updatedAt = new Date().toISOString()
      this.store.set(key(ticketId), Board.parse(board))
      return board
    })
  }
  act(actorId: string, raw: unknown, token?: string): Board {
    const action = BoardAction.parse(raw)
    const agent = actorId === owner() ? undefined : token === undefined
      ? this.approved(action.ticketId, actorId) : this.authorized(action.ticketId, actorId, token)
    if (agent?.kind === 'external' && token === undefined) throw new Error('External agent requires a credential')
    return this.store.atomic(() => {
      const board = this.board(action.ticketId)
      const now = new Date().toISOString()
      if (action.op === 'task') {
        if (agent) throw new Error('Only owner can create tasks')
        board.tasks.push({ id: randomUUID(), title: action.title, state: 'open', createdAt: now, updatedAt: now })
      } else {
        const task = 'taskId' in action ? board.tasks.find(item => item.id === action.taskId) : undefined
        if (action.op !== 'message' && !task) throw new Error('Unknown task')
        if (action.op === 'claim') {
          if (task!.state !== 'open') throw new Error('Task already claimed or completed')
          task!.state = 'claimed'; task!.claimedBy = actorId; task!.updatedAt = now
        } else if (action.op === 'complete') {
          if (task!.state !== 'claimed' || task!.claimedBy !== actorId) throw new Error('Only the claimant can complete a task')
          task!.state = 'done'; task!.updatedAt = now
        } else {
          if (action.taskId && !task) throw new Error('Unknown task')
          board.messages.push({ id: randomUUID(), ...(action.taskId ? { taskId: action.taskId } : {}), actor: actorId, text: action.text, at: now })
        }
      }
      const parsed = Board.parse(board)
      this.store.set(key(action.ticketId), parsed)
      return parsed
    })
  }
}
