import type { Mark } from "./dashboard.ts";
import { type Todo, todosOf } from "./items.ts";
import type { Base, Net } from "./net.ts";

// What the net did lately, for the map's cards and the page's timeline. The server keeps it across its reads, so a page that reloads sees it too
// (a server that starts again begins afresh): when each unit took its present state (`since`; none for a unit first seen in it, whose start is
// unknown), its last steps (`ticks`: each change of its state or of what it is doing), and the net's events (joined, a new state, left) of the
// last 30 minutes. And a session's todo list in short (`TodoSum`), which its bridge reads from rpiv-todo's snapshots on its branch.

export interface Tick { at: number; mark: Mark }
/** `key`: the session, none for an outpost (a sub workspace). `kind`: it joined the net, took `mark`, or left it. */
export interface NetEvent { at: number; ws: string; key?: string; name: string; mark: Mark; kind: "joined" | "mark" | "left" }
/** Done of total, and the task in progress as rpiv-todo words it while it runs. */
export interface TodoSum { done: number; total: number; now?: string }
export const TICKS = 12, WINDOW_MS = 30 * 60_000, MAX_EVENTS = 80, TODO_TEXT = 120;

interface Seen { mark: Mark; note?: string; since?: number; ticks: Tick[]; ws: string; name: string; key?: string }
type Holder = { key?: string; id?: string; name?: string; label?: string; mark: Mark; note?: string; since?: number; ticks?: Tick[] };
const holders = (b: Base): Holder[] => [...(b.tower ? [b.tower, ...b.tower.subs] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs]), ...b.outposts];

/** A reader of the net that adds `since` and `ticks` to each unit, and the recent events to the net. */
export function trackActivity(now = Date.now) {
	const seen = new Map<string, Seen>();
	let events: NetEvent[] = [], first = true;
	return (net: Net): Net => {
		const at = now(), here = new Set<string>();
		for (const b of net.bases)
			for (const u of holders(b)) {
				const id = u.key ?? u.id!, name = u.name ?? u.label ?? id, key = u.key;
				here.add(id);
				let s = seen.get(id);
				if (!s) {
					seen.set(id, (s = { mark: u.mark, note: u.note, ticks: [], ws: b.id, name, key }));
					if (!first) (s.since = at), events.push({ at, ws: b.id, key, name, mark: u.mark, kind: "joined" }); // the first reading's units were there before it
				} else if (s.mark !== u.mark) (s.since = at), s.ticks.push({ at, mark: u.mark }), events.push({ at, ws: b.id, key, name, mark: u.mark, kind: "mark" });
				else if (s.note !== u.note && u.note) s.ticks.push({ at, mark: u.mark });
				[s.mark, s.note, s.name, s.ws] = [u.mark, u.note, name, b.id];
				s.ticks.splice(0, s.ticks.length - TICKS);
				if (s.since !== undefined) u.since = s.since;
				if (s.ticks.length) u.ticks = [...s.ticks];
			}
		for (const [id, s] of seen) if (!here.has(id)) (seen.delete(id), events.push({ at, ws: s.ws, key: s.key, name: s.name, mark: "idle", kind: "left" }));
		events = events.filter((e) => at - e.at <= WINDOW_MS).slice(-MAX_EVENTS);
		first = false;
		return events.length ? { ...net, events: [...events] } : net;
	};
}

/** The todo list in short from a branch's entries, oldest first: rpiv-todo's state entries win over its tool results (rpiv-todo's own replay rule). */
export function todoOfBranch(entries: Iterable<unknown>): TodoSum | undefined {
	let fromEntries: Todo[] | undefined, fromResults: Todo[] | undefined;
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type === "custom" && e.customType === "rpiv-todo-state") fromEntries = todosOf(e.data) ?? fromEntries;
		else if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo") fromResults = todosOf(e.message.details) ?? fromResults;
	}
	const list = fromEntries ?? fromResults, doing = list?.find((t) => t.status === "in_progress");
	if (!list?.length) return undefined;
	const now = doing && (doing.activeForm || doing.subject).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, TODO_TEXT);
	return { done: list.filter((t) => t.status === "completed").length, total: list.length, ...(now && { now }) };
}

/** What the hub accepts from a bridge. */
export const todoOk = (v: unknown): v is TodoSum => {
	const t = v as Partial<TodoSum> | null;
	const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 200;
	return t !== null && typeof t === "object" && count(t.done) && count(t.total) && t.done! <= t.total! && t.total! > 0 && (t.now === undefined || (typeof t.now === "string" && t.now.length > 0 && t.now.length <= TODO_TEXT && !/[\p{Cc}\p{Cf}]/u.test(t.now)));
};
