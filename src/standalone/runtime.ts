import { join } from 'node:path'
import { Engine, type Candidate, type Trigger } from '../core/index.ts'
import { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import { settingsPolicy, type Settings } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { localKind } from '../sources/local.ts'
import { localActor, listenLocalIngress, type IngressHost } from '../sources/local-ingress.ts'
import { PiExecutor, type SessionFactory } from './pi.ts'
import { Collaboration } from './collaboration.ts'
import { runAgent, localAgent, externalAgent, type AgentRunner } from './agents.ts'
import { PresenceManager } from './presence.ts'

export interface RuntimeOptions { stateDir: string; sessionFactory?: SessionFactory; agentRunner?: AgentRunner; allowActor?: boolean; evidence?: boolean }

export class LocalRuntime {
  readonly store: Store
  readonly sources: SourceRegistry
  readonly engine: Engine
  readonly executor: PiExecutor
  readonly collaboration: Collaboration
  readonly presence: PresenceManager
  private stopIngress?: () => Promise<void>
  private timer?: ReturnType<typeof setInterval>
  readonly host: IngressHost
  constructor(private readonly options: RuntimeOptions) {
    this.store = new Store(join(options.stateDir, 'orchestrator.sqlite'))
    if (!this.store.get('standalone:initialized')) {
      const current = this.store.settings()
      const actor = localActor()
      // Never silently broaden a pre-existing Policy or override a disabled Source.
      const configured = this.store.get(KV.settings.revision) !== undefined
      if (configured) {
        this.store.set('standalone:initialized', true)
      } else {
        const settings: Settings = { ...current,
          policy: { ...current.policy, sources: { ...current.policy.sources, local: { admission: {}, allowed: options.allowActor === false ? [] : [{ id: actor }] } } },
          sources: { ...current.sources, local: { enabled: true,
            config: { acceptPrompts: true, allowEvidenceRead: options.evidence !== false } } },
        }
        this.store.saveSettings(settings)
        this.store.set('standalone:initialized', true)
      }
    }
    this.sources = new SourceRegistry(() => this.store.settings())
    this.sources.register(localKind)
    this.executor = new PiExecutor(this.store, options.stateDir, options.sessionFactory)
    this.collaboration = new Collaboration(this.store)
    this.presence = new PresenceManager(this.store, this.collaboration,
      (ticketId, taskId, agentId, signal) => this.runAgent(ticketId, taskId, agentId, signal))
    this.engine = new Engine({ repo: this.store, scope: this.sources, policy: () => settingsPolicy(this.store.settings(), this.sources),
      assessor: { request: (candidate: Candidate) => { this.store.afterCommit(() => this.admit(candidate)) } },
      executor: { start: (ticket, assignment) => this.store.afterCommit(() => this.executor.start(ticket, assignment)),
        deliver: (ticket, assignment) => this.store.afterCommit(() => this.executor.deliver(ticket, assignment)),
        stop: (ticket, assignment, reason) => this.store.afterCommit(() => this.executor.stop(ticket, assignment, reason)) },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
    this.executor.bind(this.engine)
    this.host = { stateDir: options.stateDir,
      collaboration: {
        board: (ticketId: string) => this.collaboration.board(ticketId),
        act: (actor: string, action: unknown) => this.collaboration.act(actor, action),
        approve: (ticketId: string, agent: Parameters<Collaboration['approve']>[1], token?: string) => this.collaboration.approve(ticketId, agent, token),
        revoke: (ticketId: string, agentId: string) => this.collaboration.revoke(ticketId, agentId),
        registry: () => this.collaboration.registry(),
        claim: (ticketId: string, taskId: string, agentId: string) => this.collaboration.claim(ticketId, taskId, agentId),
        resolve: (ticketId: string, proposalId: string, approve: boolean) => this.collaboration.resolve(ticketId, proposalId, approve),
        presence: this.presence,
      },
      source: { config: kind => kind === 'local' ? this.sources.instance<{ acceptPrompts: boolean }>('local')?.config : undefined,
        receive: (trigger: Trigger) => { const result = this.engine.receive(trigger); this.engine.evaluateDue(); return result },
        threads: { get: key => this.store.threads.get(key) }, tickets: { get: id => this.store.tickets.get(id), list: () => this.store.tickets.list() },
        triggers: { get: id => this.store.triggers.get(id) } },
      allowedActor: actor => actor === localActor() && this.store.settings().policy.sources.local?.allowed.some(item => item.id === actor) === true }
  }
  private async runAgent(ticketId: string, taskId: string, agentId: string, signal?: AbortSignal) {
    const agent = this.collaboration.approved(ticketId, agentId)
    if (agent.kind === 'local') return runAgent(this.store, this.collaboration, ticketId, taskId, agentId, this.options.agentRunner ?? localAgent, signal)
    const token = process.env[agent.tokenEnv!]
    if (!token || token.length < 32) throw new Error('External agent token environment variable unavailable')
    // The token is never stored in plaintext or sent to the Pi model.
    this.collaboration.authorized(ticketId, agentId, token)
    return runAgent(this.store, this.collaboration, ticketId, taskId, agentId,
      externalAgent(agent.endpoint!, token), signal)
  }
  private admit(candidate: Candidate): void {
    const trigger = candidate.triggers.find(item => item.id === candidate.thread.evaluating?.primary) ?? candidate.triggers[0]
    if (!trigger) return
    const policy = settingsPolicy(this.store.settings(), this.sources)
    const gate = policy.gate(trigger, candidate.thread, candidate.tickets)
    const outcome = trigger.source === 'local' && trigger.human && gate.admissible && gate.strength === 'explicit'
      && trigger.actor.id === localActor() && trigger.meta.investigationId === candidate.thread.ref.id
      && this.store.settings().policy.sources.local?.allowed.some(item => item.id === trigger.actor.id)
      ? { kind: 'accept' as const, title: trigger.text.slice(0, 160), scope: 'Read-only local investigation', reason: 'Authorized explicit local request' }
      : { kind: 'ignore' as const, reason: 'Local investigation not authorized' }
    try { this.engine.decide(trigger.id, { ...outcome, evalId: candidate.evalId }) } catch (error) { console.error('Admission failed:', error) }
  }
  async start(): Promise<void> {
    try {
      this.stopIngress = await listenLocalIngress(this.host)
      this.engine.evaluateDue()
      this.executor.recover()
      this.timer = setInterval(() => this.engine.evaluateDue(), 1000)
    } catch (error) { await this.shutdown(); throw error }
  }
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.stopIngress) { const stop = this.stopIngress; this.stopIngress = undefined; await stop() }
    this.presence.pauseAll()
    await this.presence.drain()
    await this.executor.shutdown()
    this.store.close()
  }
}
