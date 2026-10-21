import { DatabaseSync } from "node:sqlite";

export type RequestStatus =
  | "pending"
  | "approved"
  | "executing"
  | "executed"
  | "failed"
  | "rejected"
  | "expired";

export interface RequestRow {
  id: string;
  tool: string;
  args_json: string;
  args_hash: string;
  reason: string;
  requested_by: string;
  status: RequestStatus;
  created_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  result_json: string | null;
  error: string | null;
  finished_at: number | null;
}

export interface AuditRow {
  seq: number;
  at: number;
  request_id: string;
  event: string;
  actor: string;
  data_json: string;
  prev_hash: string;
  hash: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  args_hash     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  decided_by    TEXT,
  decided_at    INTEGER,
  decision_note TEXT,
  result_json   TEXT,
  error         TEXT,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  event      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
`;

/**
 * One SQLite file holds both the queue and the audit log. The MCP server and
 * the approval CLI are separate processes, so we lean on SQLite's locking
 * (WAL + BEGIN IMMEDIATE) instead of inventing a file lock.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
