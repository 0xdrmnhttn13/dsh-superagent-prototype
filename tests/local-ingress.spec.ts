import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { localActor, listenLocalIngress, localSocketPath, processLocalRequest } from '../src/sources/local-ingress.ts'
import { localTrigger } from '../src/sources/local-trigger.ts'

const dirs: string[] = []
const home = () => { const path = mkdtempSync(join(tmpdir(), 'local-ingress-')); dirs.push(path); return path }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

function host(dir: string, enabled = true, allow = true) {
  const triggers = new Map<string, ReturnType<typeof localTrigger>>()
  const receive = vi.fn(async (trigger: ReturnType<typeof localTrigger>) => {
    triggers.set(trigger.id, trigger)
    return 'stored' as const
  })
  return {
    stateDir: dir,
    source: { config: () => enabled ? { acceptPrompts: true } : undefined, receive,
      triggers: { get: (id: string) => triggers.get(id) } },
    allowedActor: (actor: string) => allow && actor === localActor(),
    receive, triggers,
  }
}
const request = (body = 'Investigate synthetic failure') => ({
  kind: 'submit', eventId: 'e1', investigationId: 'i1', text: body,
  evidence: [{ label: 'synthetic.log', base64: Buffer.from('INVALID_CONFIG').toString('base64') }],
})

describe('authenticated local ingress boundary', () => {
  it('rejects disabled or unlisted actors before persisting evidence', async () => {
    for (const [enabled, allow] of [[false, true], [true, false]] as const) {
      const dir = home(), h = host(dir, enabled, allow)
      const result = await processLocalRequest(h, request())
      expect(result.ok).toBe(false)
      expect(h.receive).not.toHaveBeenCalled()
    }
  })
  it('maps authenticated input and stores only checksum references', async () => {
    const dir = home(), h = host(dir)
    const result = await processLocalRequest(h, request())
    expect(result).toMatchObject({ ok: true, status: 'stored', investigationId: 'i1' })
    const stored = [...h.triggers.values()][0]!
    expect(stored.meta.evidence).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain('INVALID_CONFIG')
    const digest = createHash('sha256').update('INVALID_CONFIG').digest('hex')
    expect(readFileSync(join(dir, 'local-evidence', digest), 'utf8')).toBe('INVALID_CONFIG')
    expect(statSync(join(dir, 'local-evidence', digest)).mode & 0o077).toBe(0)
    expect(await processLocalRequest(h, request())).toMatchObject({ status: 'duplicate' })
    expect(h.receive).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed input without calling the Engine', async () => {
    const h = host(home())
    await expect(processLocalRequest(h, { ...request(), evidence: [{ label: '../unsafe', base64: 'YQ==' }] })).rejects.toThrow()
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('creates a private socket and removes it on shutdown', async () => {
    const dir = home(), h = host(dir)
    const stop = await listenLocalIngress(h)
    expect(statSync(localSocketPath(dir)).mode & 0o077).toBe(0)
    await stop()
    expect(() => statSync(localSocketPath(dir))).toThrow()
  })
})
