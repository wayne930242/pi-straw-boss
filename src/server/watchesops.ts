import { join } from "node:path";
import type { LinkHolder } from "../link/holder.ts";
import { readWaits } from "./linkwaits.ts";
import type { Slot } from "./record.ts";
import { listServices } from "./towerstore.ts";
import type { Reply, Request } from "./socket.ts";
import { createWatchRead, type WatchNet, type WatchQuery, type WatchReadDeps } from "./watchread.ts";
import { createWatches, type Watches, type WatchesDeps } from "./watches.ts";
import { createWardRead, WARD, type WardDeps, type WardRead } from "./ward.ts";

// The server's side of `boss_watch` (docs/specs/2026-11-23-lite-b2-d-e-f.md §3.3): the control-socket commands `watch-add`, `watch-stop` and `watch-list` (watches.ts), their requests checked, and the watch-read holds they run on
// (watchread.ts). Kept out of main.ts, which carries a line budget. `watch-read` is still answered for one release (0.83.0), for a watchdog child of an older build; `watch-report` is retired.

export const REPORT_RETIRED = "watch-report is retired in pi-straw-boss 0.83.0 with the watchdog: the main watches with boss_watch, and the sb server wakes it";
/** `main`: the live main a session id is in the server's own reading of the net, with its workspace and pane, or why it is none (ward-review F003); `ready`: whether that main's control channel answers its workspace's tower identity now (F002). */
export interface WardRoutes extends Pick<WardRead, "resolve"> { main(session: string): { workspace: string; pane?: string } | string; ready(workspace: string, session: string): Promise<boolean> }
export interface WatchRoutes { read: { read(q: WatchQuery): Promise<Reply> }; watches: Pick<Watches, "add" | "stop" | "list" | "has">; ward?: WardRoutes }
const no = (error: string): Promise<Reply> => Promise.resolve({ ok: false, error });
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** The watch commands. Undefined for a command that is not one of them; `enabled` is whether tower runs are on, whose tower identity sends the lines. */
export function watchReply(routes: WatchRoutes | undefined, request: Request, enabled: () => boolean): Promise<Reply> | undefined {
	if (!["watch-read", "watch-report", "watch-add", "watch-stop", "watch-list", "ward-add"].includes(request.cmd)) return undefined;
	if (request.cmd === "watch-report") return no(REPORT_RETIRED);
	if (!routes) return no("the server is still starting");
	if (request.cmd === "watch-read") {
		const { key, since, deadline, quietMs, loadMax, idleMs } = request;
		if (typeof key !== "string" || key.length < 1 || key.length > 200) return no("key is 1 to 200 characters");
		if (deadline !== undefined && !(number(deadline) && deadline > 0)) return no("deadline is a time in epoch ms");
		if (quietMs !== undefined && !(number(quietMs) && quietMs >= 60_000)) return no("quietMs is at least 60000");
		if (loadMax !== undefined && !(number(loadMax) && loadMax > 0)) return no("loadMax is a number over 0");
		if (idleMs !== undefined && !(number(idleMs) && idleMs >= 60_000)) return no("idleMs is at least 60000");
		return routes.read.read({ key, ...(typeof since === "string" ? { since } : {}), ...(deadline !== undefined ? { deadline } : {}), ...(quietMs !== undefined ? { quietMs } : {}), ...(loadMax !== undefined ? { loadMax } : {}), ...(idleMs !== undefined ? { idleMs } : {}) });
	}
	const session = text(request.session, 128);
	if (!session) return no(`${request.cmd} needs session`);
	// A ward's paths and its stop are the main's alone: the session must be a live main of the server's own reading (ward-review F003).
	const mainOf = () => (routes.ward ? routes.ward.main(session) : "this server keeps no wards");
	if (request.cmd === "watch-list") {
		const list = routes.watches.list(session), hide = (list.watches as { ward?: { pane: string } }[]).some((r) => r.ward) && typeof mainOf() === "string";
		return Promise.resolve(hide ? { ...list, watches: (list.watches as { ward?: { pane: string } }[]).map((r) => (r.ward ? { ...r, ward: { pane: r.ward.pane } } : r)) } : list);
	}
	const key = text(request.key, 200);
	if (!key) return no("key is 1 to 200 characters");
	if (request.cmd === "watch-stop") return ((m) => (key.startsWith(WARD) && typeof m === "string" ? no(m) : Promise.resolve(routes.watches.stop(session, key))))(key.startsWith(WARD) ? mainOf() : undefined);
	if (!enabled()) return no("tower runs are off on this computer (towerRuns.enabled is false): boss_watch needs the workspace's tower identity of the sb server, which sends the wakes");
	const ms = (v: unknown) => (number(v) ? v : undefined), [quietMs, idleMs, untilMs] = [ms(request.quietMs), ms(request.idleMs), ms(request.untilMs)];
	// A ward (`sb_ward`, `cli.mjs ward`) has a command of its own, which a server of an older build refuses instead of keeping it as a plain watch (ward-review F005).
	if (request.cmd === "ward-add") return wardAdd(routes, session, key, request, untilMs);
	if (key.startsWith(WARD)) return no("a ward is set with sb_ward or cli.mjs ward");
	const workspace = text(request.workspace, 200);
	if (!workspace) return no("watch-add needs workspace");
	return routes.watches.add({ session, workspace, key, ...(quietMs !== undefined ? { quietMs } : {}), ...(idleMs !== undefined ? { idleMs } : {}), ...(untilMs !== undefined ? { untilMs } : {}) });
}
/** A ward of a live main on a pane of its own workspace: the workspace and the main's pane are the server's reading, never the request's; from the shell (`cli`) the main's control channel must answer first, or the wake would reach nobody (F002). The pane is read now for its session file, which the ward keeps. */
async function wardAdd(routes: WatchRoutes, session: string, key: string, request: Request, untilMs: number | undefined): Promise<Reply> {
	if (!routes.ward) return { ok: false, error: "this server keeps no wards" };
	if (!key.startsWith(WARD)) return { ok: false, error: "ward-add takes ward:<pane>" };
	const w = (request.ward ?? {}) as { item?: unknown; names?: unknown; cli?: unknown };
	if ((w.item !== undefined && typeof w.item !== "string") || (w.names !== undefined && !(Array.isArray(w.names) && w.names.every((n) => typeof n === "string" && n.length <= 200)))) return { ok: false, error: "ward is { item?, names?, cli? }: item a string, names strings" };
	const ward = routes.ward, me = ward.main(session);
	if (typeof me === "string") return { ok: false, error: me };
	if (w.cli === true && !(await ward.ready(me.workspace, session).catch(() => false))) return { ok: false, error: "your session does not answer on the control channel, so the ward's wake would reach nobody: call sb_ward from the main instead (it listens first), or run this again after boss_watch or a /reload" };
	const rec = await ward.resolve({ pane: key.slice(WARD.length), session, workspace: me.workspace, ...(w.item !== undefined ? { item: w.item as string } : {}), ...(w.names ? { names: w.names as string[] } : {}), ...(me.pane ? { here: me.pane } : {}) });
	if (typeof rec === "string") return { ok: false, error: rec };
	const r = await routes.watches.add({ session, workspace: me.workspace, key, ...(untilMs !== undefined ? { untilMs } : {}), ward: rec });
	return r.ok ? { ...r, ward: { pane: rec.pane, file: rec.file, ...(rec.item ? { item: rec.item } : {}) } } : r;
}

export interface StartWatches {
	net: WatchNet;
	now(): number;
	/** The line to a session, as its workspace's tower identity (towers.ts `watchSend`). */
	send: WatchesDeps["send"];
	log(event: string, facts: Record<string, number | string | boolean>): void;
	stops: (() => void)[];
	/** `watches.json` goes in this server's own folder; the `link:` keys and `waiting` read the waits' ledgers of its state folder and the Link holder (linkwatch.ts). */
	slot: Slot;
	holder?(): Pick<LinkHolder, "unitsSeen" | "boards"> | undefined;
	/** What a ward reads besides the session file (ward.ts), and whether a main's control channel answers its workspace's tower identity (towers.ts `watchSend` with `watch-ping`); none keeps no wards. */
	ward?: Omit<WardDeps, "now"> & Pick<WardRoutes, "ready">;
	/** The seams of a test: the hold's length, the read interval, the timer. */
	over?: Partial<Pick<WatchReadDeps, "holdMs" | "readMs" | "timer">>;
}
/** The watch routes of this server: the holds on the GUI host's readings, and the watches over them, which come back from `watches.json`. Both stop with the server. */
export function startWatches(o: StartWatches): WatchRoutes {
	const slot = o.slot, link = { units: () => o.holder?.()?.unitsSeen() ?? [], waits: () => listServices(slot).flatMap((r) => readWaits(slot, r.workspace).entries), boards: (device: string) => ((r) => (r?.ok ? r.boards : []))(o.holder?.()?.boards({ device })) };
	const read = createWatchRead({ net: o.net, now: o.now, link, ...o.over });
	const timer = o.over?.timer ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
	const owner = (session: string) => ((f) => (f ? { live: f.live, workspace: f.base } : undefined))(o.net.lookup(session));
	const ward = o.ward ? createWardRead({ ...o.ward, now: o.now }) : undefined;
	// The trusted identity of a ward's main is the server's reading of the net: the session's pane carries `sb_role=main` (the net's role), and the unit is live; its workspace is the unit's base.
	const mainOf = (session: string): { workspace: string; pane?: string } | string => ((f) => (!f || !f.live ? "your session is not a live unit of the net the server reads (a ward is a main's; join the net, or wait for the next reading)" : f.role !== "main" ? `only a tab's main wards a worker; your session is a ${f.role}` : { workspace: f.base, ...(f.pane ? { pane: f.pane } : {}) }))(o.net.lookup(session));
	const watches = createWatches({ read: (q) => (q.ward && ward ? ward.read({ ...q, ward: q.ward }) : read.read(q)), now: o.now, timer, send: o.send, owner, file: join(slot.dir, "watches.json"), log: o.log });
	watches.start();
	o.stops.push(() => (watches.stopAll(), read.stop()));
	return { read, watches, ...(ward && o.ward ? { ward: { resolve: ward.resolve, main: mainOf, ready: o.ward.ready } } : {}) };
}
