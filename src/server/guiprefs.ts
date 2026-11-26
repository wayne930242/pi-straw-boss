import { join } from "node:path";
import { type Choice, CHOICES, isChoice, said } from "../views.ts";
import { readOwnedText, writeJson } from "./record.ts";

// The server's default view of the page (`/boss gui view`, docs/how-it-works.md Browser view): which view a device that follows the server gets. It is a presentation setting of the whole server, kept in `gui-prefs.json`
// beside gui.json (mode 600, written by rename), not in gui-secrets.json: dropping the secrets on a rotation must not forget it. Only the pi command writes it; the page never does.

export const PREFS_FILE = "gui-prefs.json";
/** What the default can be: `auto` leaves each device to its own screen's contrast preference. */
export type ServerView = Choice;
export const isView = isChoice;

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

/** Whether the file already says exactly this default (a missing file says `auto`). An older or newer build's value this code reads as `auto` does not match, so an explicit set rewrites it. */
export function storedIs(dir: string, view: ServerView | "zen"): boolean {
	const text = readOwnedText(join(dir, PREFS_FILE));
	if (text === undefined) return view === "auto";
	try {
		const v = JSON.parse(text) as Record<string, unknown> | null;
		return !!v && typeof v === "object" && v.v === 1 && v.view === view;
	} catch {
		return false;
	}
}

/** The file still says `zen`, the value of a build where Zen was a view (docs/specs/2026-11-26-storybook-theme/spec.md A1): it reads as `auto`, and `/boss gui view` says so. Nothing rewrites it but an explicit set. */
export const storedZen = (dir: string): boolean => storedIs(dir, "zen");

/** Why `zen` is no default (A1): the page's header enters it. */
export const ZEN_REFUSED = `Zen is a mode now: enter it with the Zen button in the page's header. The default view is ${said(CHOICES)}`;
/** The tell's extra line while the file says `zen`. */
export const ZEN_STORED = "gui-prefs.json still says zen, which is now a mode; the default reads as auto";

/** Stores the default; throws when the folder cannot be written (the caller tells the boss, and nothing changes). */
export const writeView = (dir: string, view: ServerView) => writeJson(join(dir, PREFS_FILE), { v: 1, view });
