#!/usr/bin/env node
import { config } from "./config.js";
import { safe } from "./display.js";
import { demoTools } from "./demo-tools.js";
import { ApprovalGate, GateError } from "./gate.js";
import { openDatabase, type RequestRow } from "./store.js";

const USAGE = `approval-gate <command>

  list [status]            requests, newest last (default: pending)
  show <id>                full arguments and history of one request
  approve <id> [note]      approve; the MCP server runs it on its next poll
  reject <id> <reason>     reject; the agent sees the reason
  audit                    print the audit log as JSON lines
  verify                   check the audit hash chain

env: APPROVAL_GATE_DB, APPROVAL_GATE_APPROVER`;

const gate = new ApprovalGate(openDatabase(config.dbPath), demoTools(config.outboxPath));
const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "list": {
      const rows = gate.listRequests(rest[0] === "all" ? undefined : (rest[0] ?? "pending"));
      if (rows.length === 0) console.log("nothing here");
      for (const r of rows) console.log(summary(r));
      break;
    }
    case "show": {
      const row = gate.getRequest(need(rest[0], "id"));
      console.log(summary(row));
      console.log(`reason:  ${safe(row.reason)}`);
      console.log(`args:    ${safe(JSON.stringify(JSON.parse(row.args_json), null, 2))}`);
      if (row.decision_note) console.log(`note:    ${safe(row.decision_note)}`);
      if (row.result_json) console.log(`result:  ${safe(row.result_json)}`);
      if (row.error) console.log(`error:   ${safe(row.error)}`);
      for (const a of gate.auditLog().filter((e) => e.request_id === row.id)) {
        console.log(`  ${new Date(a.at).toISOString()}  ${a.event.padEnd(9)} ${safe(a.actor)}`);
      }
      break;
    }
    case "approve": {
      const row = gate.approve(need(rest[0], "id"), config.approver(), rest.slice(1).join(" "));
      console.log(`approved ${row.id}; the server will run it on its next poll`);
      break;
    }
    case "reject": {
      const row = gate.reject(need(rest[0], "id"), config.approver(), rest.slice(1).join(" "));
      console.log(`rejected ${row.id}`);
      break;
    }
    case "audit":
      for (const e of gate.auditLog()) console.log(safe(JSON.stringify(e)));
      break;
    case "verify": {
      const v = gate.verifyAudit();
      if (v.ok) console.log(`audit chain ok: ${v.entries} entries, head ${v.head}`);
      else {
        console.error(`audit chain BROKEN at entry ${v.brokenAt}`);
        process.exitCode = 2;
      }
      break;
    }
    default:
      console.log(USAGE);
      if (command && command !== "help") process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof GateError ? safe(err.message) : err);
  process.exitCode = 1;
}

function summary(r: RequestRow): string {
  return `${r.id}  ${r.status.padEnd(9)} ${r.tool.padEnd(14)} by ${safe(r.requested_by)}  ${new Date(r.created_at).toISOString()}`;
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new GateError(`missing <${name}>\n\n${USAGE}`);
  return value;
}
