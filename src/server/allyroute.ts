import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./record.ts";
import { ALLY_FILES, ensureDir, KEEP_MS, towerDir, writeDurable } from "./towerstore.ts";

// What an ally run leaves with the server for the device it serves (docs/specs/2026-10-26-sb-backend.md, Ally runs; RV6-F003). A local session an ally run writes to, or opens, is answering a peer's request, and what it
// says back must never reach a local run: it would carry the peer's words, with no context, into the run the boss trusts. So these live apart from the local run's expectations and ledger, per device:
//   `ally-routes.json`   the sessions an ally run waits on (a `tower_reply` that expects a reply, one answer) or opened (every report), and for which device,
//   `ally-answers.json`  what those sessions said, kept until the device's next ally run takes it (the same rule as a link message: a message that arrives during a run waits for the next one),
//   `ally-opened.json`   the opener's ledger of the mains ally runs opened.
// An `expect` route and an answer live 24 hours, as the local files; an `opened` route lives 7 days after the main's last report and is bounded and dropped with its main (below). This file has no pi dependency: it runs in the server's bundle.

const ROUTES = ALLY_FILES[0], ANSWERS = ALLY_FILES[1];
export const ALLY_LEDGER = ALLY_FILES[2];
const MAX_ROUTES = 40, MAX_ANSWERS = 50, MAX_TEXT = 100_000;
/** The `opened` rows kept per device and in all (the opener holds at most 2 live marked mains per workspace and one per sender), and how long a row of a main the broker no longer lists is kept in case the main is only restarting. */
const MAX_OPENED_PER_DEVICE = 8, MAX_OPENED = 20, DEAD_GRACE_MS = 10 * 60_000;

/** The sender an ally run serves, as a route and an answer keep it (the ally brief and the header need these). */
export interface Peer { device: string; label: string; short: string; team: string; teamName: string }
/** A stop the box accepted for an `opened` route (docs/specs/2026-11-07-link-remote-stop.md, section 5): who asked (`by`, a device id), when the box took it (`at`), its id, its mode (`quit` or `interrupt`), and the requester's reason, if one was given. The revoker carries it out. */
export interface Stop { by: string; at: number; stopId: string; mode: string; /** The requester's reason, one line of at most 200 bytes; it goes into the `main-stop-*` notices and never into link.log. */ reason?: string }
export interface Route extends Peer {
	/** The local session id the run wrote to or opened. */
	to: string;
	name: string;
	/** `expect`: one answer, then the route is spent; `opened`: every report of the main it opened. */
	kind: "expect" | "opened";
	at: number;
	/** An `opened` route: the Herdr pane of the main, a second witness that it is still there when the broker's list misses it (RR3-F001). */
	pane?: string;
	/** An `opened` route: the ask id (of the message the run was answering) that the main's report answers with `inReplyTo`; until the run answers it. */
	ask?: string;
	/** An `opened` route: the level the run had when it opened the main. A main opened at `dispatch` is ended when the device loses it (revoke.ts); a row without a level counts as `dispatch`. */
	level?: string;
	/** An `opened` route: a stop the box accepted. It stays through renewals and rewrites of the row, and the row caps drop a row with one last. */
	stop?: Stop;
}
export interface Answer extends Peer {
	id: string;
	from: { id: string; name: string };
	text: string;
	at: number;
	/** The ask the route carried when the session answered: the run that reads this answers it with `inReplyTo`. */
	ask?: string;
}

/** An `opened` route lives as long as its main reports: `at` is renewed by each report it relays, and a main silent for this long is let go. */
const OPENED_KEEP_MS = 7 * KEEP_MS;
const read = <T extends object>(slot: Slot, workspace: string, file: string, now: number): T[] => {
	try {
		const found = JSON.parse(readFileSync(join(towerDir(slot, workspace), file), "utf8")) as { entries?: (T & { at: number })[] };
		return (Array.isArray(found.entries) ? found.entries : []).filter((e) => typeof e?.at === "number" && now - e.at <= ((e as { kind?: string }).kind === "opened" ? OPENED_KEEP_MS : KEEP_MS));
	} catch {
		return [];
	}
};
const write = (slot: Slot, workspace: string, file: string, entries: unknown[]) => {
	ensureDir(towerDir(slot, workspace));
	writeDurable(join(towerDir(slot, workspace), file), { entries });
};

export const readRoutes = (slot: Slot, workspace: string, now: number) => read<Route>(slot, workspace, ROUTES, now).filter((r) => typeof r.to === "string" && typeof r.device === "string");
/**
 * A route for `row.to` and its device replaces the earlier one, except that an `expect` never sits beside an `opened` route of the same session, whichever device it is for: the opened route already relays every message
 * of the main to its device, and another route would take the main's next report (RR-F001, RR2-F001). The cap trims `expect` routes. `opened` rows are bounded per device and in all, the oldest first and rows of mains
 * that are gone before live ones; with `live` (the ids of the sessions the broker lists), a row of a main that is not listed and has been silent past a short grace is dropped (RR2-F002). A row that keeps its `pane` is dead only when Herdr's `panes` no longer
 * show that pane either, and a read of the panes that failed (`panes` undefined) keeps it: one broker read that misses a working main must not cost it its route (RR3-F001).
 */
export function addRoute(slot: Slot, workspace: string, row: Route, now: number, live?: ReadonlySet<string>, panes?: ReadonlySet<string>): void {
	const was = readRoutes(slot, workspace, now);
	if (row.kind === "expect" && was.some((r) => r.to === row.to && r.kind === "opened")) return;
	// An opened row written again for the same main and device keeps the stop that was put on it.
	const before = was.find((r) => r.to === row.to && r.device === row.device && r.kind === "opened")?.stop;
	if (before && row.kind === "opened" && !row.stop) row = { ...row, stop: before };
	const rest = [...was.filter((r) => !(r.to === row.to && r.device === row.device)), row], dead = (r: Route) => live !== undefined && !live.has(r.to) && !(r.pane !== undefined && (panes === undefined || panes.has(r.pane)));
	// Rows without a stop go before rows with one, whatever their age (a stop is a request nobody has seen carried out); then dead rows first, then the oldest; the row being added is never the one to go.
	const order = (a: Route, b: Route) => Number(a.stop !== undefined) - Number(b.stop !== undefined) || Number(dead(b)) - Number(dead(a)) || a.at - b.at;
	const gone = new Set<Route>(rest.filter((r) => r.kind === "opened" && r !== row && dead(r) && now - r.at > DEAD_GRACE_MS));
	const trim = (rows: Route[], keep: number) => rows.filter((r) => r !== row).sort(order).slice(0, Math.max(0, rows.length - keep)).forEach((r) => gone.add(r));
	const kept = () => rest.filter((r) => r.kind === "opened" && !gone.has(r));
	for (const device of new Set(kept().map((r) => r.device))) trim(kept().filter((r) => r.device === device), MAX_OPENED_PER_DEVICE);
	trim(kept(), MAX_OPENED);
	write(slot, workspace, ROUTES, [...kept(), ...rest.filter((r) => r.kind !== "opened").slice(-MAX_ROUTES)]);
}
/** The route for a session, if an ally run waits on it or opened it: the `opened` route first, so another device's `expect` row never outranks it; else the newest. */
export const routeOf = (slot: Slot, workspace: string, session: string, now: number): Route | undefined => {
	const rows = readRoutes(slot, workspace, now).filter((r) => r.to === session);
	return rows.find((r) => r.kind === "opened") ?? rows.at(-1);
};
/**
 * Writes an accepted stop on the `opened` row of `session`; `name` (the main's own, read from the broker) replaces the row's name, which an ally run's open leaves generic. A row that already has a stop is left as it is and its stop answered
 * (a second stop of a pending main is a no-op). Throws when no `opened` row names the session: the main was let go meanwhile.
 */
export function setStop(slot: Slot, workspace: string, session: string, stop: Stop, now: number, name?: string): { set: true } | { set: false; stop: Stop } {
	const rows = readRoutes(slot, workspace, now), at = rows.find((r) => r.to === session && r.kind === "opened");
	if (!at) throw new Error(`no opened route names the session ${session}`);
	if (at.stop) return { set: false, stop: at.stop };
	write(slot, workspace, ROUTES, rows.map((r) => (r === at ? { ...r, stop, ...(name ? { name } : {}) } : r)));
	return { set: true };
}
/** A main closed: its `opened` row goes with it. */
export function dropOpened(slot: Slot, workspace: string, session: string, now: number): void {
	const rows = readRoutes(slot, workspace, now);
	if (rows.some((r) => r.to === session && r.kind === "opened")) write(slot, workspace, ROUTES, rows.filter((r) => !(r.to === session && r.kind === "opened")));
}
/** The device a session was opened for, while an `opened` route of it lives. */
export const openedFor = (slot: Slot, workspace: string, session: string, now: number): string | undefined => readRoutes(slot, workspace, now).find((r) => r.to === session && r.kind === "opened")?.device;
/** The run answered the ask: no later report of an opened main carries it, and an answer that waits for a run no longer names it. */
export function dropAsk(slot: Slot, workspace: string, device: string, ask: string, now: number): void {
	const routes = readRoutes(slot, workspace, now);
	if (routes.some((r) => r.device === device && r.ask === ask)) write(slot, workspace, ROUTES, routes.map((r) => (r.device === device && r.ask === ask ? (({ ask: _, ...rest }) => rest)(r) : r)));
	const answers = readAnswers(slot, workspace, now);
	if (answers.some((a) => a.device === device && a.ask === ask)) write(slot, workspace, ANSWERS, answers.map((a) => (a.device === device && a.ask === ask ? (({ ask: _, ...rest }) => rest)(a) : a)));
}
/** An answer spends an `expect` route; an `opened` one stays for the main's next report, and its age starts again. */
export function spendRoute(slot: Slot, workspace: string, route: Route, now: number): void {
	const routes = readRoutes(slot, workspace, now), same = (r: Route) => r.to === route.to && r.device === route.device && r.at === route.at;
	if (route.kind === "expect") write(slot, workspace, ROUTES, routes.filter((r) => !same(r)));
	else write(slot, workspace, ROUTES, routes.map((r) => (same(r) ? { ...r, at: now } : r)));
}
/** The asks each ally run answered, kept out of the routes it opens afterwards; an entry is forgotten after the ask lifetime (KEEP_MS). */
export function answeredAsks(now: () => number) {
	const runs = new Map<string, { at: number; asks: Set<string> }>();
	const prune = () => { for (const [id, e] of runs) if (now() - e.at > KEEP_MS) runs.delete(id); };
	return {
		add(run: string, ask: string): void { prune(); const e = runs.get(run) ?? { at: now(), asks: new Set<string>() }; e.asks.add(ask); e.at = now(); runs.set(run, e); },
		has(run: string, ask: string): boolean { prune(); return runs.get(run)?.asks.has(ask) === true; },
		size: () => runs.size,
	};
}

/** The ask an opened main's route takes: the run's one unanswered ask, if it has exactly one. The route holds it from then on, so it counts as answered by the run and the run's end sends no receipt for it. */
export function routedAsk(answered: ReturnType<typeof answeredAsks>, run: string, asks: readonly string[]): string | undefined {
	const open = asks.filter((a) => !answered.has(run, a)), ask = open.length === 1 ? open[0] : undefined;
	if (ask) answered.add(run, ask);
	return ask;
}

export const readAnswers = (slot: Slot, workspace: string, now: number) => read<Answer>(slot, workspace, ANSWERS, now).filter((a) => typeof a.id === "string" && typeof a.text === "string" && typeof a.device === "string");
export function addAnswer(slot: Slot, workspace: string, row: Answer, now: number): void {
	write(slot, workspace, ANSWERS, [...readAnswers(slot, workspace, now), { ...row, text: row.text.slice(0, MAX_TEXT) }].slice(-MAX_ANSWERS));
}
export function removeAnswer(slot: Slot, workspace: string, id: string, now: number): void {
	const was = readAnswers(slot, workspace, now);
	if (was.some((a) => a.id === id)) write(slot, workspace, ANSWERS, was.filter((a) => a.id !== id));
}
