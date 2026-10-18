import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Slash command completion for the composer: the server asks a session's bridge which of its commands (extension commands, prompt templates,
// and skills, as pi.getCommands() lists them; pi's built-in commands mostly open terminal pickers and are left out) match what is typed after
// the `/`. The bridge filters, so a message carries at most MAX_COMMANDS short entries, well under the broker's message limit.

export const MAX_COMMANDS = 30, MAX_PREFIX = 64;
const MAX_DESCRIPTION = 160, SOURCES = ["extension", "prompt", "skill"];
export interface Cmd { name: string; source: "extension" | "prompt" | "skill"; description?: string }

const byName = (a: Cmd, b: Cmd) => a.name.localeCompare(b.name);
/** The session's commands whose name starts with `prefix`, then those that only contain it, each group by name, at most MAX_COMMANDS. */
export function listCommands(pi: Pick<ExtensionAPI, "getCommands">, prefix: string): Cmd[] {
	let all: Cmd[];
	try {
		all = pi.getCommands().map((c) => ({ name: c.name, source: c.source, ...(c.description ? { description: c.description.slice(0, MAX_DESCRIPTION) } : {}) }));
	} catch {
		return []; // a pi without the API lists nothing
	}
	const p = prefix.toLowerCase(), name = (c: Cmd) => c.name.toLowerCase();
	const starts = all.filter((c) => name(c).startsWith(p)).sort(byName), has = all.filter((c) => !name(c).startsWith(p) && name(c).includes(p)).sort(byName);
	return [...starts, ...has].slice(0, MAX_COMMANDS);
}

/** A bridge's list as the server takes it: every entry in shape, or nothing. */
export function checkCommands(raw: unknown): Cmd[] | undefined {
	if (!Array.isArray(raw) || raw.length > MAX_COMMANDS) return;
	const ok = (c: Record<string, unknown>) => typeof c?.name === "string" && c.name.length > 0 && c.name.length <= 128 && !/\s/.test(c.name) && SOURCES.includes(c.source as string) && (c.description === undefined || (typeof c.description === "string" && c.description.length <= MAX_DESCRIPTION));
	return raw.every(ok) ? raw.map(({ name, source, description }: Cmd) => ({ name, source, ...(description ? { description } : {}) })) : undefined;
}
