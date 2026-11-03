import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import type { Collaboration } from './collaboration.ts'

const PATH = z.string().min(1).max(300).refine(path => !isAbsolute(path) && !path.includes('\\') &&
  path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')))
const HASH = z.string().regex(/^[a-f0-9]{64}$/)
const bindingKey = (ticketId: string) => `workspace:source:${ticketId}`
const grantKey = (ticketId: string) => `workspace:approval:${ticketId}`
const Language = z.enum(['go', 'rust', 'cpp'])
export type WorkspaceLanguage = z.infer<typeof Language>
const Binding = z.object({ source: z.string(), head: z.string().regex(/^[a-f0-9]{40,64}$/), language: Language.optional() }).strict()
const Grant = Binding.extend({ paths: z.array(PATH).min(1).max(12), baseline: z.record(PATH, HASH),
  changed: z.array(PATH).max(12), mode: z.enum(['read', 'write']).optional() }).strict()
type Bound = z.infer<typeof Binding>
type Approved = z.infer<typeof Grant>
const MAX_SIZE = 64 * 1024
const CREDENTIAL = /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"]?\S{12,}/i

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } })
  if (result.error || result.status !== 0) throw new Error(`Repository Git check failed: ${result.error?.message ?? result.stderr.slice(0, 200)}`)
  return result.stdout.trim()
}
function eligible(path: string, language: WorkspaceLanguage): string {
  const parts = PATH.parse(path).split('/')
  const excluded = new Set(['config', 'vendor', 'target', 'build', 'third_party', 'third-party', 'node_modules'])
  if (parts.some(part => excluded.has(part) || /secret|credential|token|password|private|generated/i.test(part)))
    throw new Error('Excluded or sensitive workspace path')
  const allowed = language === 'go' ? /^(internal|cmd)\/.+\.go$/.test(path)
    : language === 'rust' ? /^src\/.+\.rs$/.test(path) || /^tests\/.+\.rs$/.test(path)
      : /^(src|include|tests)\/.+\.(?:cpp|cc|cxx|hpp|hh|hxx|h)$/.test(path)
  if (!allowed) throw new Error(`Path is not eligible for ${language} workspace policy`)
  return path
}
function file(root: string, path: string): string {
  let parent = root
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part)
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe source directory')
  }
  const target = join(root, path)
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SIZE || stat.size < 1)
    throw new Error('Unsafe source file')
  return target
}
function read(root: string, path: string): string {
  const fd = openSync(file(root, path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SIZE) throw new Error('Unsafe source file')
    const data = readFileSync(fd)
    if (data.includes(0)) throw new Error('Binary file refused')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(data)
    if (CREDENTIAL.test(content)) throw new Error('Potential credential detected; file refused')
    return content
  } finally { closeSync(fd) }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Ticket-scoped application allowlist. This is not an OS sandbox; no model-controlled shell or Git command. */
export class Workspace {
  constructor(private readonly store: Store, private readonly collaboration: Collaboration) {}
  private bound(ticketId: string): Bound {
    this.collaboration.board(ticketId)
    return Binding.parse(this.store.get(bindingKey(ticketId)))
  }
  private approved(ticketId: string): Approved {
    const binding = this.bound(ticketId)
    const grant = Grant.parse(this.store.get(grantKey(ticketId)))
    if (grant.source !== binding.source || grant.head !== binding.head || (grant.language ?? 'go') !== (binding.language ?? 'go'))
      throw new Error('Workspace binding mismatch')
    return grant
  }
  language(ticketId: string): WorkspaceLanguage { return this.bound(ticketId).language ?? 'go' }
  private unchanged(binding: Bound): void {
    if (realpathSync(binding.source) !== binding.source || git(binding.source, 'rev-parse', 'HEAD') !== binding.head)
      throw new Error('Repository changed since binding; stop and re-authorize')
  }
  bind(ticketId: string, source: string, language: WorkspaceLanguage = 'go'): { head: string; count: number; language: WorkspaceLanguage } {
    Language.parse(language)
    this.collaboration.board(ticketId)
    if (this.store.get(bindingKey(ticketId))) throw new Error('Repository already bound to Ticket')
    if (!isAbsolute(source) || lstatSync(source).isSymbolicLink()) throw new Error('Use an absolute repository root')
    const root = realpathSync(source)
    if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root || (process.getuid && lstatSync(root).uid !== process.getuid()))
      throw new Error('Repository root must be owned by the local user')
    const head = git(root, 'rev-parse', 'HEAD')
    const count = this.candidates(root, head, language).length
    if (count > 1000) throw new Error('Repository has too many eligible files for bounded discovery')
    this.store.set(bindingKey(ticketId), Binding.parse({ source: root, head, language }))
    return { head, count, language }
  }
  private candidates(root: string, head: string, language: WorkspaceLanguage): string[] {
    return git(root, 'ls-tree', '-r', '--name-only', head).split('\n').filter(path => {
      try { eligible(path, language); return true } catch { return false }
    })
  }
  discover(ticketId: string): { head: string; paths: string[] } {
    const binding = this.bound(ticketId)
    this.unchanged(binding)
    return { head: binding.head, paths: this.candidates(binding.source, binding.head, binding.language ?? 'go') }
  }
  has(ticketId: string): boolean { this.collaboration.board(ticketId); return this.store.get(grantKey(ticketId)) !== undefined }
  isBound(ticketId: string): boolean { this.collaboration.board(ticketId); return this.store.get(bindingKey(ticketId)) !== undefined }
  grant(ticketId: string, paths: string[]): { head: string; paths: string[]; mode: 'read' } {
    const binding = this.bound(ticketId)
    if (this.has(ticketId)) throw new Error('Files already approved for Ticket')
    if (!paths.length || paths.length > 12 || new Set(paths).size !== paths.length) throw new Error('Choose 1-12 unique source files')
    this.unchanged(binding)
    const language = binding.language ?? 'go'
    const candidates = new Set(this.candidates(binding.source, binding.head, language))
    const baseline: Record<string, string> = {}
    for (const raw of paths) {
      const path = eligible(raw, language)
      if (!candidates.has(path)) throw new Error(`File is not eligible and tracked: ${path}`)
      if (git(binding.source, 'ls-tree', binding.head, '--', path).split(' ')[0] !== '100644') throw new Error('Only regular tracked files allowed')
      if (git(binding.source, 'status', '--porcelain', '--', path)) throw new Error(`Source file already modified: ${path}`)
      baseline[path] = digest(read(binding.source, path))
    }
    // A revoked grant may leave old last-write hashes; never let them supersede this fresh snapshot.
    if (paths.some(path => this.store.get(`workspace:last:${ticketId}:${path}`) || this.store.get(`workspace:intent:${ticketId}:${path}`)))
      throw new Error('Prior workspace edit state exists; cannot grant this path automatically')
    this.store.set(grantKey(ticketId), Grant.parse({ ...binding, paths, baseline, changed: [], mode: 'read' }))
    return { head: binding.head, paths, mode: 'read' }
  }
  list(ticketId: string): { head: string; paths: string[]; changed: string[]; mode: 'read' | 'write' | 'legacy' } {
    const grant = this.approved(ticketId)
    return { head: grant.head, paths: grant.paths, changed: grant.changed, mode: grant.mode ?? 'legacy' }
  }
  /** Confirm a coding task's requested paths still exactly match the owner-approved write scope. */
  assertCodingScope(ticketId: string, head: string, paths: string[]): void {
    const grant = this.approved(ticketId)
    if (grant.mode !== 'write' || grant.head !== head || grant.changed.length || paths.length !== grant.paths.length
      || paths.some((path, index) => path !== grant.paths[index]) || grant.paths.some(path => this.store.get(`workspace:intent:${ticketId}:${path}`)))
      throw new Error('Coding task scope does not match a fresh write-approved grant')
    this.unchanged(grant)
    for (const path of grant.paths) {
      if (git(grant.source, 'status', '--porcelain', '--', path) || digest(read(grant.source, path)) !== grant.baseline[path])
        throw new Error(`Source file changed since write approval: ${path}`)
    }
  }
  /** A separate owner decision may upgrade an already-reviewed read grant without losing its baseline. */
  approveWrite(ticketId: string): { paths: string[]; mode: 'write' } {
    const grant = this.approved(ticketId)
    if (grant.mode !== 'read' || grant.changed.length || grant.paths.some(path => this.store.get(`workspace:intent:${ticketId}:${path}`)))
      throw new Error('Write approval requires an unmodified read-only grant')
    this.unchanged(grant)
    for (const path of grant.paths) {
      if (git(grant.source, 'status', '--porcelain', '--', path) || digest(read(grant.source, path)) !== grant.baseline[path])
        throw new Error(`Source file changed since read approval: ${path}`)
    }
    this.store.set(grantKey(ticketId), Grant.parse({ ...grant, mode: 'write' }))
    return { paths: grant.paths, mode: 'write' }
  }
  /** Revoke/re-scope only when no edit is pending; never erase an in-flight or unreviewed diff. */
  revoke(ticketId: string): void {
    const grant = this.approved(ticketId)
    if (grant.changed.length || grant.paths.some(path => this.store.get(`workspace:intent:${ticketId}:${path}`)
      || this.store.get(`workspace:last:${ticketId}:${path}`)))
      throw new Error('Cannot revoke files with pending or completed edits; review and resolve them first')
    this.unchanged(grant)
    for (const path of grant.paths) {
      if (git(grant.source, 'status', '--porcelain', '--', path) || digest(read(grant.source, path)) !== grant.baseline[path])
        throw new Error(`Source file changed since approval: ${path}`)
    }
    this.store.delete(grantKey(ticketId))
  }
  /** Inspect an interrupted write without clearing the durable intent or replaying the edit. */
  inspectIntent(ticketId: string, raw: string): { path: string; state: 'before' | 'after' | 'conflict'; before: string; after: string } {
    const grant = this.approved(ticketId)
    const path = eligible(raw, grant.language ?? 'go')
    if (!grant.paths.includes(path)) throw new Error('Path not approved for Ticket')
    this.unchanged(grant)
    const intent = z.object({ before: HASH, after: HASH }).strict().parse(this.store.get(`workspace:intent:${ticketId}:${path}`))
    const current = digest(read(grant.source, path))
    return { path, state: current === intent.before ? 'before' : current === intent.after ? 'after' : 'conflict', ...intent }
  }
  read(ticketId: string, raw: string): string {
    const grant = this.approved(ticketId)
    const path = eligible(raw, grant.language ?? 'go')
    if (!grant.paths.includes(path)) throw new Error('Path not approved for Ticket')
    this.unchanged(grant)
    if (this.store.get(`workspace:intent:${ticketId}:${path}`)) throw new Error('Ambiguous edit; owner review required before reading')
    const current = read(grant.source, path)
    const expected = this.store.get<string>(`workspace:last:${ticketId}:${path}`) ?? grant.baseline[path]
    if (digest(current) !== expected) throw new Error('Source file changed outside Ticket; refusing read')
    return current
  }
  write(ticketId: string, raw: string, content: string, signal?: AbortSignal, authorize?: () => void): void {
    if (signal?.aborted) throw new Error('Agent turn cancelled')
    authorize?.()
    const grant = this.approved(ticketId)
    const path = eligible(raw, grant.language ?? 'go')
    if (!grant.paths.includes(path)) throw new Error('Path not approved for Ticket')
    if (grant.mode !== 'write') throw new Error('Write permission not approved for Ticket')
    if (Buffer.byteLength(content) > MAX_SIZE || content.includes('\0') || CREDENTIAL.test(content)) throw new Error('Unsafe edited content')
    this.unchanged(grant)
    if (this.store.get(`workspace:intent:${ticketId}:${path}`)) throw new Error('Ambiguous prior edit; owner review required before another write')
    const current = read(grant.source, path)
    // First write must match the approved snapshot. Subsequent writes must match the last content written by this Ticket.
    const key = `workspace:last:${ticketId}:${path}`
    const expected = this.store.get<string>(key) ?? grant.baseline[path]
    if (digest(current) !== expected || (git(grant.source, 'status', '--porcelain', '--', path) && !grant.changed.includes(path)))
      throw new Error('Source file changed outside Ticket; refusing overwrite')
    const target = file(grant.source, path)
    const temp = `${target}.${randomUUID()}.tmp`
    const intent = `workspace:intent:${ticketId}:${path}`
    // Persist intent before touching the working tree. A crash can never authorize blind replay.
    this.store.set(intent, { before: expected, after: digest(content) })
    try {
      writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
      if (signal?.aborted) throw new Error('Agent turn cancelled')
      authorize?.()
      if (digest(read(grant.source, path)) !== expected) throw new Error('Source changed during edit')
      if (signal?.aborted) throw new Error('Agent turn cancelled')
      renameSync(temp, target)
      this.store.atomic(() => {
        this.store.set(key, digest(content))
        this.store.set(grantKey(ticketId), Grant.parse({ ...grant, changed: [...new Set([...grant.changed, path])] }))
        this.store.delete(intent)
      })
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  /** No repository execution: format only Ticket-written contents via gofmt stdin. This never writes the repo. */
  formatStatus(ticketId: string): { head: string; files: { path: string; formatted: boolean; error?: string }[] } {
    const grant = this.approved(ticketId)
    this.unchanged(grant)
    if (grant.paths.some(path => this.store.get(`workspace:intent:${ticketId}:${path}`)))
      throw new Error('Ambiguous edit; formatting status unavailable until manual recovery')
    const files = grant.changed.map(path => {
      if ((grant.language ?? 'go') !== 'go') return { path, formatted: false,
        error: 'gofmt supports Go only; use an owner-approved language-specific validator separately' }
      const content = this.read(ticketId, path)
      const result = spawnSync('gofmt', [], { input: content, cwd: grant.source, encoding: 'utf8', timeout: 5_000,
        maxBuffer: MAX_SIZE + 1024, env: { PATH: process.env.PATH ?? '' } })
      if (result.error || result.status !== 0) return { path, formatted: false,
        error: (result.error?.message ?? result.stderr ?? 'gofmt failed').slice(0, 500) }
      return { path, formatted: result.stdout === content }
    })
    return { head: grant.head, files }
  }
  diff(ticketId: string): { head: string; files: { path: string; before: string; after: string }[] } {
    const grant = this.approved(ticketId)
    this.unchanged(grant)
    if (grant.paths.some(path => this.store.get(`workspace:intent:${ticketId}:${path}`)))
      throw new Error('Ambiguous edit; inspect pending write before relying on diff')
    return { head: grant.head, files: grant.changed.map(path => {
      if (this.store.get(`workspace:intent:${ticketId}:${path}`)) throw new Error('Ambiguous edit; owner review required')
      const after = read(grant.source, path)
      if (digest(after) !== this.store.get(`workspace:last:${ticketId}:${path}`)) throw new Error('Source edited outside Ticket')
      const result = spawnSync('git', ['--no-optional-locks', 'show', `${grant.head}:${path}`], { cwd: grant.source, encoding: 'buffer',
        timeout: 10_000, maxBuffer: MAX_SIZE + 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } })
      if (result.error || result.status !== 0 || !result.stdout || result.stdout.length > MAX_SIZE) throw new Error('Cannot read approved baseline')
      const before = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
      if (digest(before) !== grant.baseline[path]) throw new Error('Baseline mismatch')
      return { path, before, after }
    }).filter(entry => entry.before !== entry.after) }
  }
}
