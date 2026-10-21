# mcp-approval-gate

An MCP server that lets an agent ask for irreversible actions (send an email, issue a refund, publish a post) without letting it perform them. The call is held in a queue until a person approves it from a separate terminal. Every step is written to an audit log whose entries are hash-chained, so editing or deleting history is detectable.

```
agent  -> issue_refund({ invoice_id: "INV-1001", amount_cents: 129900, reason: "..." })
       <- { "status": "pending", "id": "req_59fe7a681cd2", "expiresAt": "..." }

human$ approval-gate show req_59fe7a681cd2
human$ approval-gate approve req_59fe7a681cd2 "matches the ticket"

agent  -> get_request_status({ id: "req_59fe7a681cd2" })
       <- { "status": "executed", "result": { ... }, "decided_by": "human:khalid" }
```

## The problem

Agents are good at deciding what should happen and unreliable at knowing when they are wrong. For reads that is fine. For actions that cannot be undone it is not: a hallucinated invoice id or a misread thread turns into a refund to the wrong customer or an email that cannot be unsent.

The usual fixes are a confirmation prompt inside the chat (the model can talk past it, and nobody else sees it) or not giving the agent the tool at all (then it is not much of an agent). This server sits in between. The agent keeps the tool, the tool returns a ticket instead of acting, and a human decides on a channel the model cannot reach.

I run the same pattern in production for ad campaigns (created paused, a person turns them on) and for deploys. This repo is a small, self-contained version of it.

## How it works

- Each tool declares whether it is read-only. Read-only tools run straight through. **Everything else is held**, including tools that forgot to declare anything. Failing closed costs a click; failing open can cost a refund.
- A held call is validated against the tool's schema, stored with a SHA-256 of its canonical arguments, and returned to the agent as `pending` with an id and an expiry time.
- Gated tools get a required `reason` field. The approver reads it before deciding, and it ends up in the audit log.
- The MCP surface has **no approve or reject tool**. Approval only happens through the CLI, which talks to the same SQLite file.
- The server polls for approved requests and runs each one once, then the agent can read the result through `get_request_status`.

### Request lifecycle

```
pending --approve--> approved --claim--> executing --> executed
   |                                          \-----> failed
   |--reject--> rejected
   \--ttl-----> expired
```

## Run it

Requires Node 22.13 or newer (uses the built-in `node:sqlite`).

```bash
npm install
npm test          # unit, MCP protocol and end-to-end tests
npm run build
```

Register it with an MCP client. For Claude Code:

```bash
claude mcp add approval-gate --env APPROVAL_GATE_DB=$HOME/.approval-gate.db -- node /path/to/mcp-approval-gate/dist/server.js
```

Then, in another terminal, using the same database:

```bash
export APPROVAL_GATE_DB=$HOME/.approval-gate.db
node dist/cli.js list            # pending requests
node dist/cli.js show <id>       # full arguments, reason, history
node dist/cli.js approve <id> "optional note"
node dist/cli.js reject <id> "reason the agent will see"
node dist/cli.js verify          # check the audit hash chain
node dist/cli.js audit           # dump the log as JSON lines
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `APPROVAL_GATE_DB` | `approval-gate.db` | SQLite file shared by server and CLI |
| `APPROVAL_GATE_OUTBOX` | `outbox.jsonl` | where the demo tools write their side effects |
| `APPROVAL_GATE_TTL_SECONDS` | `3600` | how long a request waits for a decision |
| `APPROVAL_GATE_POLL_MS` | `1000` | how often the server looks for approved work |
| `APPROVAL_GATE_APPROVER` | OS user name | name recorded as the approver |

The bundled tools (`list_invoices`, `send_email`, `issue_refund`) are stubs that append to an outbox file, so you can watch exactly when an action happens. To gate real integrations, replace `src/demo-tools.ts` with your own `ToolDefinition`s.

## Design decisions

**Deny by default.** The gate trusts the `readOnly` flag and nothing else. MCP's `destructiveHint` annotation is set on the way out so clients can render it, but it is not used to decide, because hints are advisory and easy to leave unset.

**Approval on a different channel.** If the model could call `approve`, a prompt injection in an email body could call it too. Keeping approval out of the MCP surface entirely is simpler than trying to authenticate the human inside the conversation. Self-approval is also refused at the data layer: the approver name must differ from the requester.

**The human approves exact arguments.** Arguments are canonicalized (sorted keys) and hashed when the request is created, and that hash is written into the audit chain. Before running, the executor recomputes the hash from the stored arguments and compares it to the audited one. If someone edits the queue between approval and execution, the request fails instead of running something nobody saw. There is a test for this.

**At-most-once, on purpose.** The transition from `approved` to `executing` is a compare-and-set inside a SQLite transaction, so two executors cannot both claim a request (also tested). If the process dies mid-call, the request stays in `executing` and is not retried. For irreversible actions a missed send is recoverable by a person; a double refund is harder. Exactly-once would need idempotency keys on the downstream API, which is the right next step when the target supports them.

**The approver's screen is part of the attack surface.** Everything the CLI prints about a request (the reason, the arguments, the client name) was written by the agent, which may have read a malicious email. Terminal escape codes and bidi control characters are printed escaped, so a reason cannot erase lines or make `$10000` read as `$10` on the approver's screen.

**Duplicates collapse.** Agents retry. A second call with the same tool and the same arguments, while the first is still pending, returns the first request id instead of queueing another email.

**Requests expire.** An approval given three days later, about a situation that has changed, is worse than no approval. Pending requests expire after a TTL and can no longer be approved.

**SQLite for both queue and log.** The server and the CLI are separate processes. WAL mode plus `BEGIN IMMEDIATE` gives cross-process locking without inventing a lock file, and appending to the audit chain inside the same transaction as the state change means the chain cannot fork.

**Tamper-evident, not tamper-proof.** Each audit entry stores the previous entry's hash. Changing, deleting or reordering a row breaks verification from that point on. Someone with write access to the file can still rebuild the whole chain, so in a real deployment the head hash (`approval-gate verify` prints it) should be shipped periodically somewhere the agent host cannot write to.

## Tests

`npm test` runs 25 tests in four layers:

- `test/gate.test.ts`: the state machine, expiry, duplicates, schema validation, failure without retry, argument tampering, two executors racing for one request, and audit chain verification after edits and deletions.
- `test/mcp.test.ts`: the MCP surface through the official SDK client over an in-memory transport. Checks that no approve tool exists, that gated tools require a reason, and the pending to executed round trip.
- `test/display.test.ts`: escape codes, carriage returns and bidi overrides in agent text are shown escaped, not interpreted.
- `test/e2e.test.ts`: starts the real server over stdio and the real CLI as separate processes, sends an email request, confirms nothing reached the outbox, approves from the CLI, and checks that exactly one email went out and the audit chain verifies.

## Not included

Authentication for the CLI (it trusts whoever can open the database file), notifications to the approver (Slack, email), multi-party approval, and per-tool policies such as "refunds under $50 run without approval". Each is a small addition on top of the same queue.

## License

MIT
