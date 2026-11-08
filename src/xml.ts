/**
 * Everything the agent reads in a user turn is XML-tagged so it can tell who is speaking:
 *  - `<system>…</system>` is text from this program (flush request, archive framing);
 *  - `<message …>…</message>` is a group member's message.
 * Text written by group members is escaped, so it can never contain a real tag of either kind.
 */

/** Escapes text for use as element content: `&`, `<`, `>`. */
export const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Escapes text for use inside a double-quoted attribute value. */
export const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

/** Wraps program-authored text (never user text) in the `<system>` tag. */
export const systemMessage = (text: string): string => `<system>\n${text}\n</system>`;

/** `<name a="1" b="2">escaped body</name>`; attribute values and body are escaped, undefined attributes are left out. */
export function element(name: string, attrs: Record<string, string | undefined>, body: string): string {
  const a = Object.entries(attrs)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  return `<${name}${a}>\n${escapeText(body)}\n</${name}>`;
}
