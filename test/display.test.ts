import { describe, expect, it } from "vitest";
import { safe } from "../src/display.js";

describe("safe display of agent-supplied text", () => {
  it("escapes terminal control sequences instead of letting them run", () => {
    const reason = "routine refund\u001b[1A\u001b[2Kapproved by finance";
    const shown = safe(reason);
    expect(shown).not.toContain("\u001b");
    expect(shown).toContain("\\u001b[1A");
  });

  it("escapes carriage returns and bidi overrides", () => {
    expect(safe("pay $10\rpay $10000")).toBe("pay $10\\u000dpay $10000");
    expect(safe("abc‮dcba")).toBe("abc\\u202edcba");
  });

  it("keeps newlines and ordinary text, including accents", () => {
    expect(safe("line one\nlinha dois, açaí")).toBe("line one\nlinha dois, açaí");
  });
});
