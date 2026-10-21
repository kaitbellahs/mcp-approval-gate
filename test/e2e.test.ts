import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

// Runs the real server and the real CLI as separate processes, the way they
// are used: agent on stdio, human in a terminal, one SQLite file between them.
const dir = tempDir();
const env = {
  ...process.env,
  APPROVAL_GATE_DB: join(dir, "gate.db"),
  APPROVAL_GATE_OUTBOX: join(dir, "outbox.jsonl"),
  APPROVAL_GATE_POLL_MS: "50",
  APPROVAL_GATE_APPROVER: "e2e-reviewer",
};
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env, encoding: "utf8" });

const client = new Client({ name: "e2e-agent", version: "1.0.0" });

afterAll(async () => {
  await client.close();
});

describe("server and CLI as separate processes", () => {
  it("sends the email only after a human approves it in the CLI", async () => {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/server.ts"],
        env: env as Record<string, string>,
        stderr: "ignore",
      }),
    );

    const res = await client.callTool({
      name: "send_email",
      arguments: {
        to: "buyer@example.com",
        subject: "Your refund",
        body: "Done.",
        reason: "customer confirmed the refund on the phone",
      },
    });
    const { id, status } = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(status).toBe("pending");
    expect(cli("list")).toContain(id);
    expect(existsSync(env.APPROVAL_GATE_OUTBOX)).toBe(false);

    expect(cli("approve", id, "looks right")).toContain(`approved ${id}`);

    let final = "";
    for (let i = 0; i < 40 && final !== "executed"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = await client.callTool({ name: "get_request_status", arguments: { id } });
      final = JSON.parse((s.content as { text: string }[])[0]!.text).status;
    }
    expect(final).toBe("executed");

    const outbox = readFileSync(env.APPROVAL_GATE_OUTBOX, "utf8").trim().split("\n");
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0]!)).toMatchObject({ kind: "email.sent", to: "buyer@example.com" });
    expect(cli("verify")).toMatch(/audit chain ok: 4 entries/);
  }, 20_000);
});
