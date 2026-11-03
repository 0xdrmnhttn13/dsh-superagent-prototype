import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LocalRuntime } from '../src/standalone/runtime.ts'
import { requestLocal } from '../src/standalone/client.ts'
import { localActor, processLocalRequest } from '../src/sources/local-ingress.ts'
import type { SessionFactory } from '../src/standalone/pi.ts'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })
const fresh = () => { const path = mkdtempSync(join(tmpdir(), 'sa-workspace-')); chmodSync(path, 0o700); dirs.push(path); return path }
const fake: SessionFactory = async id => ({ id, tools: ['sa_context', 'sa_evidence', 'sa_report'], prompt: async () => {}, abort: async () => {}, dispose: () => {} })
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
async function setup(runner?: ConstructorParameters<typeof LocalRuntime>[0]['agentRunner']) {
  const source = fresh()
  mkdirSync(join(source, 'internal'), { mode: 0o700 })
  mkdirSync(join(source, 'config'), { mode: 0o700 })
  writeFileSync(join(source, 'internal', 'service.go'), 'package internal\nfunc Safe() bool { return true }\n')
  writeFileSync(join(source, 'internal', 'service_test.go'), 'package internal\n')
  writeFileSync(join(source, 'config', 'config.go'), 'package config\n')
  git(source, 'init', '-q')
  git(source, 'add', 'internal/service.go', 'internal/service_test.go', 'config/config.go')
  git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'synthetic')
  const stateDir = fresh()
  const runtime = new LocalRuntime({ stateDir, sessionFactory: fake, agentRunner: runner })
  await runtime.start()
  await processLocalRequest(runtime.host, { kind: 'submit', investigationId: 'workspace-test', eventId: 'synthetic', text: 'Synthetic refactor', evidence: [] })
  const ticketId = runtime.store.tickets.list()[0]!.id
  return { runtime, source, stateDir, ticketId }
}

describe('Ticket-scoped original working-tree access', () => {
  it('binds explicit Rust/C++ profiles without broadening existing Go Ticket bindings', async () => {
    const { runtime, source, ticketId } = await setup()
    try {
      mkdirSync(join(source, 'src'))
      mkdirSync(join(source, 'include'))
      writeFileSync(join(source, 'src', 'lib.rs'), 'pub fn value() -> u32 { 1 }\n')
      writeFileSync(join(source, 'src', 'engine.cpp'), 'int engine() { return 1; }\n')
      writeFileSync(join(source, 'include', 'engine.hpp'), 'int engine();\n')
      git(source, 'add', 'src/lib.rs', 'src/engine.cpp', 'include/engine.hpp')
      git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'multilanguage')
      runtime.workspace.bind(ticketId, source, 'rust')
      expect(runtime.workspace.discover(ticketId).paths).toEqual(['src/lib.rs'])
      expect(() => runtime.workspace.grant(ticketId, ['src/engine.cpp'])).toThrow('not eligible')
      runtime.workspace.grant(ticketId, ['src/lib.rs'])
      expect(runtime.workspace.read(ticketId, 'src/lib.rs')).toContain('pub fn')
      expect(() => runtime.workspace.read(ticketId, 'internal/service.go')).toThrow('not eligible')
      expect(() => runtime.workspace.bind(ticketId, source, 'cpp')).toThrow('already bound')
      const another = await processLocalRequest(runtime.host, { kind: 'submit', investigationId: 'cpp-test', eventId: 'cpp-event', text: 'Cpp', evidence: [] })
      expect(another.ok).toBe(true)
      const cppTicket = runtime.store.tickets.list().find(item => item.id !== ticketId)!.id
      runtime.workspace.bind(cppTicket, source, 'cpp')
      expect(runtime.workspace.discover(cppTicket).paths).toEqual(['include/engine.hpp', 'src/engine.cpp'])
      expect(() => runtime.workspace.grant(cppTicket, ['src/lib.rs'])).toThrow('not eligible')
      runtime.workspace.grant(cppTicket, ['src/engine.cpp'])
      runtime.workspace.approveWrite(cppTicket)
      runtime.workspace.write(cppTicket, 'src/engine.cpp', 'int engine() { return 2; }\n')
      expect(runtime.workspace.formatStatus(cppTicket).files).toMatchObject([{ formatted: false, error: expect.stringContaining('Go only') }])
    } finally { await runtime.shutdown() }
  })

  it('binds filename discovery without contents, then requires an owner-reviewed file proposal before editing', async () => {
    const { runtime, source, stateDir, ticketId } = await setup()
    try {
      const path = 'internal/service.go'
      expect((await requestLocal(stateDir, { kind: 'workspace_bind', ticketId, source })).workspace)
        .toMatchObject({ head: git(source, 'rev-parse', 'HEAD'), count: 2 })
      expect(runtime.workspace.discover(ticketId).paths).toEqual(['internal/service.go', 'internal/service_test.go'])
      expect(() => runtime.workspace.read(ticketId, path)).toThrow()
      runtime.collaboration.approve(ticketId, { id: 'reviewer', kind: 'local', tickets: [] })
      const proposed = runtime.collaboration.act('reviewer', { op: 'propose_files', ticketId, paths: [path], reason: 'Review this Go function' })
      expect(proposed.proposals).toMatchObject([expect.objectContaining({ kind: 'files', state: 'pending', paths: [path] })])
      expect(() => runtime.collaboration.resolve(ticketId, proposed.proposals[0]!.id, true)).toThrow('explicit workspace grant')
      const declined = await requestLocal(stateDir, { kind: 'resolve_proposal', ticketId, proposalId: proposed.proposals[0]!.id, approve: false })
      expect(declined.board).toMatchObject({ proposals: [expect.objectContaining({ state: 'rejected' })] })
      const next = runtime.collaboration.act('reviewer', { op: 'propose_files', ticketId, paths: [path], reason: 'Owner may grant one file' })
      const result = await requestLocal(stateDir, { kind: 'resolve_proposal', ticketId, proposalId: next.proposals[1]!.id, approve: true })
      expect(result.board).toMatchObject({ proposals: [expect.anything(), expect.objectContaining({ state: 'approved' })] })
      expect(runtime.workspace.read(ticketId, path)).toContain('return true')
      expect(() => runtime.workspace.read(ticketId, 'internal/service_test.go')).toThrow('not approved')
      expect(() => runtime.workspace.write(ticketId, path, 'package internal\nfunc Safe() bool { return false }\n')).toThrow('Write permission')
      expect(runtime.workspace.list(ticketId).mode).toBe('read')
      expect((await requestLocal(stateDir, { kind: 'workspace_approve_write', ticketId })).workspace).toMatchObject({ mode: 'write', paths: [path] })
      runtime.workspace.write(ticketId, path, 'package internal\nfunc Safe() bool { return false }\n')
      expect(readFileSync(join(source, path), 'utf8')).toContain('return false')
      expect((await requestLocal(stateDir, { kind: 'workspace_diff', ticketId })).diff).toMatchObject({
        files: [{ path, before: expect.stringContaining('return true'), after: expect.stringContaining('return false') }],
      })
      const formatting = (await requestLocal(stateDir, { kind: 'workspace_format', ticketId })).format
      expect(formatting).toMatchObject({ files: [{ path, formatted: false }] })
    } finally { await runtime.shutdown() }
  })

  it('runs one bounded Ticket turn via socket and rejects writing after pause', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let finish!: (value: { message: string; done: boolean }) => void
    const { runtime, source, stateDir, ticketId } = await setup(async (turn, signal) => {
      const before = runtime.workspace.read(turn.ticketId, 'internal/service.go')
      runtime.workspace.write(turn.ticketId, 'internal/service.go', before.replace('true', 'false'), signal,
        () => runtime.presence.authorizeTurn(turn.ticketId, turn.taskId, turn.actor, signal))
      entered()
      return new Promise(resolve => { finish = resolve })
    })
    try {
      await requestLocal(stateDir, { kind: 'workspace_bind', ticketId, source })
      runtime.workspace.grant(ticketId, ['internal/service.go'])
      runtime.workspace.approveWrite(ticketId)
      runtime.collaboration.approve(ticketId, { id: 'reviewer', kind: 'local', tickets: [] })
      const scope = runtime.workspace.list(ticketId)
      const created = await requestLocal(stateDir, { kind: 'code_task', ticketId, title: 'Small Go change', head: scope.head, paths: scope.paths })
      expect(created.board).toMatchObject({ tasks: [expect.objectContaining({ state: 'open' })] })
      const session = 'pi-workspace'
      await requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'resume' })
      const prepared = await requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'prepare' })
      expect(prepared.board).toMatchObject({ tasks: [expect.objectContaining({ state: 'claimed', claimedBy: 'coder' })] })
      const step = requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'step' })
      await started
      expect(readFileSync(join(source, 'internal/service.go'), 'utf8')).toContain('false')
      await requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'pause' })
      expect(() => runtime.presence.authorizeTurn(ticketId, runtime.collaboration.board(ticketId).tasks[0]!.id, 'coder', new AbortController().signal))
        .toThrow('no longer authorized')
      finish({ message: 'Late result', done: true })
      await expect(step).rejects.toThrow('request_failed')
      expect(runtime.collaboration.board(ticketId).messages).toHaveLength(0)
    } finally { await runtime.shutdown() }
  })

  it('runs a distinct coder on a CODE task with Ticket-scoped write and keeps other paths untouched', async () => {
    const { runtime, source, stateDir, ticketId } = await setup(async (turn, signal) => {
      expect(turn.actor).toBe('coder')
      const before = runtime.workspace.read(turn.ticketId, 'internal/service.go')
      runtime.workspace.write(turn.ticketId, 'internal/service.go', before.replace('true', 'false'), signal,
        () => runtime.presence.authorizeTurn(turn.ticketId, turn.taskId, turn.actor, signal))
      return { message: 'Changed approved source; tests not run', done: true }
    })
    try {
      runtime.workspace.bind(ticketId, source)
      runtime.workspace.grant(ticketId, ['internal/service.go'])
      runtime.workspace.approveWrite(ticketId)
      runtime.collaboration.approve(ticketId, { id: 'reviewer', kind: 'local', tickets: [] })
      const scope = runtime.workspace.list(ticketId)
      const board = (await requestLocal(stateDir, { kind: 'code_task', ticketId, title: 'Small Go change', head: scope.head, paths: scope.paths })).board as { tasks: { id: string }[] }
      runtime.presence.resume(ticketId, 'pi-code')
      expect(runtime.presence.prepare(ticketId, 'pi-code').tasks[0]).toMatchObject({ claimedBy: 'coder' })
      const result = await requestLocal(stateDir, { kind: 'collaboration', ticketId, session: 'pi-code', op: 'step' })
      expect(result.board).toMatchObject({ tasks: [expect.objectContaining({ id: board.tasks[0]!.id, state: 'done' })] })
      expect(runtime.workspace.diff(ticketId).files[0]?.after).toContain('false')
      expect(readFileSync(join(source, 'internal/service_test.go'), 'utf8')).toBe('package internal\n')
      expect(runtime.collaboration.board(ticketId).messages.at(-1)?.text).toContain('tests not run')
    } finally { await runtime.shutdown() }
  })

  it('refuses to grant files while an agent turn is running, including direct socket grants', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let finish!: (value: { message: string; done: boolean }) => void
    const { runtime, source, stateDir, ticketId } = await setup(async () => {
      entered()
      return new Promise(resolve => { finish = resolve })
    })
    try {
      await requestLocal(stateDir, { kind: 'workspace_bind', ticketId, source })
      runtime.collaboration.approve(ticketId, { id: 'reviewer', kind: 'local', tickets: [] })
      const proposal = runtime.collaboration.act('reviewer', { op: 'propose_files', ticketId,
        paths: ['internal/service.go'], reason: 'Need source approval' }).proposals[0]!
      // Start a turn without a pending proposal; simulate a proposed scope change during it.
      runtime.collaboration.resolve(ticketId, proposal.id, false)
      const taskId = runtime.collaboration.act(localActor(), { op: 'task', ticketId, title: 'Review' }).tasks[0]!.id
      runtime.collaboration.claim(ticketId, taskId, 'reviewer')
      const session = 'pi-inflight'
      await requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'resume' })
      const step = requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'step' })
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Agent never started')), 800))])
      const second = runtime.collaboration.act('reviewer', { op: 'propose_files', ticketId,
        paths: ['internal/service.go'], reason: 'Wait until idle' }).proposals[1]!
      expect(() => runtime.presence.requireIdle(ticketId)).toThrow('Agent turn in progress')
      expect(() => runtime.collaboration.resolve(ticketId, second.id, true,
        paths => { runtime.presence.requireIdle(ticketId); runtime.workspace.grant(ticketId, paths) })).toThrow('Agent turn in progress')
      expect(runtime.workspace.has(ticketId)).toBe(false)
      finish({ message: 'finished', done: true })
      await step
      await requestLocal(stateDir, { kind: 'collaboration', ticketId, session, op: 'pause' })
      expect(runtime.collaboration.board(ticketId).proposals[1]?.state).toBe('pending')
    } finally { await runtime.shutdown() }
  })

  it('revokes a legacy broad grant before edits and re-grants a narrow read scope', async () => {
    const { runtime, source, stateDir, ticketId } = await setup()
    try {
      runtime.workspace.bind(ticketId, source)
      runtime.workspace.grant(ticketId, ['internal/service.go', 'internal/service_test.go'])
      runtime.workspace.approveWrite(ticketId)
      expect(runtime.workspace.list(ticketId).paths).toHaveLength(2)
      await requestLocal(stateDir, { kind: 'workspace_revoke', ticketId })
      expect(runtime.workspace.has(ticketId)).toBe(false)
      expect((await requestLocal(stateDir, { kind: 'workspace_grant', ticketId, paths: ['internal/service.go'] })).workspace)
        .toMatchObject({ mode: 'read', paths: ['internal/service.go'] })
      expect(() => runtime.workspace.write(ticketId, 'internal/service.go', 'package internal\n')).toThrow('Write permission')
      expect((await requestLocal(stateDir, { kind: 'workspace_approve_write', ticketId })).workspace).toMatchObject({ mode: 'write' })
      runtime.workspace.write(ticketId, 'internal/service.go', 'package internal\n')
      await expect(requestLocal(stateDir, { kind: 'workspace_revoke', ticketId })).rejects.toThrow('request_failed')
    } finally { await runtime.shutdown() }
  })

  it('fails closed on interrupted edits, exposing hashes for owner inspection without replay', async () => {
    const { runtime, source, stateDir, ticketId } = await setup()
    try {
      runtime.workspace.bind(ticketId, source)
      const path = 'internal/service.go'
      runtime.workspace.grant(ticketId, [path])
      runtime.workspace.approveWrite(ticketId)
      const before = readFileSync(join(source, path), 'utf8')
      const after = before.replace('true', 'false')
      const digest = (text: string) => createHash('sha256').update(text).digest('hex')
      runtime.store.set(`workspace:intent:${ticketId}:${path}`, { before: digest(before), after: digest(after) })
      expect((await requestLocal(stateDir, { kind: 'workspace_inspect', ticketId, path })).intent.state).toBe('before')
      expect(() => runtime.workspace.read(ticketId, path)).toThrow('Ambiguous edit')
      expect(() => runtime.workspace.write(ticketId, path, after)).toThrow('Ambiguous prior edit')
      expect(() => runtime.workspace.diff(ticketId)).toThrow('Ambiguous edit')
      expect(() => runtime.workspace.formatStatus(ticketId)).toThrow('Ambiguous edit')
      await expect(requestLocal(stateDir, { kind: 'workspace_revoke', ticketId })).rejects.toThrow('request_failed')
      writeFileSync(join(source, path), after)
      expect((await requestLocal(stateDir, { kind: 'workspace_inspect', ticketId, path })).intent.state).toBe('after')
      writeFileSync(join(source, path), 'package internal\n// another writer\n')
      expect((await requestLocal(stateDir, { kind: 'workspace_inspect', ticketId, path })).intent.state).toBe('conflict')
    } finally { await runtime.shutdown() }
  })

  it('rejects untracked/dirty/linked/secret paths and never overwrites another writer', async () => {
    const { runtime, source, ticketId } = await setup()
    try {
      runtime.workspace.bind(ticketId, source)
      for (const path of ['../internal/service.go', '.env', 'config/config.go', 'internal/secret.go', '/etc/passwd'])
        expect(() => runtime.workspace.grant(ticketId, [path])).toThrow()
      expect(() => runtime.workspace.grant(ticketId, ['internal/missing.go'])).toThrow('not eligible and tracked')
      writeFileSync(join(source, 'internal', 'service.go'), 'package internal\n// password: abcdefghijklmnopqrstuvwxyz\n')
      expect(() => runtime.workspace.grant(ticketId, ['internal/service.go'])).toThrow('already modified')
      git(source, 'checkout', '--', 'internal/service.go')
      rmSync(join(source, 'internal', 'service.go'))
      symlinkSync(join(source, 'internal', 'service_test.go'), join(source, 'internal', 'service.go'))
      expect(() => runtime.workspace.grant(ticketId, ['internal/service.go'])).toThrow()
    } finally { await runtime.shutdown() }
  })

  it('rejects changes outside the Ticket after grant and cancellation before write', async () => {
    const { runtime, source, ticketId } = await setup()
    try {
      runtime.workspace.bind(ticketId, source)
      runtime.workspace.grant(ticketId, ['internal/service.go'])
      runtime.workspace.approveWrite(ticketId)
      const controller = new AbortController()
      controller.abort()
      expect(() => runtime.workspace.write(ticketId, 'internal/service.go', 'package internal\n', controller.signal)).toThrow('cancelled')
      expect(() => runtime.workspace.write(ticketId, 'internal/service_test.go', 'package internal\n')).toThrow('not approved')
      expect(() => runtime.workspace.write(ticketId, 'internal/service.go', '// token: abcdefghijklmnopqrstuvwxyz\n')).toThrow('Unsafe edited content')
      writeFileSync(join(source, 'internal', 'service.go'), 'package internal\n// external edit\n')
      expect(() => runtime.workspace.read(ticketId, 'internal/service.go')).toThrow('outside Ticket')
      expect(() => runtime.workspace.write(ticketId, 'internal/service.go', 'package internal\n')).toThrow('outside Ticket')
    } finally { await runtime.shutdown() }
  })
})
