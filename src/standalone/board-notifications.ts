import type { Board } from './collaboration.ts'

export type BoardNotice = { id: string; kind: 'done' | 'message'; text: string }

/** Tracks persisted IDs/states, not progress prose. Seed on resume so old events never replay. */
export class BoardNotifications {
  private readonly messages = new Set<string>()
  private readonly done = new Set<string>()
  constructor(board: Board) {
    for (const message of board.messages) this.messages.add(message.id)
    for (const task of board.tasks) if (task.state === 'done') this.done.add(task.id)
  }
  update(board: Board): BoardNotice[] {
    const notices: BoardNotice[] = []
    for (const message of board.messages) {
      if (this.messages.has(message.id)) continue
      this.messages.add(message.id)
      notices.push({ id: message.id, kind: 'message', text: `New message from ${message.actor}${message.taskId ? ` · task ${message.taskId}` : ''}: ${message.text}` })
    }
    for (const task of board.tasks) {
      if (task.state !== 'done' || this.done.has(task.id)) continue
      this.done.add(task.id)
      notices.push({ id: task.id, kind: 'done', text: `Task DONE · ${task.title} · ${task.claimedBy ?? 'unassigned'} · ${task.id}` })
    }
    return notices
  }
}
