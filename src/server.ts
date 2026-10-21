#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { demoTools } from "./demo-tools.js";
import { ApprovalGate } from "./gate.js";
import { buildMcpServer } from "./mcp.js";
import { openDatabase } from "./store.js";

const db = openDatabase(config.dbPath);
const gate = new ApprovalGate(db, demoTools(config.outboxPath), { ttlMs: config.ttlMs });
const server = buildMcpServer(gate);

// Approvals arrive from another process (the CLI), so the server polls for
// approved work. stdout belongs to the MCP protocol; log to stderr only.
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const ran = await gate.runApproved();
    for (const id of ran) console.error(`[approval-gate] ran ${id}`);
  } catch (err) {
    console.error("[approval-gate] executor error", err);
  } finally {
    busy = false;
  }
}, config.pollMs);
timer.unref();

await server.connect(new StdioServerTransport());
console.error(`[approval-gate] ready, db=${config.dbPath}`);
