import type { Mark } from "../src/dashboard.ts";
import type { Net } from "../src/net.ts";

// Spots the units that need the user in each snapshot of the net. It is all the alert code the map's chunk carries: the queue, the
// dialogs, and the HUD alert load with the overlay layer (overlay.ts, layer.ts) once the first alert arrives.

export interface Alert { key: string; ws: string; name: string; role: string; mark: Mark; note?: string; at: number }
/** Questions and errors outrank plain state changes. */
export const rankOf = (m: Mark) => (m === "waiting" || m === "error" ? 0 : 1);

/** Every unit of a net that can raise an alert (agents, subagents, towers, and the units outside the net), by key. */
export function alertsOf(net: Net, at: number): Map<string, Alert> {
	const out = new Map<string, Alert>();
	for (const b of net.bases) {
		const put = (key: string, name: string, role: string, mark: Mark, note?: string) => out.set(key, { key, ws: b.id, name, role, mark, note, at });
		if (b.tower) put(b.tower.key, b.tower.name, "tower", b.tower.mark);
		for (const u of [...b.tabs.flatMap((t) => t.units), ...b.outside]) for (const x of [u, ...u.subs]) put(x.key, x.name, x.role, x.mark, x.note);
	}
	return out;
}
/** The alerts a new snapshot raises: a unit that turned to waiting or error, and (after the first snapshot) one that finished. */
export function arrivals(before: Map<string, Alert> | undefined, now: Map<string, Alert>): Alert[] {
	return [...now.values()].filter((a) => before?.get(a.key)?.mark !== a.mark && (rankOf(a.mark) === 0 || (before !== undefined && a.mark === "done")));
}
