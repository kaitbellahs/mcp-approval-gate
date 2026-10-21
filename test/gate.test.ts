import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../src/gate.js";
import { openDatabase } from "../src/store.js";
import { makeGate, REASON } from "./helpers.js";

const AGENT = "agent:test";
const HUMAN = "human:khalid";

async function pending(gate: ApprovalGate, args = { to: "acme", cents: 500 }) {
  const out = await gate.submit("pay", args, REASON, AGENT);
  if (out.status !== "pending") throw new Error("expected pending");
  return out.id;
}

describe("approval gate", () => {
  it("runs read-only tools immediately", async () => {
    const { gate, calls } = makeGate();
    const out = await gate.submit("lookup", { key: "a" }, "", AGENT);
    expect(out).toEqual({ status: "executed", result: { value: "v:a" } });
    expect(calls).toHaveLength(1);
  });

  it("holds an irreversible tool and does not run it before approval", async () => {
    const { gate, calls } = makeGate();
    const id = await pending(gate);
    await gate.runApproved();
    expect(calls).toHaveLength(0);
    expect(gate.getRequest(id).status).toBe("pending");
  });

  it("runs an approved request exactly once", async () => {
    const { gate, calls } = makeGate();
    const id = await pending(gate);
    gate.approve(id, HUMAN, "ok");
    await gate.runApproved();
    await gate.runApproved();
    expect(calls).toEqual([{ tool: "pay", args: { to: "acme", cents: 500 } }]);
    const row = gate.getRequest(id);
    expect(row.status).toBe("executed");
    expect(JSON.parse(row.result_json!)).toEqual({ paid: 500 });
  });

  it("lets only one of two competing executors claim a request", async () => {
    const a = makeGate();
    const b = makeGate(a.dbPath);
    const id = await pending(a.gate);
    a.gate.approve(id, HUMAN);
    const [ranA, ranB] = await Promise.all([a.gate.runApproved(), b.gate.runApproved()]);
    expect([...ranA, ...ranB]).toEqual([id]);
    expect(a.calls.length + b.calls.length).toBe(1);
  });

  it("never runs a rejected request and keeps the reason for the agent", async () => {
    const { gate, calls } = makeGate();
    const id = await pending(gate);
    gate.reject(id, HUMAN, "wrong customer");
    await gate.runApproved();
    expect(calls).toHaveLength(0);
    expect(gate.getRequest(id)).toMatchObject({ status: "rejected", decision_note: "wrong customer" });
  });

  it("requires a reason to reject", async () => {
    const { gate } = makeGate();
    const id = await pending(gate);
    expect(() => gate.reject(id, HUMAN, "  ")).toThrow(/reason/);
  });

  it("refuses decisions on requests that are no longer pending", async () => {
    const { gate } = makeGate();
    const id = await pending(gate);
    gate.approve(id, HUMAN);
    expect(() => gate.approve(id, HUMAN)).toThrow(/approved/);
    expect(() => gate.reject(id, HUMAN, "too late")).toThrow(/approved/);
  });

  it("refuses self-approval", async () => {
    const { gate } = makeGate();
    const id = await pending(gate);
    expect(() => gate.approve(id, AGENT)).toThrow(/own request/);
  });

  it("expires requests nobody decided in time, and the expiry sticks", async () => {
    const { gate, clock, calls } = makeGate(undefined, { ttlMs: 1000 });
    const id = await pending(gate);
    clock.t += 1001;
    expect(() => gate.approve(id, HUMAN)).toThrow(/expired/);
    expect(gate.getRequest(id).status).toBe("expired");
    await gate.runApproved();
    expect(calls).toHaveLength(0);
  });

  it("returns the same request for a duplicate call instead of queueing it twice", async () => {
    const { gate } = makeGate();
    const first = await gate.submit("pay", { to: "acme", cents: 500 }, REASON, AGENT);
    const again = await gate.submit("pay", { cents: 500, to: "acme" }, REASON, AGENT);
    const other = await gate.submit("pay", { to: "acme", cents: 501 }, REASON, AGENT);
    expect(again).toMatchObject({ status: "pending", duplicate: true });
    expect(first.status === "pending" && again.status === "pending" && again.id === first.id).toBe(true);
    expect(other).toMatchObject({ duplicate: false });
  });

  it("rejects arguments that do not match the tool schema before queueing", async () => {
    const { gate } = makeGate();
    await expect(gate.submit("pay", { to: "acme", cents: -5 }, REASON, AGENT)).rejects.toThrow();
    await expect(gate.submit("pay", { to: "acme", cents: 5, extra: 1 }, REASON, AGENT)).rejects.toThrow();
    expect(gate.listRequests()).toHaveLength(0);
  });

  it("records a failure without retrying", async () => {
    const { gate, calls } = makeGate();
    const id = await pending(gate, { to: "explode", cents: 1 });
    gate.approve(id, HUMAN);
    await gate.runApproved();
    await gate.runApproved();
    expect(calls).toHaveLength(1);
    expect(gate.getRequest(id)).toMatchObject({ status: "failed", error: "bank said no" });
  });

  it("refuses to run if the stored arguments were edited after the request", async () => {
    const { gate, db, calls } = makeGate();
    const id = await pending(gate);
    gate.approve(id, HUMAN);
    db.prepare("UPDATE requests SET args_json = ? WHERE id = ?").run(
      JSON.stringify({ cents: 999999, to: "attacker" }),
      id,
    );
    await gate.runApproved();
    expect(calls).toHaveLength(0);
    expect(gate.getRequest(id).error).toMatch(/arguments changed/);
  });

  it("persists across processes sharing one database file", async () => {
    const { gate, dbPath, clock } = makeGate();
    const id = await pending(gate);
    const cli = new ApprovalGate(openDatabase(dbPath), gate.listTools(), { now: () => clock.t });
    cli.approve(id, HUMAN);
    expect(gate.getRequest(id).status).toBe("approved");
  });
});

describe("audit log", () => {
  it("records the full lifecycle as a valid hash chain", async () => {
    const { gate } = makeGate();
    const id = await pending(gate);
    gate.approve(id, HUMAN, "fine");
    await gate.runApproved();
    expect(gate.auditLog().map((e) => e.event)).toEqual(["requested", "approved", "executing", "executed"]);
    expect(gate.verifyAudit()).toMatchObject({ ok: true, entries: 4 });
  });

  it("detects an edited entry", async () => {
    const { gate, db } = makeGate();
    const id = await pending(gate);
    gate.approve(id, HUMAN);
    db.prepare("UPDATE audit SET actor = 'human:someone-else' WHERE seq = 2").run();
    expect(gate.verifyAudit()).toEqual({ ok: false, brokenAt: 2 });
  });

  it("detects a deleted entry", async () => {
    const { gate, db } = makeGate();
    const id = await pending(gate);
    gate.approve(id, HUMAN);
    await gate.runApproved();
    db.prepare("DELETE FROM audit WHERE seq = 2").run();
    expect(gate.verifyAudit()).toEqual({ ok: false, brokenAt: 3 });
  });
});
