// The tool names the sb server's own texts write (docs/specs/2026-11-23-lite-b2-d-e-f.md §1.6): a session that has not reloaded keeps the tools of its older build while the server it talks to is new, so for one release (0.83.0)
// a text that names a tool B2 folded names both forms. The next release drops the old form.

/** New name → the name it replaced. */
const FOLDED: Readonly<Record<string, string>> = { board_read: "boss_status" };
export const toolWord = (name: string): string => (FOLDED[name] ? `${name} (was ${FOLDED[name]})` : name);
/** A text with the old forms `toolWord` added taken out: what a guard that matches tool names reads (the old name is history, not a tool to call). */
export const withoutOldWords = (text: string): string => text.replace(/ \(was [a-z_]+\)/g, "");
