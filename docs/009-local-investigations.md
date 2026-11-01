# Local investigation intake and read-only worker

This branch explores adapting dsh-superagent for an engineer who works from **prompts plus evidence** (logs, stack traces, test failures), not GitHub Issues.

## Design target

`Codex/Pi → authenticated local CLI/MCP bridge → Local Source → Engine.receive → Policy → Eval → Ticket → Executor`.

Initial executor can remain DSH; a Codex/Pi executor adapter is a separate phase. Preserve GitHub and Feishu sources and all authorization checks.

## Initial code (included)

`src/sources/local-trigger.ts` is a **pure mapper only**. It creates stable Trigger IDs and Thread identities and records **metadata-only** evidence references. `tests/local-trigger.spec.ts` covers deterministic mapping, follow-up correlation and input validation.

**This does not yet accept prompts, create tickets, store evidence files, or run an executor.** It must not be advertised as a working CLI/MCP integration.

## Phase 2: local Source registration

The optional `local-watch` plugin now registers `SourceKind` with the existing SourceRegistry, but stays **disabled in the bundle**. Even when explicitly installed, its `acceptPrompts` setting defaults to false and its Source-specific Policy requires an allowlisted actor. No API, CLI or socket ingress exists yet. An actor ID sent by a future caller must be independently authenticated; enabling a switch is not proof of identity.

This is intentionally **not a working investigation integration**. There is no evidence payload store, no local ticket creation transport, and no Codex/Pi executor. The existing GitHub and Feishu sources are untouched.

## Phase 3: experimental local intake

An owner-only Unix socket and minimal client now exist, but the optional plugin remains disabled in `cordis.patch.yml`, and the Source config also defaults to not accepting prompts. In your DSH deployment, only after reviewing security and explicitly enabling the plugin, configure Local Source `acceptPrompts` and allowlist `uid-<your numeric OS UID>`. Its filesystem socket is `<stateDir>/local.sock` and evidence files are under `<stateDir>/local-evidence` (outside this repository). Socket and stored evidence permissions are owner-only. Never submit sensitive production logs; evidence is stored privately, but model/tool exposure and retention controls need additional work.

Example commands:

```sh
node scripts/sa.mjs status --state-dir /absolute/path/to/state
node scripts/sa.mjs investigate --state-dir /absolute/path/to/state --prompt 'Inspect synthetic error' --evidence synthetic.log
node scripts/sa.mjs followup --state-dir /absolute/path/to/state --id <investigationId> --prompt 'New information'
```

The CLI returns a Trigger ID and investigation ID, **not an immediately created Ticket ID**. The existing asynchronous Eval and authorization pipeline still decides whether to create a ticket. The executor is still DSH and may have permissions unrelated to the CLI's scope; this phase is not a verified end-to-end read-only execution environment. A future revision must bind a verified read-only executor and enable safe evidence reads before production usage.

## Phase 4: lifecycle verification and evidence integrity

`tests/local-lifecycle.spec.ts` tests actual local intake against the real Engine, Policy, SourceRegistry and SQLite Store, using a **simulated assessor and executor**. It checks explicit authorization, ticket creation, follow-up input delivery, duplicate rejection, and the persisted ticket and evidence after reopening SQLite.

`readLocalEvidence(stateDir, sha256)` provides a hash-verified, bounded, no-follow, in-process evidence read primitive. **It is not exposed to agents or the local socket**. Never pass arbitrary evidence paths to an agent, and do not treat this test as proof that the live DSH executor is read-only.

Run `pnpm check` locally before merging. The next step after this baseline is an authorized evidence-reader tool and a sandboxed read-only investigation executor, then full DSH runtime smoke tests.

## Phase 5: opt-in ticket-scoped evidence reader (experimental)

`orchestrator_read` now accepts `local/<trigger-id>/evidence/<sha256>` **only from a worker ticket that can reach that local Trigger** and only while the Local Source is enabled with `acceptPrompts: true` and `allowEvidenceRead: true`. The evidence checksum must appear in that specific Trigger metadata. The reader rejects non-text evidence and uses the integrity-checked blob reader. `allowEvidenceRead` defaults to false. Evidence is not available to the unscoped main Session through this resource.

Local-origin Tickets now use a separate capability mode: only ticket-scoped resource reads and structured reports are registered, inherited tools are masked, and a monotonic execution guard rejects shell, writes, network tools and delegation. DSH's `read-only` permission preset is required and verified; if unavailable, local execution fails closed. The normal DSH Executor still runs non-local Tickets unchanged. Reports live on the existing Ticket Assignments. This is an application-tool boundary, not an OS sandbox for a compromised host or provider. Never submit production secrets without reviewing the runtime deployment and data retention policy. Synthetic tests do not constitute a live DSH end-to-end run.

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
