import type { Mark } from "./dashboard.ts";
import type { Base, Net } from "./net.ts";

// What the net did lately, for the map's cards and the page's timeline. The server keeps it across its reads, so a page that reloads sees it too
// (a server that starts again begins afresh): when each unit took its present state (`since`; none for a unit first seen in it, whose start is
// unknown), its last steps (`ticks`: each change of its state or of what it is doing), and the net's events (joined, a new state, left) of the
// last 30 minutes. The server reads the net only while a page watches it, so a reading long after the last one is a fresh start, as the first is:
// what changed in between changed at a time it does not know. It imports nothing at run time, so the demo page runs it too.

export interface Tick { at: number; mark: Mark }
/** `key`: the session, none for an outpost (a sub workspace). `kind`: it joined the net, took `mark`, or left it. */
export interface NetEvent { at: number; ws: string; key?: string; name: string; mark: Mark; kind: "joined" | "mark" | "left" }
export const TICKS = 12, WINDOW_MS = 30 * 60_000, MAX_EVENTS = 80, GAP_MS = 60_000;

interface Seen { mark: Mark; note?: string; since?: number; ticks: Tick[]; ws: string; name: string; key?: string }
type Holder = { key?: string; id?: string; name?: string; label?: string; mark: Mark; note?: string; since?: number; ticks?: Tick[] };
const holders = (b: Base): Holder[] => [...(b.tower ? [b.tower, ...b.tower.subs] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs]), ...b.outposts];

/** A reader of the net that adds `since` and `ticks` to each unit, and the recent events to the net. */
export function trackActivity(now = Date.now) {
	const seen = new Map<string, Seen>();
	let events: NetEvent[] = [], last = -Infinity;
	return (net: Net): Net => {
		const at = now(), here = new Set<string>(), fresh = at - last > GAP_MS; // the first reading's units were there before it
		for (const b of net.bases)
			for (const u of holders(b)) {
				const id = u.key ?? u.id!, name = u.name ?? u.label ?? id, key = u.key;
				if (here.has(id)) continue; // a key twice in one reading is told once
				here.add(id);
				let s = seen.get(id);
				if (!s) {
					seen.set(id, (s = { mark: u.mark, note: u.note, ticks: [], ws: b.id, name, key }));
					if (!fresh) (s.since = at), events.push({ at, ws: b.id, key, name, mark: u.mark, kind: "joined" });
				} else if (s.mark !== u.mark && fresh) delete s.since;
				else if (s.mark !== u.mark) (s.since = at), s.ticks.push({ at, mark: u.mark }), events.push({ at, ws: b.id, key, name, mark: u.mark, kind: "mark" });
				else if (s.note !== u.note && u.note) s.ticks.push({ at, mark: u.mark });
				[s.mark, s.note, s.name, s.ws] = [u.mark, u.note, name, b.id];
				s.ticks.splice(0, s.ticks.length - TICKS);
				if (s.since !== undefined) u.since = s.since;
				if (s.ticks.length) u.ticks = [...s.ticks];
			}
		for (const [id, s] of seen) if (!here.has(id)) (seen.delete(id), fresh || events.push({ at, ws: s.ws, key: s.key, name: s.name, mark: "idle", kind: "left" }));
		events = events.filter((e) => at - e.at <= WINDOW_MS).slice(-MAX_EVENTS);
		last = at;
		return events.length ? { ...net, events: [...events] } : net;
	};
}
