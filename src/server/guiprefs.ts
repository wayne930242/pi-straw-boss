import { join } from "node:path";
import { readOwnedText, writeJson } from "./record.ts";

// The server's default view of the page (`/boss gui view`, docs/how-it-works.md Browser view): which view a device that follows the server gets. It is a presentation setting of the whole server, kept in `gui-prefs.json`
// beside gui.json (mode 600, written by rename), not in gui-secrets.json: dropping the secrets on a rotation must not forget it. Only the pi command writes it; the page never does.

export const PREFS_FILE = "gui-prefs.json";
/** What the default can be: `auto` leaves each device to its own screen's contrast preference. */
export const VIEWS = ["auto", "standard", "geek"] as const;
export type ServerView = (typeof VIEWS)[number];
export const isView = (value: unknown): value is ServerView => typeof value === "string" && (VIEWS as readonly string[]).includes(value);

/** The stored default; a missing file, a file another account owns, a link, and anything this code did not write read as Auto. */
export function readView(dir: string): ServerView {
	const text = readOwnedText(join(dir, PREFS_FILE));
	if (text === undefined) return "auto";
	try {
		const v = JSON.parse(text) as Record<string, unknown> | null;
		if (v && typeof v === "object" && v.v === 1 && isView(v.view)) return v.view;
	} catch {} // corrupt
	return "auto";
}

/** Stores the default; throws when the folder cannot be written (the caller tells the boss, and nothing changes). */
export const writeView = (dir: string, view: ServerView) => writeJson(join(dir, PREFS_FILE), { v: 1, view });
