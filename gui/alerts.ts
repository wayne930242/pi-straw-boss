import type { Mark } from "../src/netdata.ts";
import type { Pending } from "../src/ask.ts";
import type { Net, Unit } from "../src/net.ts";
import type { TrustAsk } from "../src/trust/types.ts";

// Spots the units that need the user in each snapshot of the net. It is all the alert code the map's chunk carries: the queue, the
// dialogs, and the HUD alert load with the overlay layer (overlay.ts, layer.ts) once the first alert arrives.

/**
 * `closed`: the unit's pane is gone, or it is a subagent whose run pi-herdr-agents recorded done (its parent has the result; a finished
 * subagent stays on the map ten minutes); its finished alert clears itself.
 */
/**
 * `unit`: the unit an alert of one of its monitors belongs to (its key is the monitor's own); its comms, terminal, and chat are the unit's.
 * `trust`: a project trust question (src/trust/): the folder's agents wait on it, and its key is the folder and the digest of what was asked.
 */
export interface Alert { key: string; unit?: string; ws: string; name: string; role: string; mark: Mark; note?: string; at: number; pending?: Pending; gone?: boolean; closed?: boolean; trust?: TrustAsk }
/** The openings this page runs (deploy.ts): their trust question shows inline in the deploy panel, and is no alert here. */
export const ownOpenings = new Set<string>();
/** The unit an alert is about. */
export const unitOf = (a: Alert) => a.unit ?? a.key;
/**
 * 0 for a unit that waits on the user (mark waiting, or a dialog pending): the only prominent alert, in the HUD and the dialogs. 1 for the
 * rest (an error, a monitor that failed, a unit that finished): notices, kept in the header's Notices list and never opened by themselves.
 */
export const rankOf = (a: Pick<Alert, "mark" | "pending">) => (a.mark === "waiting" || a.pending ? 0 : 1);

/** Every unit of a net that can raise an alert (agents, subagents, towers, and the units outside the net), by key, and each monitor of theirs that failed or went quiet. */
export function alertsOf(net: Net, at: number): Map<string, Alert> {
	const out = new Map<string, Alert>();
	for (const b of net.bases) {
		// `pending` is always set, so a refreshed alert drops a question that is gone.
		for (const x of [...(b.tower ? [{ ...b.tower, role: "tower" }, ...b.tower.subs] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs])] as Partial<Unit>[]) {
			out.set(x.key!, { key: x.key!, ws: b.id, name: x.name!, role: x.role!, mark: x.mark!, note: x.note, at, pending: x.pending, closed: !x.control || Boolean(x.ended) });
			// One alert per failed monitor, while its session lists it; a monitor that ran again under the same id is a new one (`at`).
			for (const mo of x.monitors ?? []) if (mo.status === "error" || mo.status === "stale") ((key) => out.set(key, { key, unit: x.key!, ws: b.id, name: x.name!, role: x.role!, mark: "error", note: `monitor:${mo.status}:${mo.what}`, at }))(`${x.key}\u001fmonitor:${mo.id}:${mo.at}`);
		}
	}
	for (const t of net.trust ?? []) if (!(t.opening && ownOpenings.has(t.opening))) ((key) => out.set(key, { key, ws: "", name: t.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? t.folder, role: t.agents[0]?.role ?? "none", mark: "waiting", at, trust: t }))(`trust\u001f${t.folder}\u001f${t.digest}`);
	return out;
}
/**
 * The alerts a new snapshot raises: a unit that started to wait on the user, and (after the first snapshot, so a page that opens on old
 * failures is not buzzed by them) one that failed or finished.
 */
export function arrivals(before: Map<string, Alert> | undefined, now: Map<string, Alert>): Alert[] {
	return [...now.values()].filter((a) => {
		const old = before?.get(a.key);
		return rankOf(a) === 0 ? !old || rankOf(old) !== 0 || old.mark !== a.mark : before !== undefined && old?.mark !== a.mark && (a.mark === "error" || a.mark === "done");
	});
}
