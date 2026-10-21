import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ApprovalGate, type ToolDefinition } from "../src/gate.js";
import { openDatabase } from "../src/store.js";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "approval-gate-"));
}

/** A gate with a controllable clock and tools that count their own calls. */
export function makeGate(dbPath = join(tempDir(), "gate.db"), opts: { ttlMs?: number } = {}) {
  const clock = { t: Date.UTC(2026, 9, 21, 12, 0, 0) };
  const calls: { tool: string; args: unknown }[] = [];
  const tools: ToolDefinition[] = [
    {
      name: "lookup",
      description: "read something",
      readOnly: true,
      input: { key: z.string() },
      run: async (args) => {
        calls.push({ tool: "lookup", args });
        return { value: `v:${String(args.key)}` };
      },
    },
    {
      name: "pay",
      description: "move money",
      input: { to: z.string(), cents: z.number().int().positive() },
      run: async (args) => {
        calls.push({ tool: "pay", args });
        if (args.to === "explode") throw new Error("bank said no");
        return { paid: args.cents };
      },
    },
  ];
  const db = openDatabase(dbPath);
  const gate = new ApprovalGate(db, tools, { now: () => clock.t, ttlMs: opts.ttlMs ?? 60_000 });
  return { gate, db, clock, calls, tools, dbPath };
}

export const REASON = "customer asked for it on ticket 42";
