import { describe, expect, it } from 'vitest'
import { localTrigger } from '../src/sources/local-trigger.ts'

const evidence = { id: 'log-a', sha256: 'a'.repeat(64), label: 'Synthetic Redpanda error' }
const base = {
  id: 'evt-1',
  investigationId: 'inv-123',
  actor: 'local-owner',
  at: '2026-11-01T09:00:00Z',
  text: 'Investigate producer INVALID_CONFIG (read-only)',
  evidence: [evidence],
}

describe('local investigation trigger mapping', () => {
  it('is deterministic and retains only evidence references', () => {
    const first = localTrigger(base)
    expect(localTrigger(base)).toEqual(first)
    expect(first).toMatchObject({
      source: 'local',
      threads: [{ source: 'local', id: 'inv-123' }],
      actor: { source: 'local', id: 'local-owner' },
      addressed: 'direct',
      meta: { investigationId: 'inv-123', evidence: [evidence] },
    })
    expect(first.text).toBe(base.text)
    expect(JSON.stringify(first)).not.toContain('/var/log/')
  })

  it('maps a follow-up to the same thread but a new trigger', () => {
    const first = localTrigger(base)
    const followup = localTrigger({ ...base, id: 'evt-2', text: 'Another synthetic log', evidence: [] })
    expect(first.id).not.toBe(followup.id)
    expect(first.threads).toEqual(followup.threads)
  })

  it('rejects malformed IDs, unvalidated metadata, and excessive evidence', () => {
    expect(() => localTrigger({ ...base, investigationId: '../secrets' })).toThrow()
    expect(() => localTrigger({ ...base, text: '' })).toThrow()
    expect(() => localTrigger({ ...base, evidence: [{ ...evidence, sha256: '123' }] })).toThrow()
    expect(() => localTrigger({ ...base, evidence: Array(17).fill(evidence) })).toThrow()
    expect(() => localTrigger({ ...base, arbitrary: 'ignored?' } as never)).toThrow()
  })
})
