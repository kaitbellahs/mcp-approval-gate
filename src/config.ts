import { userInfo } from "node:os";

export const config = {
  dbPath: process.env.APPROVAL_GATE_DB ?? "approval-gate.db",
  outboxPath: process.env.APPROVAL_GATE_OUTBOX ?? "outbox.jsonl",
  ttlMs: Number(process.env.APPROVAL_GATE_TTL_SECONDS ?? 3600) * 1000,
  pollMs: Number(process.env.APPROVAL_GATE_POLL_MS ?? 1000),
  approver: () => `human:${process.env.APPROVAL_GATE_APPROVER ?? userInfo().username}`,
};
