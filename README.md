# Superagent Investigator

A standalone, local engineering investigation agent. The Superagent domain Engine owns persistent Triggers, Threads, Policy, Mandates, Tickets, Assignments and reports in SQLite; [Pi Coding Agent](https://pi.dev/) supplies model reasoning. No DeepSeek Harness server, profile, executable, or Cordis plugin is required.

> Research prototype, not an OS sandbox. Submit synthetic or approved data only. A configured Pi model receives investigation text and any evidence the investigator reads.

## Requirements

Node.js 22.19+ or 24+, pnpm 11.7+, a supported Pi model with existing authentication (for example `pi` → `/login` → `/model`). The service uses Pi's installed `~/.pi/agent/auth.json` and model catalog. No additional paid provider or DeepSeek key is needed.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm link --global                       # optional: installs `sa`; alternatively use `node scripts/sa.mjs`
sa start --state-dir "$HOME/.superagent"
sa status --state-dir "$HOME/.superagent"
printf '2026-01-01 synthetic INVALID_CONFIG: broker rejected topic\n' > /tmp/sa-synthetic.log
sa investigate --state-dir "$HOME/.superagent" --prompt 'Investigate this synthetic configuration failure' --evidence /tmp/sa-synthetic.log
sa show --state-dir "$HOME/.superagent" --id <investigation-id>
sa followup --state-dir "$HOME/.superagent" --id <investigation-id> --prompt 'Broker rejected the topic configuration'
sa stop --state-dir "$HOME/.superagent"
```

`sa investigate` returns an investigation ID and Trigger ID. `sa show` lists the Ticket, Assignment and validated findings; the model turn is asynchronous, so query again until `latestReport` becomes `waiting` (findings) or `failed`. Reuse the investigation ID for follow-ups. Set `SA_STATE_DIR` to avoid repeating `--state-dir` (default: `~/.superagent`). Evidence must be UTF-8 text, at most 64 KiB per file; the socket accepts at most four items per submission (the CLI currently accepts one `--evidence` file). State is private to the local OS account (directory `0700`, socket and evidence `0600`). Back up the state directory before migrating an existing SQLite database; schema 10→11 is handled by the existing transactional migration, and existing schema 11 records remain intact. On a pre-existing configuration, Superagent does **not** enable local intake or add your UID to Policy automatically; use a new state directory or explicitly configure the stored local Source and Policy. Do not reuse an existing state directory concurrently with another process.

## From inside Pi (opt-in)

After building, load this repository's extension for a one-off test with `pi --extension ./src/standalone/extension.ts` from the repo. Keep the daemon running (`node scripts/sa.mjs start`), and use the same `SA_STATE_DIR` in Pi and the daemon (default `~/.superagent`). For repeated use, `pi install .` adds the local package to your Pi settings; this is **optional** and should be done only after reviewing the extension. Restart Pi after installing. This does not auto-start the daemon or modify existing Tickets.

- `/ticket <goal>` proposes a Ticket and displays a confirmation; **no Ticket is submitted on decline**. `/tickets` shows Tickets bound to your current Pi session.
- `/task <ticket-id> <title>` proposes a task on that Ticket; `/board <ticket-id>` shows tasks and discussion; `/discuss <ticket-id> <message>` posts an owner message after confirmation.
- `/approve-agent <ticket-id> <agent-id>` approves one local subagent for that Ticket; `/claim-task <ticket-id> <task-id> <agent-id>` assigns an open task; `/run-agent <ticket-id> <task-id> <agent-id>` runs one agent turn with confirmation. The subagent has only `sa_agent_reply`, not coding/shell/file/network tools. A completed turn cannot be replayed automatically.
- `/approve-external <ticket-id> <agent-id> <https-url> <TOKEN_ENV>` approves an outbound HTTPS endpoint. Set the **same** 32+-character token in the Pi and daemon processes' environments before approval. The endpoint receives `{version:1,ticketId,taskId,context}` via POST with `Authorization: Bearer <token>` and must return JSON `{message:string,done:boolean}`. Redirects and private-address destinations are refused. Do not use real data until you trust the endpoint and its operator.

The local Unix socket is owner-only; a second program running under the **same OS account** can still call it. UI confirmations protect the Pi command workflow, **not all same-user processes**. Local agent messages and tasks are persisted in a Ticket-scoped board separate from Engine's Assignment lifecycle; the Engine-approved Ticket remains the authorization root. This is bounded single-turn collaboration, **not autonomous task planning or an OS security boundary**. An ambiguous agent turn fails closed: create a fresh owner-approved task to try again.

## Architecture

```text
sa CLI → owner-only Unix socket → local Trigger → Policy gate → Engine.receive/decide
                                                     │
                                                     ├→ SQLite (Ticket, Thread, Mandate, Assignment)
                                                     └→ PiExecutor → restricted Pi AgentSession
                                                            ├→ authorized ticket context
                                                            ├→ ticket-scoped SHA-256 evidence read
                                                            └→ schema-validated findings → Engine.report → SQLite
```

SQLite Tickets are authoritative; each Ticket's Pi JSONL session path is supplemental and stored in SQLite. Follow-ups reuse the Ticket and previous findings. A durable turn marker fails closed on ambiguous interrupted runs; retry is a domain operation, never a blind duplicate model execution. An error leaves the Ticket inspectable with a `failed` report. A failed Assignment needs an explicit trusted in-process `Engine.retryTicket(ticketId)`; a follow-up alone will not rerun it. The local socket does not expose retry or arbitrary Ticket mutation.

## Security and limitations

The investigator has **application-level tool restrictions**, not OS isolation: only `sa_context`, `sa_evidence`, and `sa_report` are registered. The SDK resource loader disables discovery of project/global extensions, skills, context files and prompt templates. Built-in shell, file, write, network, MCP and delegation tools are not available. Evidence is digest-checked and only readable by an authorized Ticket reachable from its Trigger while evidence reading is enabled. Findings are validated before domain reporting. Evidence and prompts are untrusted inputs, and a compromised provider or process is outside this boundary. Pi authentication/model selection may invoke configured credential helpers or provider network access outside the investigator tool boundary. No source-code workspace reader, OS sandbox, secret redaction, evidence-retention/erasure policy, or remote channel UI is provided.

See [migration audit and engineering risks](docs/010-standalone-migration.md). Run `pnpm check` for deterministic tests, build and dependency audit. To run a live synthetic smoke test, use the commands above with an authenticated Pi model and check `sa show` until a validated report appears.

[MIT](LICENSE)
