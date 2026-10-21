import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApprovalGate, GateError } from "./gate.js";
import type { RequestRow } from "./store.js";

const reasonField = z
  .string()
  .min(10)
  .describe("Why this action is needed. The human approver reads this before deciding.");

/**
 * Exposes the gate over MCP. Note what is missing on purpose: there is no
 * approve or reject tool. The model can ask; only a person on a different
 * channel (the CLI) can say yes.
 */
export function buildMcpServer(gate: ApprovalGate): McpServer {
  const server = new McpServer({ name: "approval-gate", version: "0.1.0" });
  const requester = () => `agent:${server.server.getClientVersion()?.name ?? "unknown"}`;

  for (const tool of gate.listTools()) {
    const gated = !tool.readOnly;
    server.registerTool(
      tool.name,
      {
        description: gated
          ? `${tool.description} Requires human approval: the call returns a pending request id instead of running. Check it with get_request_status.`
          : tool.description,
        inputSchema: gated ? { ...tool.input, reason: reasonField } : tool.input,
        annotations: { readOnlyHint: !gated, destructiveHint: gated },
      },
      async (input: Record<string, unknown>) => {
        const { reason, ...args } = input;
        try {
          const out = await gate.submit(tool.name, args, String(reason ?? ""), requester());
          return json(out);
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  server.registerTool(
    "get_request_status",
    {
      description:
        "Status of a request held for approval: pending, approved, executing, executed, failed, rejected or expired. Includes the result or the approver's note.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        await gate.runApproved();
        return json(publicView(gate.getRequest(id)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_requests",
    {
      description: "Requests held by the gate, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["pending", "approved", "executing", "executed", "failed", "rejected", "expired"])
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json(gate.listRequests(status).map(publicView)),
  );

  return server;
}

function publicView(row: RequestRow) {
  return {
    id: row.id,
    tool: row.tool,
    status: row.status,
    args: JSON.parse(row.args_json),
    reason: row.reason,
    requested_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    decided_by: row.decided_by,
    decision_note: row.decision_note,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
  };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  const message =
    err instanceof GateError || err instanceof z.ZodError || err instanceof Error
      ? err.message
      : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
