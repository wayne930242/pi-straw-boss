import type { Mark } from "../src/dashboard.ts";
import type { Pending } from "../src/ask.ts";
import type { Net, Unit } from "../src/net.ts";

// Spots the units that need the user in each snapshot of the net. It is all the alert code the map's chunk carries: the queue, the
// dialogs, and the HUD alert load with the overlay layer (overlay.ts, layer.ts) once the first alert arrives.

export interface Alert { key: string; ws: string; name: string; role: string; mark: Mark; note?: string; at: number; pending?: Pending }
/** Questions and errors outrank plain state changes. */
export const rankOf = (m: Mark) => (m === "waiting" || m === "error" ? 0 : 1);

/** Every unit of a net that can raise an alert (agents, subagents, towers, and the units outside the net), by key. */
export function alertsOf(net: Net, at: number): Map<string, Alert> {
	const out = new Map<string, Alert>();
	for (const b of net.bases) {
		// `pending` is always set, so a refreshed alert drops a question that is gone.
		for (const x of [...(b.tower ? [{ ...b.tower, role: "tower" }] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs])] as Partial<Unit>[]) out.set(x.key!, { key: x.key!, ws: b.id, name: x.name!, role: x.role!, mark: x.mark!, note: x.note, at, pending: x.pending });
	}
	return out;
}
/** The alerts a new snapshot raises: a unit that turned to waiting or error, and (after the first snapshot) one that finished. */
export function arrivals(before: Map<string, Alert> | undefined, now: Map<string, Alert>): Alert[] {
	return [...now.values()].filter((a) => before?.get(a.key)?.mark !== a.mark && (rankOf(a.mark) === 0 || (before !== undefined && a.mark === "done")));
}
