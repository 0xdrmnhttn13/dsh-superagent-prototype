import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { readBoard, requestLocal } from './client.ts'
import { renderBoard } from './board-view.ts'

export interface WorkspaceDiff { files: { path: string; before: string; after: string }[] }
export type PanelData = { kind: 'board'; ticketId: string; text: string; page: number; pages: number }
  | { kind: 'diff'; ticketId: string; diff: WorkspaceDiff; index: number }

/** Read-only viewer model. A progress result is not substituted for the persisted task state. */
export class TicketPanel {
  data: PanelData
  scroll = 0
  followLatest = true
  constructor(data: PanelData) { this.data = data }
  moveFile(delta: number): void {
    if (this.data.kind !== 'diff' || !this.data.diff.files.length) return
    this.data.index = Math.max(0, Math.min(this.data.diff.files.length - 1, this.data.index + delta))
    this.scroll = 0
  }
  movePage(delta: number): void {
    if (this.data.kind !== 'board') return
    this.data.page = Math.max(1, Math.min(this.data.pages, this.data.page + delta))
    this.followLatest = this.data.page === this.data.pages
    this.scroll = 0
  }
  lines(): string[] {
    if (this.data.kind === 'board') return this.data.text.split('\n')
    const file = this.data.diff.files[this.data.index]
    if (!file) return ['No workspace changes.']
    // Complete approved before/after snapshots; not an inferred patch.
    return [`FILE ${this.data.index + 1}/${this.data.diff.files.length}: ${file.path}`, '--- Before (approved baseline)',
      ...file.before.split('\n'), '+++ After (working tree)', ...file.after.split('\n')]
  }
  viewport(width: number, height: number): string[] {
    const body = this.lines().flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)))
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - height)))
    return body.slice(this.scroll, this.scroll + height).map(line => truncateToWidth(line, width))
  }
}

/** Pi's non-overlay custom screen replaces the editor while open; it does not cover the chat. */
export async function openTicketViewer(ctx: ExtensionCommandContext, model: TicketPanel, stateDir: string): Promise<void> {
  if (ctx.mode !== 'tui') throw new Error('Interactive Pi TUI required for viewer')
  let closed = false
  let polling = false
  let status: 'live' | 'unavailable' = 'live'
  let requestNumber = 0
  const refresh = async (render: () => void) => {
    if (closed || polling || model.data.kind !== 'board') return
    polling = true
    const number = ++requestNumber
    try {
      const board = readBoard(await requestLocal(stateDir, { kind: 'board', ticketId: model.data.ticketId }))
      if (closed || number !== requestNumber || model.data.kind !== 'board') return
      const latest = renderBoard(board)
      if (model.followLatest || model.data.page > latest.pages) model.data.page = latest.pages
      model.data.pages = latest.pages
      model.data.text = renderBoard(board, model.data.page).text
      status = 'live'
    } catch { if (!closed) status = 'unavailable' }
    finally { polling = false; if (!closed) render() }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await ctx.ui.custom<void>((tui, theme, _bindings, done) => {
      const finish = () => { if (!closed) { closed = true; done() } }
      if (model.data.kind === 'board') timer = setInterval(() => { void refresh(() => tui.requestRender()) }, 1500)
      return {
        invalidate: () => {},
        render: (width: number) => {
          const data = model.data
          const title = data.kind === 'board' ? `Board ${data.page}/${data.pages} · ${status}`
            : `Diff ${data.index + 1}/${data.diff.files.length} · snapshot`
          const nav = data.kind === 'board' ? '←/→ pages' : '←/→ files'
          const height = Math.max(3, tui.terminal.rows - 6)
          return [theme.fg('accent', truncateToWidth(`${title} · Ticket ${data.ticketId}`, width)),
            theme.fg('border', '─'.repeat(Math.max(1, width))), ...model.viewport(width, height),
            theme.fg('dim', truncateToWidth(`↑/↓ scroll · PgUp/PgDn jump · ${nav} · Esc return to chat`, width))]
        },
        handleInput: (key: string) => {
          if (matchesKey(key, 'escape') || matchesKey(key, 'ctrl+c')) { finish(); return }
          if (matchesKey(key, 'down') || matchesKey(key, 'pageDown')) model.scroll += matchesKey(key, 'down') ? 1 : 15
          else if (matchesKey(key, 'up') || matchesKey(key, 'pageUp')) model.scroll -= matchesKey(key, 'up') ? 1 : 15
          else if (matchesKey(key, 'right') || matchesKey(key, 'left')) {
            const delta = matchesKey(key, 'right') ? 1 : -1
            if (model.data.kind === 'diff') model.moveFile(delta)
            else { model.movePage(delta); void refresh(() => tui.requestRender()) }
          } else return
          tui.requestRender()
        },
      }
    })
  } finally { closed = true; requestNumber++; if (timer) clearInterval(timer) }
}
