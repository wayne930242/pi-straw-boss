import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./record.ts";
import { ensureDir, listServices, towerDir, writeDurable } from "./towerstore.ts";

// The asks a local tower made for its mains (docs/specs/2026-10-26-sb-backend.md, Replies for a main (D4)): `tower_send({ device, reply: true, for })` makes an ask id and records it in `tower/<ws>/awaiting.json` for 24 hours.
// A `tower-reply` is the reply to an ask only when its `inReplyTo` names an open ask, the envelope comes from the device asked, and the ask has not been used (`take`): it then closes the ask. Anything else is a plain message.

export const ASK_KEEP_MS = 24 * 3600_000;
const MAX_OPEN = 50;
export interface AskEntry {
	/** The ask id, 16 random bytes in hex. */
	ask: string;
	/** The envelope id of the `tower` that carried it. */
	envelope: string;
	/** The device asked (its full id) and the team the envelope went through. */
	device: string;
	team: string;
	/** The local session (a main of the tower's workspace) the reply goes to, and its name when it asked. */
	for: string;
	forName: string;
	workspace: string;
	/** The tower identity that asked. */
	tower: string;
	at: number;
	expires: number;
	used?: true;
}
export interface Taken { main: string; mainName: string; tower: string; workspace: string }

const file = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "awaiting.json");
function read(slot: Slot, workspace: string): AskEntry[] {
	try {
		const found = JSON.parse(readFileSync(file(slot, workspace), "utf8")) as { entries?: unknown };
		return (Array.isArray(found.entries) ? found.entries : []).filter((e): e is AskEntry => typeof e?.ask === "string" && typeof e.device === "string" && typeof e.team === "string" && typeof e.for === "string" && typeof e.expires === "number");
	} catch {
		return [];
	}
}

export function createAsks(slot: Slot, now: () => number = Date.now) {
	const write = (workspace: string, entries: AskEntry[]) => {
		ensureDir(towerDir(slot, workspace));
		writeDurable(file(slot, workspace), { entries });
	};
	return {
		/** An ask went out: it waits for its answer for 24 hours. */
		open(entry: AskEntry): void {
			const live = read(slot, entry.workspace).filter((e) => e.expires > now() && !e.used);
			write(entry.workspace, [...live, entry].slice(-MAX_OPEN));
		},
		/** The asks of a workspace that still wait for an answer (the brief lists them as obligations). */
		openOf(workspace: string): AskEntry[] {
			return read(slot, workspace).filter((e) => e.expires > now() && !e.used);
		},
		/** A `tower-reply` arrived: the main that asked, when the ask is open and the reply comes from the device asked; the ask is closed then. Undefined for anything else. */
		take(q: { team: string; device: string; ask: string }): Taken | undefined {
			for (const service of listServices(slot)) {
				const entries = read(slot, service.workspace), hit = entries.find((e) => e.ask === q.ask);
				if (!hit) continue;
				if (hit.used || hit.expires <= now() || hit.device !== q.device || hit.team !== q.team) return undefined;
				write(service.workspace, entries.map((e) => (e === hit ? { ...e, used: true as const } : e)));
				return { main: hit.for, mainName: hit.forName, tower: hit.tower, workspace: hit.workspace };
			}
			return undefined;
		},
	};
}
export type Asks = ReturnType<typeof createAsks>;
