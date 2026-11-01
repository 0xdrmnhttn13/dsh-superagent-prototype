/** Local investigation Source policy and plugin registration.
 * This module does not expose an ingress or authorize a request by itself.
 */

import { z } from 'zod'
import type { SourceKind } from './kind.ts'
import { LOCAL_SOURCE } from './local-trigger.ts'


export const LocalConfigSchema = z.object({
  acceptPrompts: z.boolean().default(false),
  allowEvidenceRead: z.boolean().default(false),
}).strict()
export type LocalConfig = z.infer<typeof LocalConfigSchema>

/** A local source with explicit opt-in and allowlisted actor IDs.
 * A future ingress must authenticate the caller and assign its actor identity.
 */
export const localKind: SourceKind<LocalConfig> = {
  kind: LOCAL_SOURCE,
  title: { zh: '本地调查', en: 'Local investigations' },
  description: { zh: '本地提示词来源；尚无输入接口，默认关闭。', en: 'Local prompt source; no ingress is installed, and intake is off by default.' },
  schema: LocalConfigSchema,
  fields: [{ key: 'acceptPrompts', type: 'switch',
    label: { zh: '接收本地调查请求', en: 'Accept local investigation requests' } },
    { key: 'allowEvidenceRead', type: 'switch',
      label: { zh: '允许工单读取本地证据', en: 'Allow ticket-scoped evidence reads' },
      hint: { zh: '仅供实验；DSH 执行器尚未具备只读隔离。', en: 'Experimental only. The DSH executor is not yet isolated as read-only.' } }],
  health: [],
  scope: ({ meta }, config) => config.acceptPrompts && typeof meta.investigationId === 'string'
    ? { listened: true, observed: false, row: 'prompt' }
    : { listened: false, reason: 'local_intake_disabled' },
  find: query => {
    const id = /^(?:local:)?([a-zA-Z0-9_-]{1,100})$/.exec(query.trim())?.[1]
    return { threads: id ? [`local:${id}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '授权本地身份', en: 'Authorized local identities' },
      columns: [{ key: 'id', type: 'text', label: { zh: '身份', en: 'Identity' }, pattern: '[a-zA-Z0-9_-]+' }] }],
    explicit: { zh: '认证且在允许名单内的本地用户直接发出请求。', en: 'An authenticated, allowlisted local user submits a direct request.' },
    rows: () => [{ id: 'prompt', label: { zh: '本地提示词', en: 'Local prompts' },
      note: { zh: '仅明确请求', en: 'Explicit requests only' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
  },
}

export const name = 'superagent-local'

