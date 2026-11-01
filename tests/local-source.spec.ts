import { describe, expect, it } from 'vitest'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { localKind } from '../src/sources/local.ts'
import { localTrigger } from '../src/sources/local-trigger.ts'

const event = {
  id: 'evt-1', investigationId: 'inv-123', actor: 'owner',
  at: '2026-11-01T09:00:00Z', text: 'Inspect a synthetic error, read only',
}
function setup(acceptPrompts: boolean, allowed: string[]) {
  const settings = SettingsSchema.parse({
    sources: { local: { enabled: true, config: { acceptPrompts } } },
    policy: { sources: { local: { allowed: allowed.map(id => ({ id })) } } },
  })
  const sources = new SourceRegistry(() => settings)
  sources.register(localKind)
  return { sources, gate: settingsPolicy(settings, sources) }
}

describe('local Source registration and gate', () => {
  it('defaults to no intake even when the plugin is registered', () => {
    const settings = SettingsSchema.parse({})
    const sources = new SourceRegistry(() => settings)
    sources.register(localKind)
    expect(sources.instance('local')?.config).toEqual({ acceptPrompts: false })
    expect(sources.scope(localTrigger(event))).toMatchObject({ listened: false })
  })
  it('listens only when explicitly enabled', () => {
    const trigger = localTrigger(event)
    expect(setup(false, ['owner']).sources.scope(trigger)).toMatchObject({ listened: false })
    expect(setup(true, ['owner']).sources.scope(trigger)).toEqual({ listened: true, observed: false, row: 'prompt' })
  })
  it('only grants explicit work to allowlisted actors', () => {
    const trigger = localTrigger(event)
    const { gate } = setup(true, ['owner'])
    const thread = { key: 'local:inv-123', ref: trigger.threads[0]!, createdAt: '',
      subscriptions: [], correlated: [], pending: [], meta: {} }
    expect(gate.gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
    expect(setup(true, []).gate.gate(trigger, thread, [])).toMatchObject({ admissible: false })
    expect(setup(false, ['owner']).gate.gate(trigger, thread, [])).toMatchObject({ admissible: false })
  })
  it('cannot grant work on actor identity alone without authentication by the future ingress', () => {
    expect(localKind.channel).toBeUndefined()
    expect(localKind.scope!({ meta: { investigationId: '../bad' } }, { acceptPrompts: false }).listened).toBe(false)
  })
})
