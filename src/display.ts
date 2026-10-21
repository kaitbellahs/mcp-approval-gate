/**
 * Everything the CLI prints about a request came from the agent: the reason,
 * the arguments, even the client name. A reason containing terminal escape
 * codes could erase or rewrite lines on the approver's screen, and bidi
 * control characters can make text read differently than it is stored.
 * Both are shown escaped instead of interpreted.
 */
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function safe(text: string | null | undefined): string {
  if (text == null) return "";
  return text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
