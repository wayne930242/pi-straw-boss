// A line at the head's composer (docs/specs/2026-11-23-f-entry.md §2.4, §2.8): a first word `@<workspace>` followed by a space sends the rest straight to that tower as the boss's words (`to`), with no head turn in
// between; `@@` sends a literal `@` to the head. Only the first line is read for it, and only here: the server takes `to` as a field and never reads `@` out of the text, so text cannot redirect itself.

export function headLine(text: string): { text: string; to?: string } {
	if (text.startsWith("@@")) return { text: text.slice(1) };
	const at = /^@([^\s@]\S*)[ \t]+(\S[\s\S]*)$/.exec(text);
	return at ? { text: at[2]!, to: at[1]! } : { text };
}
