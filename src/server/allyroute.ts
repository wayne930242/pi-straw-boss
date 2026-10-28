import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./record.ts";
import { ALLY_FILES, ensureDir, KEEP_MS, towerDir, writeDurable } from "./towerstore.ts";

// What an ally run leaves with the server for the device it serves (docs/specs/2026-10-26-sb-backend.md, Ally runs; RV6-F003). A local session an ally run writes to, or opens, is answering a peer's request, and what it
// says back must never reach a local run: it would carry the peer's words, with no context, into the run the boss trusts. So these live apart from the local run's expectations and ledger, per device:
//   `ally-routes.json`   the sessions an ally run waits on (a `tower_reply` that expects a reply, one answer) or opened (every report), and for which device,
//   `ally-answers.json`  what those sessions said, kept until the device's next ally run takes it (the same rule as a link message: a message that arrives during a run waits for the next one),
//   `ally-opened.json`   the opener's ledger of the mains ally runs opened.
// 24 hours, as the local files. This file has no pi dependency: it runs in the server's bundle.

const ROUTES = ALLY_FILES[0], ANSWERS = ALLY_FILES[1];
export const ALLY_LEDGER = ALLY_FILES[2];
const MAX_ROUTES = 40, MAX_ANSWERS = 50, MAX_TEXT = 100_000;

/** The sender an ally run serves, as a route and an answer keep it (the ally brief and the header need these). */
export interface Peer { device: string; label: string; short: string; team: string; teamName: string }
export interface Route extends Peer {
	/** The local session id the run wrote to or opened. */
	to: string;
	name: string;
	/** `expect`: one answer, then the route is spent; `opened`: every report of the main it opened. */
	kind: "expect" | "opened";
	at: number;
}
export interface Answer extends Peer {
	id: string;
	from: { id: string; name: string };
	text: string;
	at: number;
}

const read = <T>(slot: Slot, workspace: string, file: string, now: number): T[] => {
	try {
		const found = JSON.parse(readFileSync(join(towerDir(slot, workspace), file), "utf8")) as { entries?: (T & { at: number })[] };
		return (Array.isArray(found.entries) ? found.entries : []).filter((e) => typeof e?.at === "number" && now - e.at <= KEEP_MS);
	} catch {
		return [];
	}
};
const write = (slot: Slot, workspace: string, file: string, entries: unknown[]) => {
	ensureDir(towerDir(slot, workspace));
	writeDurable(join(towerDir(slot, workspace), file), { entries });
};

export const readRoutes = (slot: Slot, workspace: string, now: number) => read<Route>(slot, workspace, ROUTES, now).filter((r) => typeof r.to === "string" && typeof r.device === "string");
/** A route for `row.to` and its device replaces the earlier one. */
export function addRoute(slot: Slot, workspace: string, row: Route, now: number): void {
	write(slot, workspace, ROUTES, [...readRoutes(slot, workspace, now).filter((r) => !(r.to === row.to && r.device === row.device)), row].slice(-MAX_ROUTES));
}
/** The newest route for a session, if an ally run waits on it or opened it. */
export const routeOf = (slot: Slot, workspace: string, session: string, now: number): Route | undefined => readRoutes(slot, workspace, now).filter((r) => r.to === session).at(-1);
/** An answer spends an `expect` route; an `opened` one stays for the main's next report. */
export function spendRoute(slot: Slot, workspace: string, route: Route, now: number): void {
	if (route.kind === "expect") write(slot, workspace, ROUTES, readRoutes(slot, workspace, now).filter((r) => !(r.to === route.to && r.device === route.device && r.at === route.at)));
}

export const readAnswers = (slot: Slot, workspace: string, now: number) => read<Answer>(slot, workspace, ANSWERS, now).filter((a) => typeof a.id === "string" && typeof a.text === "string" && typeof a.device === "string");
export function addAnswer(slot: Slot, workspace: string, row: Answer, now: number): void {
	write(slot, workspace, ANSWERS, [...readAnswers(slot, workspace, now), { ...row, text: row.text.slice(0, MAX_TEXT) }].slice(-MAX_ANSWERS));
}
export function removeAnswer(slot: Slot, workspace: string, id: string, now: number): void {
	const was = readAnswers(slot, workspace, now);
	if (was.some((a) => a.id === id)) write(slot, workspace, ANSWERS, was.filter((a) => a.id !== id));
}
