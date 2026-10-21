import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson, sha256 } from "./canonical.js";
import { inTransaction, type AuditRow, type RequestRow } from "./store.js";

export interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /**
   * Only tools that explicitly declare themselves read-only run straight
   * through. Everything else is held for approval. Forgetting the flag
   * costs a human click; the opposite mistake could cost a refund.
   */
  readOnly?: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface GateOptions {
  /** How long a request may wait for a decision. Default: 1 hour. */
  ttlMs?: number;
  now?: () => number;
}

export type SubmitResult =
  | { status: "pending"; id: string; expiresAt: string; duplicate: boolean }
  | { status: "executed"; result: unknown };

export class GateError extends Error {}

const GENESIS = "0".repeat(64);

export class ApprovalGate {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    tools: ToolDefinition[],
    options: GateOptions = {},
  ) {
    for (const tool of tools) this.tools.set(tool.name, tool);
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Entry point for the agent. Read-only tools run now. Anything else is
   * stored with a hash of its exact arguments and comes back as pending.
   * Re-submitting the same call while it is still pending returns the same
   * request instead of queueing a second email.
   */
  async submit(
    toolName: string,
    rawArgs: Record<string, unknown>,
    reason: string,
    requestedBy: string,
  ): Promise<SubmitResult> {
    const tool = this.requireTool(toolName);
    const args = z.object(tool.input).strict().parse(rawArgs) as Record<string, unknown>;

    if (tool.readOnly) {
      return { status: "executed", result: await tool.run(args) };
    }

    const argsJson = canonicalJson(args);
    const argsHash = sha256(`${tool.name}\n${argsJson}`);
    const at = this.now();

    return inTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          "SELECT id, expires_at FROM requests WHERE args_hash = ? AND status = 'pending' AND expires_at > ?",
        )
        .get(argsHash, at) as { id: string; expires_at: number } | undefined;
      if (existing) {
        return {
          status: "pending" as const,
          id: existing.id,
          expiresAt: new Date(existing.expires_at).toISOString(),
          duplicate: true,
        };
      }

      const id = `req_${randomBytes(6).toString("hex")}`;
      const expiresAt = at + this.ttlMs;
      this.db
        .prepare(
          `INSERT INTO requests (id, tool, args_json, args_hash, reason, requested_by, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, tool.name, argsJson, argsHash, reason, requestedBy, at, expiresAt);
      this.appendAudit(id, "requested", requestedBy, {
        tool: tool.name,
        args_hash: argsHash,
        reason,
        expires_at: expiresAt,
      });
      return {
        status: "pending" as const,
        id,
        expiresAt: new Date(expiresAt).toISOString(),
        duplicate: false,
      };
    });
  }

  approve(id: string, approver: string, note = ""): RequestRow {
    return this.decide(id, approver, "approved", note);
  }

  reject(id: string, approver: string, note: string): RequestRow {
    if (!note.trim()) throw new GateError("A rejection needs a reason the agent can read.");
    return this.decide(id, approver, "rejected", note);
  }

  private decide(
    id: string,
    approver: string,
    decision: "approved" | "rejected",
    note: string,
  ): RequestRow {
    // Errors are returned, not thrown, inside the transaction so that marking
    // an expired request is committed before we report it.
    const outcome = inTransaction(this.db, (): RequestRow | GateError => {
      const row = this.getRow(id);
      const at = this.now();
      if (row.status === "pending" && row.expires_at <= at) {
        this.markExpired(row, at);
        return new GateError(`${id} expired at ${new Date(row.expires_at).toISOString()}`);
      }
      if (row.status !== "pending") {
        return new GateError(`${id} is ${row.status}, only pending requests can be decided`);
      }
      if (approver === row.requested_by) {
        return new GateError("The requester cannot approve its own request.");
      }
      this.db
        .prepare(
          "UPDATE requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'",
        )
        .run(decision, approver, at, note, id);
      this.appendAudit(id, decision, approver, { note, args_hash: row.args_hash });
      return this.getRow(id);
    });
    if (outcome instanceof GateError) throw outcome;
    return outcome;
  }

  /**
   * Runs every approved request once. Safe to call from several processes:
   * the approved -> executing transition is a compare-and-set, so only one
   * caller wins each request. Delivery is at-most-once. If the process dies
   * mid-call the request stays in `executing` for a human to reconcile; we
   * never retry an irreversible action on our own.
   */
  async runApproved(): Promise<string[]> {
    this.expireStale();
    const ids = (
      this.db.prepare("SELECT id FROM requests WHERE status = 'approved' ORDER BY decided_at").all() as {
        id: string;
      }[]
    ).map((r) => r.id);

    const ran: string[] = [];
    for (const id of ids) {
      const claimed = inTransaction(this.db, () => {
        const res = this.db
          .prepare("UPDATE requests SET status = 'executing' WHERE id = ? AND status = 'approved'")
          .run(id);
        if (Number(res.changes) !== 1) return null;
        this.appendAudit(id, "executing", "gate", {});
        return this.getRow(id);
      });
      if (!claimed) continue;
      await this.execute(claimed);
      ran.push(id);
    }
    return ran;
  }

  private async execute(row: RequestRow): Promise<void> {
    const finish = (status: "executed" | "failed", fields: { result?: unknown; error?: string }) =>
      inTransaction(this.db, () => {
        const at = this.now();
        this.db
          .prepare(
            "UPDATE requests SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?",
          )
          .run(
            status,
            fields.result === undefined ? null : canonicalJson(fields.result),
            fields.error ?? null,
            at,
            row.id,
          );
        this.appendAudit(row.id, status, "gate", fields.error ? { error: fields.error } : {});
      });

    // The arguments that run must be the ones the human saw. Compare against
    // the hash written into the audit chain at request time, not only the
    // copy stored next to the arguments.
    const requested = this.db
      .prepare("SELECT data_json FROM audit WHERE request_id = ? AND event = 'requested'")
      .get(row.id) as { data_json: string } | undefined;
    const auditedHash = requested ? (JSON.parse(requested.data_json).args_hash as string) : null;
    const currentHash = sha256(`${row.tool}\n${row.args_json}`);
    if (!auditedHash || auditedHash !== currentHash) {
      finish("failed", { error: "arguments changed after the request was made; refusing to run" });
      return;
    }

    const tool = this.tools.get(row.tool);
    if (!tool) {
      finish("failed", { error: `tool ${row.tool} is no longer registered` });
      return;
    }
    try {
      const result = await tool.run(JSON.parse(row.args_json));
      finish("executed", { result });
    } catch (err) {
      finish("failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  expireStale(): number {
    return inTransaction(this.db, () => {
      const at = this.now();
      const stale = this.db
        .prepare("SELECT * FROM requests WHERE status = 'pending' AND expires_at <= ?")
        .all(at) as unknown as RequestRow[];
      for (const row of stale) this.markExpired(row, at);
      return stale.length;
    });
  }

  private markExpired(row: RequestRow, at: number): void {
    this.db
      .prepare("UPDATE requests SET status = 'expired', finished_at = ? WHERE id = ? AND status = 'pending'")
      .run(at, row.id);
    this.appendAudit(row.id, "expired", "gate", {});
  }

  getRequest(id: string): RequestRow {
    return this.getRow(id);
  }

  listRequests(status?: string): RequestRow[] {
    this.expireStale();
    const sql = status
      ? "SELECT * FROM requests WHERE status = ? ORDER BY created_at"
      : "SELECT * FROM requests ORDER BY created_at";
    const stmt = this.db.prepare(sql);
    return (status ? stmt.all(status) : stmt.all()) as unknown as RequestRow[];
  }

  auditLog(): AuditRow[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY seq").all() as unknown as AuditRow[];
  }

  /**
   * Walks the hash chain. Editing, deleting or reordering any row breaks
   * every hash after it. This makes tampering evident, not impossible:
   * someone with write access can rebuild the whole chain, so in production
   * the head hash should also be shipped somewhere the agent host cannot
   * write to.
   */
  verifyAudit(): { ok: true; entries: number; head: string } | { ok: false; brokenAt: number } {
    let prev = GENESIS;
    const rows = this.auditLog();
    for (const row of rows) {
      if (row.prev_hash !== prev || row.hash !== auditHash(row, prev)) {
        return { ok: false, brokenAt: row.seq };
      }
      prev = row.hash;
    }
    return { ok: true, entries: rows.length, head: prev };
  }

  /** Must be called inside a transaction so two writers cannot fork the chain. */
  private appendAudit(requestId: string, event: string, actor: string, data: object): void {
    const last = this.db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    const prev = last?.hash ?? GENESIS;
    const entry = {
      seq: (last?.seq ?? 0) + 1,
      at: this.now(),
      request_id: requestId,
      event,
      actor,
      data_json: canonicalJson(data),
    };
    this.db
      .prepare(
        "INSERT INTO audit (seq, at, request_id, event, actor, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.seq,
        entry.at,
        entry.request_id,
        entry.event,
        entry.actor,
        entry.data_json,
        prev,
        auditHash(entry, prev),
      );
  }

  private getRow(id: string): RequestRow {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
    if (!row) throw new GateError(`unknown request ${id}`);
    return row;
  }

  private requireTool(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new GateError(`unknown tool ${name}`);
    return tool;
  }
}

function auditHash(
  entry: Pick<AuditRow, "seq" | "at" | "request_id" | "event" | "actor" | "data_json">,
  prev: string,
): string {
  return sha256(
    `${prev}\n${canonicalJson({
      seq: entry.seq,
      at: entry.at,
      request_id: entry.request_id,
      event: entry.event,
      actor: entry.actor,
      data_json: entry.data_json,
    })}`,
  );
}
