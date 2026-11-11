import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { slotOf, writeJson } from "../server/record.ts";
import { readJson } from "./files.ts";
import { canonical } from "./found.ts";

// The boss's intent behind a pane (docs/specs/2026-11-09-auto-mode.md, D3 note of 11/12): a pane the page's `open/base` started carries an explicit user action, so under auto mode its pi's
// trust question is asked as usual instead of being answered "not trusted" at once. The pane's pi runs in another process, so the channel is a file of the state folder, one per Herdr
// (`open-intents-<slot hash>.json`, mode 600). Only the sb server writes it: it lists the panes it started for an open/base that has not finished joining, each with the folder it started
// pi in and a time it expires at (the open's join wait). A reader trusts nothing the pane says about itself: it looks up its own pane id (Herdr's, in the environment of the pi it started)
// and its own folder in the list, and a pane that is not listed, or is listed for another folder, or whose entry ran out, is answered as before. No request field, flag, or environment
// variable can add a pane to it.

export interface Intents {
	/** Lists `pane` (pi starting in `cwd`) for `ms`; returns the call that takes it off again. Throws when the file cannot be written. */
	grant(pane: string, cwd: string, ms: number): () => void;
}
interface Entry { pane: string; cwd: string; expires: number }
interface Listing { v: 1; panes: Entry[] }

export const intentFile = (state: string, hash: string) => join(state, `open-intents-${hash}.json`);
const entryOf = (v: unknown): Entry | undefined => {
	const e = v as Entry | null;
	return e !== null && typeof e === "object" && typeof e.pane === "string" && e.pane.length > 0 && typeof e.cwd === "string" && e.cwd.length > 0 && Number.isFinite(e.expires) ? { pane: e.pane, cwd: e.cwd, expires: e.expires } : undefined;
};

/** The server's side: the live entries are kept in memory and written whole at each change, so the file is never more than what this process granted. */
export function createIntents(file: string, now: () => number = Date.now): Intents {
	const live = new Set<Entry>();
	const save = () => {
		for (const e of live) if (e.expires <= now()) live.delete(e);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeJson(file, { v: 1, panes: [...live] } satisfies Listing);
	};
	return {
		grant(pane, cwd, ms) {
			const entry: Entry = { pane, cwd, expires: now() + ms };
			live.add(entry);
			try {
				save();
			} catch (error) {
				live.delete(entry);
				throw error;
			}
			return () => {
				if (live.delete(entry)) try { save(); } catch {} // an entry left behind expires by itself
			};
		},
	};
}

/** What an open/base does before pi starts: lists the pane and returns the call that takes it off. A list that cannot be written is logged and the pane stays unlisted (the question is then auto mode's own answer, D3: the safe side). */
export function listed(intents: Intents | undefined, note: ((event: string, facts: Record<string, string>) => void) | undefined, pane: string, cwd: string, ms: number): (() => void) | undefined {
	try {
		return intents?.grant(pane, cwd, ms);
	} catch (error) {
		note?.("open-intent-failed", { text: (error as Error).message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300) });
	}
}

/** The pane's side: whether the server listed this pane for this folder, and the entry is still alive. Whatever cannot be read says no. */
export function intended(state: string, env: NodeJS.ProcessEnv, cwd: string, now: number): boolean {
	const pane = env.HERDR_PANE_ID;
	if (!pane) return false;
	const read = readJson(intentFile(state, slotOf(state, env).hash), 1 << 20), listing = read?.value as Listing | null | undefined;
	if (!listing || listing.v !== 1 || !Array.isArray(listing.panes)) return false;
	const here = canonical(cwd);
	return listing.panes.some((raw) => {
		const e = entryOf(raw);
		return Boolean(e && e.pane === pane && e.expires > now && canonical(e.cwd) === here);
	});
}
