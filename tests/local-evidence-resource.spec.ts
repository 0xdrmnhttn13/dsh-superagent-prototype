import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { localActor, processLocalRequest } from '../src/sources/local-ingress.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const settings = (allowEvidenceRead: boolean) => SettingsSchema.parse({
  sources: { local: { enabled: true, config: { acceptPrompts: true, allowEvidenceRead } } },
  policy: { sources: { local: { allowed: [{ id: localActor() }] } } },
})

describe('local evidence resources', () => {
  it('requires an originating, reachable local trigger, exact attached digest, and explicit opt-in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-evidence-read-'))
    dirs.push(dir)
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    store.saveSettings(settings(true))
    const contents = 'synthetic INVALID_CONFIG\\nONLY_IN_FILE'
    const response = await processLocalRequest({
      stateDir: dir,
      source: {
        config: () => ({ acceptPrompts: true }),
        receive: (trigger: Trigger) => { store.triggers.save(trigger); return 'stored' as const },
        triggers: { get: (id: string) => store.triggers.get(id) },
      },
      allowedActor: actor => actor === localActor(),
    }, {
      kind: 'submit', eventId: 'event-a', investigationId: 'inv-a', text: 'Inspect INVALID_CONFIG',
      evidence: [{ label: 'synthetic.log', base64: Buffer.from(contents).toString('base64') }],
    })
    expect(response.ok).toBe(true)
    const triggerId = String(response.triggerId)
    const digest = createHash('sha256').update(contents).digest('hex')
    const ticket: Ticket = {
      id: 'ticket-a', title: 'Inspect config', decisionId: 'decision-a',
      mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'local', id: localActor() }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: '', updatedAt: '', origin: { triggerId, triggerIds: [triggerId] },
    }
    store.tickets.save(ticket)
    store.tickets.save({ ...ticket, id: 'ticket-b', origin: { triggerId: 'unrelated', triggerIds: [] } })
    const host = { store, stateDir: dir, masterId: 'main' } as unknown as ResourceHost
    const resource = `local/${triggerId}/evidence/${digest}`
    const allowed = await readResource(host, resource, 0, 8000, 'ticket-a') as { text: string }
    expect(allowed.text).toContain('ONLY_IN_FILE')
    await expect(readResource(host, resource, 0, 8000, 'ticket-b')).rejects.toThrow()
    await expect(readResource(host, resource, 0, 8000)).rejects.toThrow('worker ticket')
    await expect(readResource(host, `local/${triggerId}/evidence/${'0'.repeat(64)}`, 0, 8000, 'ticket-a'))
      .rejects.toThrow('not attached')
    store.saveSettings(settings(false))
    await expect(readResource(host, resource, 0, 8000, 'ticket-a')).rejects.toThrow('disabled')
    store.close()
  })
})
