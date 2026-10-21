import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp.js";
import { makeGate, REASON } from "./helpers.js";

async function connect() {
  const ctx = makeGate();
  const server = buildMcpServer(ctx.gate);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    return { isError: Boolean(res.isError), text, data: res.isError ? null : JSON.parse(text) };
  };
  return { ...ctx, client, call };
}

describe("MCP surface", () => {
  it("exposes the tools and status checks, and no way to approve", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_request_status", "list_requests", "lookup", "pay"]);
    expect(names.some((n) => /approve|reject/.test(n))).toBe(false);
    const pay = tools.find((t) => t.name === "pay")!;
    expect(pay.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(pay.inputSchema.required).toContain("reason");
  });

  it("goes from pending to executed once a human approves out of band", async () => {
    const { call, gate, calls } = await connect();
    const sub = await call("pay", { to: "acme", cents: 700, reason: REASON });
    expect(sub.data).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(0);

    const before = await call("get_request_status", { id: sub.data.id });
    expect(before.data).toMatchObject({ status: "pending", reason: REASON });

    gate.approve(sub.data.id, "human:khalid", "checked the ticket");
    const after = await call("get_request_status", { id: sub.data.id });
    expect(after.data).toMatchObject({ status: "executed", result: { paid: 700 }, decided_by: "human:khalid" });
    expect(gate.getRequest(sub.data.id).requested_by).toBe("agent:test-agent");
  });

  it("asks for a real reason on gated tools", async () => {
    const { call } = await connect();
    const res = await call("pay", { to: "acme", cents: 700, reason: "pls" });
    expect(res.isError).toBe(true);
  });

  it("passes read-only tools straight through", async () => {
    const { call } = await connect();
    const res = await call("lookup", { key: "x" });
    expect(res.data).toEqual({ status: "executed", result: { value: "v:x" } });
  });
});
