import { appendFileSync } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "./gate.js";

/**
 * Stand-ins for real integrations. Side effects go to an outbox file so a
 * demo run shows exactly when (and whether) the action happened.
 */
export function demoTools(outboxPath: string): ToolDefinition[] {
  const effect = (kind: string, payload: object) => {
    const record = { at: new Date().toISOString(), kind, ...payload };
    appendFileSync(outboxPath, JSON.stringify(record) + "\n");
    return record;
  };

  const invoices = [
    { id: "INV-1001", customer: "acme", amount_cents: 129900, status: "paid" },
    { id: "INV-1002", customer: "globex", amount_cents: 45000, status: "open" },
  ];

  return [
    {
      name: "list_invoices",
      description: "List invoices, optionally for one customer.",
      readOnly: true,
      input: { customer: z.string().optional() },
      run: async ({ customer }) => invoices.filter((i) => !customer || i.customer === customer),
    },
    {
      name: "send_email",
      description: "Send an email to a customer.",
      input: {
        to: z.email(),
        subject: z.string().min(1).max(200),
        body: z.string().min(1),
      },
      run: async (args) => effect("email.sent", args),
    },
    {
      name: "issue_refund",
      description: "Refund part or all of a paid invoice.",
      input: {
        invoice_id: z.string(),
        amount_cents: z.number().int().positive(),
      },
      run: async ({ invoice_id, amount_cents }) => {
        const invoice = invoices.find((i) => i.id === invoice_id);
        if (!invoice) throw new Error(`no invoice ${String(invoice_id)}`);
        if (invoice.status !== "paid") throw new Error(`${invoice.id} is not paid`);
        if (Number(amount_cents) > invoice.amount_cents) throw new Error("refund exceeds invoice total");
        return effect("refund.issued", { invoice_id, amount_cents });
      },
    },
  ];
}
