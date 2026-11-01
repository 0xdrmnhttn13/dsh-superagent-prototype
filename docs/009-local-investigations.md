# Local investigation intake: implementation plan

This branch explores adapting dsh-superagent for an engineer who works from **prompts plus evidence** (logs, stack traces, test failures), not GitHub Issues.

## Design target

`Codex/Pi → authenticated local CLI/MCP bridge → Local Source → Engine.receive → Policy → Eval → Ticket → Executor`.

Initial executor can remain DSH; a Codex/Pi executor adapter is a separate phase. Preserve GitHub and Feishu sources and all authorization checks.

## Initial code (included)

`src/sources/local-trigger.ts` is a **pure mapper only**. It creates stable Trigger IDs and Thread identities and records **metadata-only** evidence references. `tests/local-trigger.spec.ts` covers deterministic mapping, follow-up correlation and input validation.

**This does not yet accept prompts, create tickets, store evidence files, or run an executor.** It must not be advertised as a working CLI/MCP integration.

## Remaining implementation steps

1. Implement a `SourceKind` for `local` and register it through the existing SourceRegistry. Scope and Policy must only admit explicitly authenticated local requests; never trust actor IDs submitted over HTTP.
2. Create a **local-only authenticated** ingress with request size limits, nonce/idempotency protection, and explicitly assigned actor identity. Consider Unix domain sockets instead of network endpoints. Call `SourceContext.receive` rather than constructing tickets directly.
3. Implement a private evidence store under the configured stateDir, outside this public Git repository: safe file copying, SHA-256 checks, file size limits, redaction, and tightly scoped reads. Never put raw logs or absolute secret paths in Trigger text.
4. Provide commands for creating an investigation, sending follow-ups with the same `investigationId`, showing history, and resuming a ticket through the Engine.
5. Exercise the full authorization, restart/replay, assessment, ticket, read-only worker, and follow-up flow using synthetic logs. Keep writes disabled by default. Run `pnpm check`.

## Example future CLI (not implemented)

```sh
sa investigate --prompt 'Inspect Redpanda INVALID_CONFIG; read only' --evidence synthetic.log
sa evidence add inv-123 synthetic-followup.log
sa show inv-123
```

Do not test with confidential production trading logs. Do not assume `addressed: direct` alone grants authorization; the ingress and source policy must enforce who can submit work.
