import { createHash } from "node:crypto";
import type { DeviceUnits } from "../link/holder.ts";
import { restrictLabel } from "../link/text.ts";
import { allyLabel } from "../boardauto.ts";
import { isOpen, type LinkWait } from "./linkwaits.ts";

// The `link:` keys of `watch-read` (docs/specs/2026-11-21-box-mac-waits.md §5, item D): a teammate device as this computer's Link holder last heard it in `unit-status`, read without a call to the device. `link:<short>` is the device (its
// unit rows and the mains it shows this computer), `link:<short>/<unit>` one tower unit of it, `link:<short>/main/<handle>` one of its mains. Its texts are the device's, cut and cleaned as a card cleans them. The waits on a key are the wait
// router's ledger (linkwaits.ts): for a device every open wait with it, for a main the waits that main raised; for a main of this computer (`waitsOf`) the waits it raised or claimed.

/** A status older than this is offline, the page's own stale rule (holder.ts `UNITS_FRESH_MS`). */
export const OFFLINE_MS = 3 * 60_000;
/** The states that read as idle: a tower unit standing by, a main Herdr reads idle or done. */
const IDLE = new Set(["standing", "standing by", "idle", "done"]);
export interface LinkWatchDeps {
	units(): (DeviceUnits & { label: string })[];
	/** Every wait of the router's ledgers, open or closed. */
	waits(): LinkWait[];
}
export interface LinkKey { short: string; unit?: string; handle?: string }
/** One reading of a `link:` key: the facts that wake a hold (`changed`), the waits (`waiting`), whether it reads idle, the status time when it is stale (`offline`), and the view a reply shows. */
export interface LinkReading { facts: string; waits: string; idle: boolean; offlineAt?: number; view: Record<string, unknown> }

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const line = (text: string, max = 200) => allyLabel(text.split("\n")[0] ?? "", max);
const waitView = (w: LinkWait) => ({ id: `L${w.n}`, dir: w.dir, what: line(w.what), state: w.state });
const waitFacts = (list: LinkWait[]) => (list.length === 0 ? "" : hash(list.map((w) => [w.n, w.state, w.claimedBy?.id ?? null])));

/** The parts of a `link:` key; none for a key of this computer's net. */
export function parseLinkKey(key: string): LinkKey | undefined {
	const m = /^link:([a-z2-7]{4,26})(?:\/(.+))?$/.exec(key);
	if (!m) return undefined;
	const rest = m[2];
	if (rest === undefined) return { short: m[1]! };
	const main = /^main\/([0-9a-f]{16})$/.exec(rest);
	return main ? { short: m[1]!, handle: main[1]! } : rest.startsWith("main/") ? undefined : { short: m[1]!, unit: rest };
}

/** The reading of a `link:` key; none while the device, the unit, or the main is not in the latest status (a device unheard for 30 minutes is gone). */
export function readLinkKey(k: LinkKey, d: LinkWatchDeps, now: number): LinkReading | undefined {
	const seen = d.units().filter((u) => u.device.startsWith(k.short));
	if (seen.length !== 1) return undefined;
	const u = seen[0]!, waits = d.waits().filter((w) => w.device === u.device && isOpen(w));
	const mains = (u.mains ?? []).map((m) => ({ handle: m.handle, unit: m.unit, name: restrictLabel(m.name), state: m.state, ...(m.kind ? { kind: m.kind } : {}) }));
	const offlineAt = now - u.at > OFFLINE_MS ? u.at : undefined, base = { device: restrictLabel(u.label), short: u.device.slice(0, 6), ageMs: Math.max(0, now - u.at) };
	if (k.handle) {
		const main = mains.find((m) => m.handle === k.handle);
		if (!main) return undefined;
		const mine = waits.filter((w) => w.handle === k.handle);
		return { facts: hash([main.state, main.kind ?? null]), waits: waitFacts(mine), idle: IDLE.has(main.state), ...(offlineAt !== undefined ? { offlineAt } : {}), view: { ...base, state: main.state, name: main.name, ...(main.kind ? { kind: main.kind } : {}), unit: line(main.unit, 80), waits: mine.map(waitView) } };
	}
	const rows = k.unit === undefined ? u.units : u.units.filter((x) => x.unit === k.unit);
	if (!rows.length && k.unit !== undefined) return undefined;
	const ours = k.unit === undefined ? mains : mains.filter((m) => m.unit === k.unit), handles = new Set(ours.map((m) => m.handle));
	const mine = k.unit === undefined ? waits : waits.filter((w) => w.handle !== undefined && handles.has(w.handle));
	const unitRows = rows.map((r) => ({ unit: line(r.unit, 80), state: r.state, report: line(r.report), monitors: r.monitors.map((x) => line(x, 120)) }));
	const idle = rows.every((r) => IDLE.has(r.state)) && ours.every((m) => IDLE.has(m.state));
	const view = { ...base, ...(k.unit !== undefined ? unitRows[0]! : { units: unitRows }), mains: ours.map((m) => ({ name: m.name, state: m.state, ...(m.kind ? { kind: m.kind } : {}), handle: m.handle })), waits: mine.map(waitView) };
	return { facts: hash([rows.map((r) => [r.unit, r.state, r.monitors, line(r.report)]), ours.map((m) => [m.handle, m.state, m.kind ?? null])]), waits: waitFacts(mine), idle, ...(offlineAt !== undefined ? { offlineAt } : {}), view };
}

/** The open link waits a main of this computer raised or claimed, as a hash and a view (none for a session that has none). */
export function waitsOf(sessionId: string, all: LinkWait[]): { facts: string; view: ReturnType<typeof waitView>[] } {
	const mine = all.filter((w) => isOpen(w) && (w.raiser?.id === sessionId || w.claimedBy?.id === sessionId));
	return { facts: waitFacts(mine), view: mine.map(waitView) };
}
